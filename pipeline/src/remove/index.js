// source_remove 도메인 — 자료의 완전 제거 (TECH-SPEC §4.3-9 v2.12 · §2.4.1).
//
// 순서가 계약이다(2026-08-26 반박 패널): **① 키·형제 엔트리 확정(읽기만) → ② 파일 전수 삭제
// → ③ 전부 성공했을 때만 원장 변경 → ④ Reviewed 제거분이 있으면 재빌드(실패 허용)**.
// 원장을 먼저 지우면 부분 실패 시 URL→파일 연결이 끊겨 재시도 자체가 불능이 되고,
// 파일만 지우고 원장을 남기면 collected 엔트리가 유령이 되어 재수집이 영구 스킵된다.
//
// **리다이렉트 쌍둥이 전수 처리**: 2차 dedupe(§1.5)는 같은 문서를 가리키는 원장 엔트리를
// 여러 개 만든다(다른 진입 URL, 같은 file). 첫 매치 1건만 처리하면 recollect_ok는 재수집이
// 막히고 block은 차단이 우회된다 — 같은 file·final_hash를 공유하는 전 엔트리를 일괄 처리한다.

import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';

import { dataPaths, ensureDataDirs } from '@bibliomind/shared/paths';
import { sha16 } from '@bibliomind/shared/normalize';
import { normalizeUrl } from '@bibliomind/shared/urlNormalize';
import { isoKst } from '@bibliomind/shared/datetime';
import { loadLedger, saveLedger, webKey, STATUS } from '../ledger.js';

const MODES = ['recollect_ok', 'block'];

/** 정규식 이스케이프 — rej 회차 앵커 매칭용(§2.4.2 문면 일치, startsWith는 타 stem 오폭). */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

/**
 * target 문자열을 분류한다 — URL / Input 파일명 / 거부.
 * @param {string} target
 * @returns {{ kind: 'url', normalized: string } | { kind: 'file', stem: string } | { kind: 'invalid', summary: string }}
 */
