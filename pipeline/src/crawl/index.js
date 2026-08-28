// S1 웹 크롤러 — BFS·도메인 경계·Jina 변환·멱등 스킵 (TECH-SPEC §1.5·§2.4).
//
// 설계 요지(정본 §1.5):
//   - 링크 발견은 **Jina 응답 마크다운 파싱**으로만 한다. 원본 HTML을 따로 받지 않는다 —
//     페이지당 요청이 1회로 유지되어 무료 키 한도와 크롤링 예절 표면이 절반이 된다.
//   - 경계는 등록 도메인(eTLD+1). 상한은 **시도한 페이지 수** 기준(시작 페이지 포함).
//   - robots.txt는 1회 받아 배치 동안 캐시. 불허 경로는 **시도 수에 세지 않고** 건너뜀 보고.
//   - 멱등 스킵 2단: ① 요청 전 정규화 키로 스킵 ② 수신 후 최종 URL 키로 중복 문서 감지.

import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import robotsParser from 'robots-parser';
import { parse as parseDomain } from 'tldts';
import matter from 'gray-matter';

import { dataPaths, ensureDataDirs } from '@bibliomind/shared/paths';
import { sanitizeWindowsName, buildStem } from '@bibliomind/shared/naming';
import { normalizeUrl } from '@bibliomind/shared/urlNormalize';
import { sha16 } from '@bibliomind/shared/normalize';
import { atomicWriteFile } from '@bibliomind/shared/atomicWrite';
import { isoKst } from '@bibliomind/shared/datetime';
import {
  loadLedger, saveLedger, getEntry, upsertEntry,
  shouldSkip, findByFinalHash, webKey, STATUS,
} from '../ledger.js';

/** Jina 호출 간 최소 간격(§1.5). robots.txt의 Crawl-delay가 더 크면 그 값을 따른다. */
export const CRAWL_DELAY_MS = 1000;
/** 기본 상한 — PRD 문언(시작 페이지 포함, 시도 기준). */
export const MAX_PAGES_DEFAULT = 10;
const JINA_BASE = 'https://r.jina.ai/';
const FETCH_TIMEOUT_MS = 45000;

/**
 * Jina Reader 응답을 파싱한다 — **2026-08-22 실측 형식**:
 * "Title: …" / 빈 줄 / "URL Source: …" / 빈 줄 / "Markdown Content:" / 본문.
 * 헤더가 없으면 전체를 본문으로 보고 title·finalUrl은 null(호출부가 폴백).
 * @param {string} text
 * @returns {{ title: string | null, finalUrl: string | null, markdown: string }}
 */
export function parseJinaResponse(text) {
  const src = String(text ?? '');
  const title = /^Title:[ \t]*(.*)$/m.exec(src)?.[1]?.trim() || null;
  const finalUrl = /^URL Source:[ \t]*(\S+)[ \t]*$/m.exec(src)?.[1]?.trim() || null;
  const marker = src.indexOf('Markdown Content:');
  const markdown = marker > -1
    ? src.slice(marker + 'Markdown Content:'.length).replace(/^\r?\n/, '')
    : src;
  return { title, finalUrl, markdown };
}

/**
 * 마크다운에서 링크를 뽑아 절대 URL로 만든다. 이미지는 문서가 아니므로 제외한다.
 * @param {string} markdown
 * @param {string} baseUrl 상대 경로 해석 기준
 * @returns {string[]} http(s) 절대 URL (중복 제거, 등장 순서 유지)
 */
export function extractLinks(markdown, baseUrl) {
  const out = [];
  const seen = new Set();
  // **이미지를 먼저 통째로 제거한다.** 링크가 이미지를 감싼 `[![alt](img)](href)` 형태에서,
  // 하나의 정규식으로 훑으면 바깥 `[`부터 안쪽 `](img)`까지가 먼저 걸려 **이미지 URL을 링크로
  // 오인**한다(2026-08-22 실측: readians.com 로고가 정확히 그 형태였다).
  // 제거하면 `[](href)`가 남아 의도한 링크만 잡힌다.
  const text = String(markdown ?? '').replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  const re = /\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let abs;
    try {
      abs = new URL(m[1], baseUrl);
    } catch {
      continue; // 상대 해석 불가 — 링크가 아니다
    }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue;
    if (seen.has(abs.href)) continue;
    seen.add(abs.href);
    out.push(abs.href);
  }
  return out;
}

