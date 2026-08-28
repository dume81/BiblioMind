// 1층 집합·별칭↔kgid 맵의 영속 계층 — data/runtime/last-searches.json (최근 5건 롤링, §6.3 단계 4).
// 원자적 쓰기(§2.5 스테이징). 레코드 스키마(총감사 확정):
// { searchId, ts, buildId, question, truncated,
//   nodes: { 별칭 → { kgid } }, rels: { 별칭 → { kgid, from, to } } }
// "현재 표시 중인 검색"(§6.5.4) = 최신 레코드 — 모든 kg_search가 무조건 푸시하므로
// 최신 기록 = 마지막 푸시 = 화면 상태와 정합(유일하게 자연스러운 해석).
import fs from 'node:fs';
import path from 'node:path';
import { ensureDataDirs } from '@bibliomind/shared/paths';

const MAX_ENTRIES = 5;

/** @param {NodeJS.ProcessEnv} [env] @returns {object[]} */
function readAll(env = process.env) {
  const p = ensureDataDirs(env);
  try {
    const parsed = JSON.parse(fs.readFileSync(p.lastSearchesFile, 'utf8'));
    return Array.isArray(parsed.searches) ? parsed.searches : [];
  } catch {
    return [];
  }
}

/**
 * 검색 레코드를 기록한다 (롤링 5건, 원자적 쓰기).
 * @param {object} entry
 * @param {NodeJS.ProcessEnv} [env]
 */
export function recordSearch(entry, env = process.env) {
  const p = ensureDataDirs(env);
  const list = readAll(env);
  list.push(entry);
  while (list.length > MAX_ENTRIES) list.shift();
  const staging = path.join(p.staging, 'last-searches.json');
  fs.writeFileSync(staging, JSON.stringify({ searches: list }, null, 2));
  fs.renameSync(staging, p.lastSearchesFile);
}

/**
 * searchId로 레코드 조회. 생략 시 최신 레코드(§4.3-13 — 챗 모델 실수 관용).
 * @param {string} [searchId]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {object | null}
 */
export function getSearch(searchId, env = process.env) {
  const list = readAll(env);
  if (!searchId) return list[list.length - 1] ?? null;
  return list.find((s) => s.searchId === searchId) ?? null;
}

/** 최신 레코드 = "현재 표시 중인 검색". @param {NodeJS.ProcessEnv} [env] */
export function latestSearch(env = process.env) {
  const list = readAll(env);
  return list[list.length - 1] ?? null;
}