function classifyTarget(target) {
  const t = String(target ?? '').trim();
  if (!t) return { kind: 'invalid', summary: 'target이 비어 있습니다.' };
  if (t.includes('://')) {
    try {
      return { kind: 'url', normalized: normalizeUrl(t) };
    } catch (err) {
      return { kind: 'invalid', summary: `URL 형식이 올바르지 않습니다: ${err.message}` };
    }
  }
  if (t !== path.basename(t) || t.includes('..')) {
    // 'ex.com/company' 같은 스킴리스 URL 추정 입력 — "파일명이어야" 오류는 오도다.
    if (/^[\w.-]+\.[a-z]{2,}([/?#]|$)/i.test(t)) {
      return { kind: 'invalid', summary: `URL로 보입니다 — https:// 를 붙여 다시 시도하세요: https://${t}` };
    }
    return { kind: 'invalid', summary: `target은 폴더 경로가 아니라 파일명 또는 URL이어야 합니다: ${t}` };
  }
  // .md와 .kg.json 양쪽 수용 — review_list에서 .kg.json명을 복사하는 실수 예상 지점(v2.12).
  if (t.endsWith('.kg.json')) return { kind: 'file', stem: t.slice(0, -'.kg.json'.length) };
  if (t.endsWith('.md')) return { kind: 'file', stem: t.slice(0, -'.md'.length) };
  return { kind: 'invalid', summary: `Input 파일명(.md)·산출물 파일명(.kg.json)·URL만 받습니다: ${t}` };
}

/** Input MD 프론트매터에서 원장 키(source_hash — §2.4.3)와 URL을 읽는다. 없으면 null. */
async function readFrontmatterKey(inputPath) {
  try {
    const parsed = matter(await fs.readFile(inputPath, 'utf8'));
    return {
      key: parsed.data?.source_hash ?? null,
      url: parsed.data?.url_normalized ?? parsed.data?.url ?? null,
    };
  } catch {
    return { key: null, url: null };
  }
}

/**
 * 같은 자료를 가리키는 원장 키 전수 — file 공유 + final_hash 동치(쌍둥이).
 * @param {{sources: Record<string, object>}} ledger
 * @param {{ inputFile?: string | null, keys?: string[] }} anchor
 * @returns {string[]}
 */
function siblingKeys(ledger, { inputFile = null, keys = [] }) {
  const found = new Set(keys.filter((k) => ledger.sources[k]));
  const hashes = new Set();
  const collect = () => {
    for (const [key, entry] of Object.entries(ledger.sources)) {
      if (found.has(key)) { if (entry.final_hash) hashes.add(entry.final_hash); continue; }
      if (inputFile && entry.file === inputFile) { found.add(key); if (entry.final_hash) hashes.add(entry.final_hash); }
    }
    for (const [key, entry] of Object.entries(ledger.sources)) {
      if (!found.has(key) && entry.final_hash && hashes.has(entry.final_hash)) found.add(key);
    }
  };
  collect(); collect(); // file→hash→추가 file 전파는 최대 2패스로 수렴한다(해시는 문서당 1개)
  return [...found];
}

/**
 * `source_remove` — 자료의 완전 제거(Input·Generated·Reviewed·Rejected 전 회차 + 원장 처리).
 *
 * @param {object} options
 * @param {string} options.target Input 파일명(.md/.kg.json) 또는 원본 URL
 * @param {'recollect_ok'|'block'} options.mode 원장 삭제(재수집 허용) | 차단 표시(영구 차단)
 * @param {ReturnType<typeof dataPaths>} [options.dirs]
 * @param {Function} [options.rebuildImpl] 테스트 주입용 — 기본은 rebuildGraph
 * @param {Date} [options.now]
 * @returns {Promise<object>}
 */
export async function removeSource({ target, mode, dirs, rebuildImpl, now }) {
  if (!MODES.includes(mode)) {
    return fail(`mode는 ${MODES.join(' | ')} 중 하나여야 합니다: ${mode}`);
  }
  const paths = dirs ?? (ensureDataDirs(), dataPaths());
  const parsed = classifyTarget(target);
  if (parsed.kind === 'invalid') return fail(parsed.summary);

  const ledger = await loadLedger(paths.ledgerFile);

  // ── ① 키·stem·형제 엔트리 확정 — 읽기만, 아직 아무것도 지우지 않는다 ──
  let stem = null;
  let seedKeys = [];
  if (parsed.kind === 'url') {
    const { key } = webKey(parsed.normalized);
    const targetHash = sha16(parsed.normalized);
    if (ledger.sources[key]) {
      seedKeys = [key];
    } else {
      // 리다이렉트 최종 URL 입력 폴백 — final_hash·final_url·source 대조(v2.12)
      for (const [k, entry] of Object.entries(ledger.sources)) {
        if (entry.final_hash === targetHash || entry.final_url === parsed.normalized || entry.source === parsed.normalized) {
          seedKeys.push(k);
        }
      }
    }
    if (seedKeys.length === 0) {
      if (mode === 'block') {
        // 미수집 URL의 선제 차단 — webKey로 신규 blocked 엔트리(§4.3-9 v2.12)
        ledger.sources[key] = {
          kind: 'web', source: parsed.normalized, final_url: null, final_hash: null,
          status: STATUS.BLOCKED, file: null, title: null, batch: null,
          attempts: 0, last_error: null, collected_at: null,
          last_attempt_at: isoKst(now), reject_count: 0, blocked_at: isoKst(now),
        };
        await saveLedger(ledger, paths.ledgerFile);
        return {
          ok: true, target: String(target), mode, stem: null,
          removed: [], failed: [], ledger: { action: 'blocked', keys: [key] },
          rebuild: { required: false, done: false, note: null }, notes: [],
          summary: '원장에 수집 기록이 없는 URL입니다 — 파일 제거 없이 차단만 등록했습니다(향후 수집이 건너뜁니다).',
        };
      }
      return fail(`원장에서 찾지 못했습니다 — 조사 범위: webKey 정확 일치 + final_hash·final_url·source 폴백. URL 표기를 확인하거나 Input 파일명으로 다시 시도하세요: ${parsed.normalized}`);
    }
    const withFile = seedKeys.map((k) => ledger.sources[k]).find((e) => e.file);
    stem = withFile?.file ? withFile.file.replace(/\.md$/, '') : null;
  } else {
    stem = parsed.stem;
  }

  const inputFile = stem ? `${stem}.md` : null;
  const inputPath = inputFile ? path.join(paths.input, inputFile) : null;
  const fm = inputPath && (await exists(inputPath)) ? await readFrontmatterKey(inputPath) : { key: null, url: null };
  const keys = siblingKeys(ledger, { inputFile, keys: [...seedKeys, ...(fm.key ? [fm.key] : [])] });

  // block인데 차단을 기록할 키가 하나도 없으면 — 지우기 **전에** 멈춘다(조용한 성공 금지).
  if (mode === 'block' && keys.length === 0 && !fm.key) {
    return fail('차단할 원장 키가 없습니다 — 원장에 엔트리가 없고 Input MD(source_hash)도 없습니다. 원본 URL로 다시 시도하세요.');
  }

  // ── ② 파일 전수 삭제 — 실존하는 것만, 실패는 모아서 보고 ──
  const candidates = [];
  if (stem) {
    candidates.push(
      { dir: paths.input, name: `${stem}.md`, folder: 'Input' },
      { dir: paths.generated, name: `${stem}.kg.json`, folder: 'Generated' },
      { dir: paths.reviewed, name: `${stem}.kg.json`, folder: 'Reviewed' },
    );
    const rejRe = new RegExp(`^${escapeRe(stem)}\\.kg\\.rej\\d+\\.json$`);
    try {
      for (const f of await fs.readdir(paths.rejected)) {
        if (rejRe.test(f)) candidates.push({ dir: paths.rejected, name: f, folder: 'Rejected' });
      }
    } catch { /* Rejected/ 없음 — 첫 실행 */ }
  }

  const removed = [];
  const failed = [];
  let reviewedRemoved = false;
  for (const c of candidates) {
    const full = path.join(c.dir, c.name);
    if (!(await exists(full))) continue;
    try {
      await fs.unlink(full);
      removed.push(`${c.folder}/${c.name}`);
      if (c.folder === 'Reviewed') reviewedRemoved = true;
    } catch (err) {
      failed.push({ file: `${c.folder}/${c.name}`, error: err.message });
    }
  }

  // ── ③ 원장 변경 — 파일이 전부 지워졌을 때만(부분 실패 시 원장 불변 = 재실행이 곧 복구) ──
  let ledgerAction = 'none';
  if (failed.length === 0) {
    if (mode === 'recollect_ok') {
      for (const k of keys) delete ledger.sources[k];
      ledgerAction = keys.length > 0 ? 'deleted' : 'none';
    } else {
      const at = isoKst(now);
      const targets = keys.length > 0 ? keys : [fm.key];
      for (const k of targets) {
        const base = ledger.sources[k] ?? {
          kind: 'web', source: fm.url, final_url: null, final_hash: null,
          file: inputFile, title: null, batch: null, attempts: 0, last_error: null,
          collected_at: null, last_attempt_at: null, reject_count: 0,
        };
        ledger.sources[k] = { ...base, status: STATUS.BLOCKED, blocked_at: at };
      }
      ledgerAction = 'blocked';
    }
    await saveLedger(ledger, paths.ledgerFile);
  }

  // ── ④ Reviewed 제거분이 있으면 자동 재빌드 — 실패해도 제거는 성립(§4.3-7 반려와 같은 계약) ──
  let rebuild = { required: false, done: false, note: null };
  if (reviewedRemoved && failed.length === 0) {
    const run = rebuildImpl ?? (await import('../inject/index.js')).rebuildGraph;
    try {
      const result = await run();
      rebuild = result?.ok
        ? { required: true, done: true, note: `제외 재빌드 완료 — 노드 ${result.nodes}·관계 ${result.relationships} (buildId ${result.buildId}).` }
        : { required: true, done: false, note: `파일은 제거됐지만 재빌드는 하지 못했습니다 — ${result?.summary ?? '사유 불명'} 나중에 kg_rebuild를 실행하세요.` };
    } catch (err) {
      rebuild = { required: true, done: false, note: `파일은 제거됐지만 재빌드는 하지 못했습니다 — ${err.message} 나중에 kg_rebuild를 실행하세요.` };
    }
  }

  // 사전 점검 안내(§2.3.2 v2.10 한계 ③) — 제거 자료에서 온 값·note가 사전에 남았을 수 있다.
  const notes = [];
  try {
    const schema = JSON.parse(await fs.readFile(paths.schemaFile, 'utf8'));
    if ((schema.canonical_entities?.length ?? 0) > 0 || (schema.property_overrides?.length ?? 0) > 0) {
      notes.push('스키마 사전(canonical_entities·property_overrides)에 이 자료에서 온 값·note가 남았을 수 있습니다 — schema_get으로 점검하세요.');
    }
  } catch { /* 스키마 없음 — 안내 생략 */ }

  const ok = failed.length === 0;
  return {
    ok, target: String(target), mode, stem,
    removed, failed,
    ledger: { action: ok ? ledgerAction : 'none', keys },
    rebuild, notes,
    summary: ok
      ? (removed.length === 0
        ? '제거할 파일이 없었습니다(이미 제거됐거나 존재하지 않음) — 원장 처리만 수행했습니다.'
        : `${removed.length}개 파일을 완전 제거했습니다(${mode === 'block' ? '재수집 영구 차단' : '재수집 허용'}).`)
      : `일부 파일을 지우지 못했습니다(${failed.length}건) — **원장은 건드리지 않았습니다.** 장애 원인 해소 후 같은 명령을 다시 실행하면 남은 것만 마저 지웁니다(멱등).`,
  };

  function fail(summary) {
    return {
      ok: false, target: String(target), mode, stem: null,
      removed: [], failed: [], ledger: { action: 'none', keys: [] },
      rebuild: { required: false, done: false, note: null }, notes: [], summary,
    };
  }
}