/**
 * robots 불허 판정 — **경로 끝 슬래시 변형까지 함께 본다**.
 *
 * 2026-08-22 실측 사고: `normalizeUrl`이 경로 끝 `/`를 제거하므로(§2.4.4 정규화 규칙)
 * `https://site/api/` 가 큐에는 `https://site/api` 로 들어간다. robots의 `Disallow: /api/`
 * 규칙은 `/api` 에 매칭되지 않아 **정규화가 차단 규칙을 우회**했고, 실제로 사이트가 막은
 * 경로에 요청을 보냈다. 정규화는 멱등 키를 위해 필요하므로 되돌리지 않고, **판정 쪽에서
 * 두 형태를 모두 검사**한다(하나라도 불허면 차단 — 보수적으로).
 * @param {object | null} robots robots-parser 인스턴스
 * @param {string} url 정규화된 URL
 * @param {string} userAgent
 * @returns {boolean}
 */
export function robotsDisallows(robots, url, userAgent = 'BiblioMind') {
  if (!robots) return false;
  const variants = [url];
  try {
    const u = new URL(url);
    if (u.pathname !== '/' && !u.pathname.endsWith('/')) {
      u.pathname = `${u.pathname}/`;
      variants.push(u.href);
    }
  } catch {
    /* 파싱 불가 URL은 원형만 검사한다 */
  }
  return variants.some((v) => robots.isDisallowed(v, userAgent) === true);
}

/**
 * 등록 도메인(eTLD+1)과 파일명에 쓸 대표 이름.
 * @param {string} url
 * @returns {{ registrable: string | null, mainName: string }}
 */
export function domainOf(url) {
  const info = parseDomain(url);
  const registrable = info.domain ?? null;
  // 대표 이름 = eTLD+1의 첫 라벨 (readians.com → readians)
  const label = registrable ? registrable.split('.')[0] : (info.hostname ?? 'site');
  return { registrable, mainName: sanitizeWindowsName(label) };
}

