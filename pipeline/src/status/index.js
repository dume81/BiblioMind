// kg_status 도메인 수집 (TECH-SPEC §4.3-15 v2.12).
//
// DB count까지 도메인이 소유한다(sessionFactory 주입) — 표면 파일(tools/*.js)에 Cypher를
// 반입하는 최초 선례를 만들지 않기 위함(2026-08-26 패널 확정. D3 계쟁과 무관하게 pipeline은
// 합법 위치 — inject가 같은 방식의 선례). DB·허브 실패는 이 도구의 실패가 아니라
// "부분 성공"의 재료다 — 상태 보고 자체가 산출물이므로 throw하지 않고 환원한다.

import fs from 'node:fs/promises';

import { dataPaths, ensureDataDirs } from '@bibliomind/shared/paths';
import { getReadSession, classifyNeo4jError } from '@bibliomind/shared/neo4jClient';
import { loadLedger } from '../ledger.js';
import { resolveEngine } from '../generate/resolveEngine.js';
import { STATUS } from '../ledger.js';

async function countFiles(dir, suffix) {
  try {
    return (await fs.readdir(dir)).filter((f) => f.endsWith(suffix)).length;
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
}

/**
 * 파이프라인·스키마·원장·DB 상태 수집 — kg_status의 도메인 몫.
 * @param {object} [options]
 * @param {ReturnType<typeof dataPaths>} [options.dirs]
 * @param {() => import('neo4j-driver').Session} [options.sessionFactory] 테스트 주입용
 * @param {Record<string, string|undefined>} [options.env]
 * @returns {Promise<object>}
 */
export async function collectPipelineStatus(options = {}) {
  const paths = options.dirs ?? (ensureDataDirs(), dataPaths());
  const env = options.env ?? process.env;

  const [input, generated, reviewed, rejected] = await Promise.all([
    countFiles(paths.input, '.md'),
    countFiles(paths.generated, '.kg.json'),
    countFiles(paths.reviewed, '.kg.json'),
    countFiles(paths.rejected, '.json'),
  ]);

  let ledger = { sources: {}, build: undefined };
  let ledgerError = null;
  try {
    const raw = JSON.parse(await fs.readFile(paths.ledgerFile, 'utf8'));
    ledger = { sources: raw.sources ?? {}, build: raw.build };
  } catch (err) {
    if (err.code !== 'ENOENT') ledgerError = err.message; // 손상은 보고, 부재는 첫 실행
    else { const empty = await loadLedger(paths.ledgerFile); ledger = { sources: empty.sources, build: undefined }; }
  }
  const held = Object.values(ledger.sources)
    .filter((e) => Number(e?.reject_count ?? 0) >= 3 && e?.file)
    .map((e) => e.file)
    .sort();
  const blocked = Object.values(ledger.sources).filter((e) => e?.status === STATUS.BLOCKED).length;

  let schema = null;
  let schemaError = null;
  try {
    const s = JSON.parse(await fs.readFile(paths.schemaFile, 'utf8'));
    schema = {
      schema_version: s.schema_version ?? null,
      updated_at: s.updated_at ?? null,
      autoTypes: [
        ...(s.node_labels ?? []).filter((x) => x.origin === 'auto').map((x) => x.label),
        ...(s.extended_relationships ?? []).filter((x) => x.origin === 'auto').map((x) => x.type),
      ],
    };
  } catch (err) {
    schemaError = err.message;
  }

  // DB 실측 — RKEntity 스코프(재빌드 자기검증·buildId counts와 표시 일관, v2.12)
  const sessionFactory = options.sessionFactory ?? getReadSession;
  let db;
  try {
    const session = sessionFactory();
    try {
      const nodes = await countOf(session, 'MATCH (n:RKEntity) RETURN count(n) AS c');
      const relationships = await countOf(session,
        'MATCH (:RKEntity)-[r]->(:RKEntity) WHERE r.kgid IS NOT NULL RETURN count(r) AS c');
      db = { ok: true, nodes, relationships };
    } finally {
      await session.close?.();
    }
  } catch (err) {
    const { kind, hint } = classifyNeo4jError(err);
    db = { ok: false, kind, hint, error: String(err?.message ?? err) };
  }

  return {
    pipeline: { input, generated, reviewed, rejected, held, blocked },
    build: ledger.build ?? null,
    ledgerError,
    schema,
    schemaError,
    db,
    engine: resolveEngine(undefined, env).engine ?? null,
  };
}

async function countOf(session, cypher) {
  const res = await session.run(cypher);
  return res.records[0]?.get('c')?.toInt?.() ?? Number(res.records[0]?.get('c') ?? 0);
}
