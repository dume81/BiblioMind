// 수집 원장(ledger.json) — 멱등 스킵·실패 재시도·차단·반려 카운트 (TECH-SPEC §2.4.4).
//
// 역할은 셋뿐이다: 수집 멱등 스킵 / 실패 재시도 / 차단. 여기에 반려 횟수 카운트가 붙는다.
// 쓰기는 §2.5-1의 스테이징 + rename(원자적)을 쓴다 — 반쪽 원장이 남으면 다음 실행의
// 스킵 판정이 통째로 어긋나기 때문이다.
//
// 키 규약(§2.4.4): sha256 앞 16자.
//   웹  = **BFS가 발견한 URL의 정규화 결과** 해시 (요청을 보내기 전에 스킵을 판정할 수 있는 1차 키)
//   문서 = 원본 파일 내용 해시
// 수집 후 리다이렉트 최종 URL의 정규화 키를 final_hash로 병기해 2차 dedupe에 쓴다.

import fs from 'node:fs/promises';
import { dataPaths } from '@bibliomind/shared/paths';
import { sha16 } from '@bibliomind/shared/normalize';
import { normalizeUrl } from '@bibliomind/shared/urlNormalize';
import { atomicWriteJson } from '@bibliomind/shared/atomicWrite';

export const LEDGER_VERSION = 1;

/** 원장 상태값 — 이 셋이 전부다(§2.4.4). */
export const STATUS = Object.freeze({ COLLECTED: 'collected', FAILED: 'failed', BLOCKED: 'blocked' });

/**
 * 정규화 URL의 원장 키.
 * @param {string} url 원본 URL(정규화 전)
 * @returns {{ key: string, normalized: string }}
 */
export function webKey(url) {
  const normalized = normalizeUrl(url);
  return { key: sha16(normalized), normalized };
}

/**
 * 파일 내용의 원장 키(문서 경로 — 슬라이스 4에서 사용).
 * @param {string} content
 * @returns {string}
 */
export function contentKey(content) {
  return sha16(content);
}

/** 빈 원장. */
function emptyLedger() {
  return { version: LEDGER_VERSION, sources: {} };
}

/**
 * 원장을 읽는다. 파일이 없으면 빈 원장을 돌려준다(첫 실행 — 오류가 아니다).
 * 손상된 JSON은 **조용히 무시하지 않고 throw**한다 — 원장을 잃으면 이미 수집한
 * 페이지를 전부 다시 긁게 되므로, 사용자가 알아채야 하는 사고다.
 * @param {string} [file] 기본값 = data/ledger.json
 * @returns {Promise<{version: number, sources: Record<string, object>}>}
 */
export async function loadLedger(file) {
  const target = file ?? dataPaths().ledgerFile;
  let raw;
  try {
    raw = await fs.readFile(target, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return emptyLedger();
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`원장(${target})이 손상되어 읽을 수 없습니다: ${err.message}. 복구 전에는 수집을 실행하지 마세요 — 기수집 판정이 전부 무효가 되어 같은 페이지를 다시 긁습니다.`);
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.sources !== 'object' || parsed.sources === null) {
    throw new Error(`원장(${target}) 형식이 올바르지 않습니다 — { version, sources } 객체가 아닙니다.`);
  }
  return { version: parsed.version ?? LEDGER_VERSION, sources: parsed.sources };
}

/**
 * 원장을 원자적으로 저장한다.
 * @param {{version: number, sources: object}} ledger
 * @param {string} [file]
 * @returns {Promise<void>}
 */
export async function saveLedger(ledger, file) {
  const target = file ?? dataPaths().ledgerFile;
  await atomicWriteJson(target, { version: ledger.version ?? LEDGER_VERSION, sources: ledger.sources ?? {} });
}

/**
 * 엔트리 조회.
 * @param {{sources: object}} ledger
 * @param {string} key
 * @returns {object | null}
 */
export function getEntry(ledger, key) {
  return ledger.sources[key] ?? null;
}

/**
 * 엔트리 생성·갱신(부분 병합). 없으면 기본값으로 만든다.
 * @param {{sources: object}} ledger
 * @param {string} key
 * @param {object} patch
 * @returns {object} 병합된 엔트리
 */
export function upsertEntry(ledger, key, patch) {
  const base = ledger.sources[key] ?? {
    kind: 'web',
    source: null,
    final_url: null,
    final_hash: null,
    status: STATUS.FAILED,
    file: null,
    title: null,
    batch: null,
    attempts: 0,
    last_error: null,
    collected_at: null,
    last_attempt_at: null,
    reject_count: 0,
  };
  const merged = { ...base, ...patch };
  ledger.sources[key] = merged;
  return merged;
}

/**
 * **1차 스킵 판정 — 요청을 보내기 전에 부른다**(§1.5 멱등 스킵 2단의 ①).
 *
 * 우선순위: blocked > force > collected. `blocked`가 `--force`를 이긴다(§2.4.4) —
 * 차단 해제는 명시적 챗 명령으로만 한다.
 * @param {object | null} entry
 * @param {{ force?: boolean }} [options]
 * @returns {{ skip: boolean, reason: string | null }}
 */
export function shouldSkip(entry, { force = false } = {}) {
  if (!entry) return { skip: false, reason: null };
  if (entry.status === STATUS.BLOCKED) return { skip: true, reason: 'blocked' };
  if (entry.status === STATUS.COLLECTED) {
    return force ? { skip: false, reason: null } : { skip: true, reason: 'collected' };
  }
  return { skip: false, reason: null }; // failed = 자동 재시도(PRD S1)
}

/**
 * **2차 dedupe — 수집 응답의 최종 URL로 부른다**(§1.5 멱등 스킵 2단의 ②).
 * 다른 진입 URL이 리다이렉트로 같은 문서에 도달한 경우를 잡는다.
 * **blocked 엔트리도 대조한다**(v2.12 — source_remove의 차단을 새 진입 URL의 리다이렉트가
 * 우회하면 "영구 차단"이 거짓이 된다). failed는 여전히 제외 — 파일이 없어 쌍둥이가 아니다.
 * @param {{sources: object}} ledger
 * @param {string} finalHash
 * @param {string} selfKey 자기 자신은 제외한다
 * @returns {string | null} 겹치는 기존 키
 */
export function findByFinalHash(ledger, finalHash, selfKey) {
  if (!finalHash) return null;
  for (const [key, entry] of Object.entries(ledger.sources)) {
    if (key === selfKey) continue;
    if (entry.final_hash === finalHash
      && (entry.status === STATUS.COLLECTED || entry.status === STATUS.BLOCKED)) return key;
  }
  return null;
}