/** yyyymmddhhmmss (로컬 시각 — 배치 시작 시 1회 고정). */
function batchStamp(now) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
    + `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/**
 * 기본 Jina 호출 — 네트워크를 때리는 테스트는 만들지 않으므로(§1.13) 주입 교체 가능하게 분리한다.
 * @param {string} url
 * @param {{ apiKey?: string | null }} options
 * @returns {Promise<{ ok: boolean, status: number, text: string }>}
 */
async function fetchViaJina(url, { apiKey = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(JINA_BASE + url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/** 기본 robots.txt 수신. */
async function fetchRobotsDefault(url) {
  const res = await fetch(url);
  return { ok: res.ok, status: res.status, text: await res.text() };
}

/**
 * S1 웹 수집 — BFS로 등록 도메인 안을 훑어 Input/*.md 를 만든다.
 * @param {object} options
 * @param {string} options.url 시작 URL
 * @param {number} [options.maxPages] 시도 상한(기본 10)
 * @param {boolean} [options.force] 기수집분도 다시 받아 **기존 파일명에 덮어쓴다**(§2.4.4)
 * @param {Function} [options.fetchPage] 주입용
 * @param {Function} [options.fetchRobots] 주입용
 * @param {Date} [options.now] 주입용(배치 타임스탬프 고정)
 * @param {Function} [options.wait] 주입용(테스트에서 실제로 기다리지 않기 위함)
 * @returns {Promise<object>} 결과 요약
 */
export async function collectWeb(options) {
  const {
    url: startUrl,
    maxPages = MAX_PAGES_DEFAULT,
    force = false,
    fetchPage = fetchViaJina,
    fetchRobots = fetchRobotsDefault,
    now = new Date(),
    wait = sleep,
  } = options ?? {};

  if (typeof startUrl !== 'string' || startUrl.trim() === '') {
    throw new Error('url이 필요합니다 (예: https://example.com/).');
  }
  const { registrable, mainName } = domainOf(startUrl);
  if (!registrable) throw new Error(`등록 도메인을 판정할 수 없는 URL입니다: ${startUrl}`);

  ensureDataDirs();
  const paths = dataPaths();
  const ledger = await loadLedger();
  const batch = batchStamp(now);
  const stampedAt = isoKst(now);
  const apiKey = process.env.JINA_API_KEY || null;

  // ── robots.txt 1회 수신 → 배치 동안 캐시 ──
  const origin = new URL(startUrl).origin;
  let robots = null;
  let robotsNote = null;
  try {
    const r = await fetchRobots(`${origin}/robots.txt`);
    if (r.ok) robots = robotsParser(`${origin}/robots.txt`, r.text);
    else robotsNote = `robots.txt 응답 ${r.status} — 차단 규칙 없음으로 간주하고 진행`;
  } catch (err) {
    robotsNote = `robots.txt를 받지 못했습니다(${err.message}) — 차단 규칙 없음으로 간주하고 진행`;
  }
  const declaredDelay = Number(robots?.getCrawlDelay?.('*') ?? 0) * 1000;
  const crawlDelay = Math.max(CRAWL_DELAY_MS, Number.isFinite(declaredDelay) ? declaredDelay : 0);

  const queue = [normalizeUrl(startUrl)];
  const queued = new Set(queue);
  const summary = {
    startUrl, registrable, batch, maxPages, crawlDelay,
    attempted: 0, collected: 0, skipped: 0, failed: 0, robotsBlocked: 0, duplicated: 0,
    pages: [], failures: [], missingFiles: [], robotsNote,
    jinaKey: apiKey ? 'header' : 'none',
  };
  let pageNo = nextPageNumber(ledger, batch);
  let first = true;

  while (queue.length > 0 && summary.attempted < maxPages) {
    const current = queue.shift();

    // robots 불허 — **시도 수에 세지 않는다**(§1.5)
    if (robotsDisallows(robots, current)) {
      summary.robotsBlocked += 1;
      summary.pages.push({ url: current, result: 'robots-blocked' });
      continue;
    }

    // ── 1차 스킵: 요청을 보내기 **전에** 판정 ──
    const { key, normalized } = webKey(current);
    const existing = getEntry(ledger, key);
    const verdict = shouldSkip(existing, { force });
    if (verdict.skip) {
      summary.skipped += 1;
      summary.pages.push({ url: normalized, result: `skipped:${verdict.reason}`, file: existing?.file ?? null });
      // **스킵된 페이지의 링크 되살리기**(§1.5 v2.5) — 요청은 여전히 보내지 않는다.
      // 저장된 MD에서 링크를 다시 뽑아 BFS를 잇는다. 이게 없으면 재실행이 시작 페이지에서
      // 끝나 상한에 걸려 남은 URL을 영영 이어받지 못한다(--force 전체 재수집만 남는다).
      if (verdict.reason === 'collected' && existing?.file) {
        const revived = await linksFromStoredMd(paths.input, existing.file);
        if (revived === null) {
          summary.missingFiles.push(existing.file);
        } else {
          for (const link of revived) enqueue(queue, queued, link, registrable);
        }
      }
      continue;
    }

    if (!first) await wait(crawlDelay);
    first = false;
    summary.attempted += 1;

    let res;
    try {
      res = await fetchPage(normalized, { apiKey });
    } catch (err) {
      res = { ok: false, status: 0, text: String(err?.message ?? err) };
    }
    if (!res.ok) {
      const detail = res.text ? ` — ${String(res.text).slice(0, 120)}` : '';
      const reason = `HTTP ${res.status || 0}${detail}`;
      upsertEntry(ledger, key, {
        kind: 'web', source: normalized, status: STATUS.FAILED,
        attempts: (existing?.attempts ?? 0) + 1, last_error: reason, last_attempt_at: stampedAt,
      });
      summary.failed += 1;
      summary.failures.push({ url: normalized, reason });
      summary.pages.push({ url: normalized, result: 'failed', reason });
      continue;
    }

    const { title, finalUrl, markdown } = parseJinaResponse(res.text);
    const finalNormalized = (finalUrl && safeNormalize(finalUrl)) || normalized;
    const finalHash = sha16(finalNormalized);

    // ── 2차 dedupe: 다른 진입 URL이 리다이렉트로 같은 문서에 도달 ──
    const twin = findByFinalHash(ledger, finalHash, key);
    // 쌍둥이가 **차단분**이면 저장하지 않고 이 키도 차단으로 전파한다(v2.12 —
    // source_remove의 영구 차단을 새 진입 URL이 우회하면 안 된다. blocked > force).
    if (twin && ledger.sources[twin].status === STATUS.BLOCKED) {
      upsertEntry(ledger, key, {
        kind: 'web', source: normalized, final_url: finalNormalized, final_hash: finalHash,
        status: STATUS.BLOCKED, blocked_at: ledger.sources[twin].blocked_at ?? stampedAt,
        attempts: (existing?.attempts ?? 0) + 1, last_attempt_at: stampedAt,
      });
      summary.skipped += 1;
      summary.pages.push({ url: normalized, result: 'skipped', reason: 'blocked' });
      continue;
    }
    if (twin && !force) {
      const t = ledger.sources[twin];
      upsertEntry(ledger, key, {
        kind: 'web', source: normalized, final_url: finalNormalized, final_hash: finalHash,
        status: STATUS.COLLECTED, file: t.file, title: t.title, batch,
        attempts: (existing?.attempts ?? 0) + 1, last_error: null,
        collected_at: t.collected_at, last_attempt_at: stampedAt,
      });
      summary.duplicated += 1;
      summary.pages.push({ url: normalized, result: 'duplicate', sameAs: t.file });
      pushLinks(queue, queued, markdown, finalNormalized, registrable);
      continue;
    }

    // ── 저장 ──
    // --force 재수집은 **기존 파일명을 유지**한다 — stem 연쇄가 끊기면 파생 산출물과의 1:1이 깨진다(§2.4.4).
    const fileName = existing?.file ?? `${buildStem(batch, mainName, pageNo)}.md`;
    if (!existing?.file) pageNo += 1;
    const body = matter.stringify(markdown, {
      source_type: 'web',
      url: current,
      url_normalized: normalized,
      source_hash: key,
      domain: mainName,
      title: title ?? normalized,
      collected_at: stampedAt,
      batch,
    });
    await atomicWriteFile(path.join(paths.input, fileName), body);

    upsertEntry(ledger, key, {
      kind: 'web', source: normalized, final_url: finalNormalized, final_hash: finalHash,
      status: STATUS.COLLECTED, file: fileName, title: title ?? normalized, batch,
      attempts: (existing?.attempts ?? 0) + 1, last_error: null,
      collected_at: stampedAt, last_attempt_at: stampedAt,
    });
    summary.collected += 1;
    summary.pages.push({
      url: normalized,
      result: existing?.file ? 'overwritten' : 'collected',
      file: fileName,
      title: title ?? null,
    });

    pushLinks(queue, queued, markdown, finalNormalized, registrable);
  }

  await saveLedger(ledger);
  summary.remainingInQueue = queue.length;
  return summary;
}

/** 큐에 같은 등록 도메인 링크만 넣는다(중복 제거는 queued 집합). */
function pushLinks(queue, queued, markdown, baseUrl, registrable) {
  for (const link of extractLinks(markdown, baseUrl)) {
    enqueue(queue, queued, link, registrable);
  }
}

/** 링크 1건을 경계·중복 검사 후 큐에 넣는다. */
function enqueue(queue, queued, link, registrable) {
  const norm = safeNormalize(link);
  if (!norm) return;
  if (parseDomain(norm).domain !== registrable) return;
  if (queued.has(norm)) return;
  queued.add(norm);
  queue.push(norm);
}

/**
 * 저장된 Input MD에서 링크를 재추출한다 (§1.5 v2.5 — 네트워크 요청 없음).
 * @param {string} inputDir
 * @param {string} fileName
 * @returns {Promise<string[] | null>} 링크 배열 / 파일이 없으면 null
 */
async function linksFromStoredMd(inputDir, fileName) {
  let raw;
  try {
    raw = await fs.readFile(path.join(inputDir, fileName), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null; // 사용자가 지웠다 — 요약에 보고한다
    throw err;
  }
  const parsed = matter(raw);
  const base = parsed.data?.url_normalized || parsed.data?.url;
  if (!base) return [];
  return extractLinks(parsed.content, base);
}

function safeNormalize(u) {
  try {
    return normalizeUrl(u);
  } catch {
    return null;
  }
}

/** 같은 배치에서 이어 붙일 페이지 번호 — 재실행 시 pNN이 겹치지 않게 한다. */
function nextPageNumber(ledger, batch) {
  let max = 0;
  for (const entry of Object.values(ledger.sources)) {
    if (entry.batch !== batch || typeof entry.file !== 'string') continue;
    const n = /_p(\d+)\.md$/.exec(entry.file);
    if (n) max = Math.max(max, Number(n[1]));
  }
  return max + 1;
}

/** 결과 요약을 사람이 읽는 여러 줄 텍스트로 (성공 기준 8 — 성공 n·실패 m·사유·재시도). */
export function formatSummary(s) {
  const lines = [];
  lines.push(
    `수집 완료 — 성공 ${s.collected}건 · 실패 ${s.failed}건 · 스킵 ${s.skipped}건`
    + ` · robots 차단 ${s.robotsBlocked}건 · 중복 ${s.duplicated}건 (시도 ${s.attempted}/${s.maxPages})`,
  );
  if (s.failed > 0) {
    lines.push('실패 내역 — 다음 실행에서 자동 재시도합니다:');
    for (const f of s.failures) lines.push(`  · ${f.url} — ${f.reason}`);
  }
  if (s.robotsNote) lines.push(`robots.txt: ${s.robotsNote}`);
  if (s.jinaKey === 'none') {
    lines.push('JINA_API_KEY가 없어 무키 저율 호출로 동작했습니다 — 무료 키 발급 권장(속도·한도 개선).');
  }
  if (s.missingFiles?.length > 0) {
    lines.push(
      `원장은 수집됨으로 기록됐으나 파일이 없는 항목 ${s.missingFiles.length}건 — 그 페이지의 링크는 이어받지 못했습니다:`,
    );
    for (const f of s.missingFiles) lines.push(`  · ${f}`);
    lines.push('  (--force로 다시 받거나, 자료 제거 명령으로 원장을 정리하세요.)');
  }
  if (s.remainingInQueue > 0) {
    // 2026-08-22 v2.5: 스킵된 페이지도 저장된 MD에서 링크를 되살리므로(§1.5) **그냥 재실행해도
    // 이어진다.** 초판은 "max_pages를 올리면 이어서 수집합니다"라고 했으나 그때는 거짓이었고,
    // 이제는 사실이 되었다 — 안내를 사실에 맞춘 것이 아니라 **동작을 안내에 맞췄다.**
    lines.push(
      `상한에 걸려 ${s.remainingInQueue}개 URL을 남겼습니다 — 같은 명령을 다시 실행하면 이어서 수집합니다`
      + '(수집한 페이지는 요청 없이 스킵되고, 저장된 MD에서 링크만 되살립니다).',
    );
  }
  return lines.join('\n');
}
