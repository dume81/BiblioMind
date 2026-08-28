// S5 Neo4j 주입기 — 전체 재빌드·병합·kgid·출처 속성 (TECH-SPEC §2.3·§4.3-8).
//
// 설계의 뼈대는 한 문장이다: **Reviewed/ 폴더가 그래프의 원본 진실이고, DB는 그 파생물이다.**
// 그래서 재빌드는 "차이를 계산해 반영"하지 않고 **전부 지우고 전부 다시 넣는다**.
// 그 대가로 얻는 것이 멱등성이다 — 같은 Reviewed/ 상태면 몇 번을 돌려도 같은 결과가 나오고,
// 중간에 실패해도 "다시 실행하는 것이 곧 복구"가 된다(§4.3-8).
//
// 순서가 고정인 이유(§2.3.4·§2.5): 검증 → 보호 확인 → 삭제 → 제약·인덱스 → 노드 → 관계.
// **검증을 DB에 손대기 전에 전부 끝낸다** — 한 파일이 깨져 있으면 지우기 전에 멈춰야
// 기존 그래프가 살아남는다. 지운 뒤에 발견하면 복구할 것이 없다.

import fs from 'node:fs/promises';
import path from 'node:path';

import { dataPaths, ensureDataDirs, SCHEMA_DEFAULT_FILE } from '@bibliomind/shared/paths';
import { nameKey, nodeKgid, relKgid } from '@bibliomind/shared/normalize';
import { normalizeCanonicalGraph } from '@bibliomind/shared/canonicalGraph';
import { NODE_LABEL_RULE, RELATIONSHIP_RULE } from '@bibliomind/shared/kgSchemaValidate';
import { getWriteSession } from '@bibliomind/shared/neo4jClient';
import { atomicWriteJson } from '@bibliomind/shared/atomicWrite';
import { isoKst } from '@bibliomind/shared/datetime';
import { acquireLock } from '../lock.js';
import { buildCanonicalIndex, canonicalize } from './canonicalize.js';
import {
  buildPropertyOverrideIndex, resolvePropertyOverrides, propValueKey, isObservableProp,
} from './propertyOverrides.js';

/** 주입 배치 크기 (§4.3-8 — 필요 시 2,000까지 상향 여지). */
export const INJECT_BATCH = 500;
/** 삭제 배치 크기 — Aura는 트랜잭션 메모리 상한이 강제라 단일 tx로 지우지 않는다(§4.3-8 v2.1). */
export const DELETE_BATCH = 2000;
/** 유사 이름 쌍 보고 상한 (§2.3.2). */
export const SIMILAR_PAIR_LIMIT = 10;

const US = '\u001f'; // 이름에 등장할 수 없는 구분자 (§3.5)

/**
 * Reviewed/ 문서들을 하나의 그래프로 병합한다 — **순수 함수**(DB·파일 접근 없음).
 *
 * 병합 키는 노드 (표시 라벨, name_key), 관계 (시작 kgid, type, 끝 kgid)다(§2.3.2).
 * 속성은 **선착 우선**이고 문서는 **파일명 오름차순**으로 처리되므로, 같은 입력 집합이면
 * 결과가 항상 같다 — 이것이 멱등성의 근거다.
 *
 * @param {{ file: string, doc: object }[]} docs 파일명 오름차순으로 정렬된 문서 목록
 * @param {Map<string, {label: string, name: string}>} [canonicalIndex] 정본 엔티티 사전(§2.3.2 v2.8)
 * @returns {{ nodes: object[], rels: object[], canonicalized: number }}
 */
export function mergeReviewed(docs, canonicalIndex = new Map()) {
  const nodes = new Map(); // mergeKey → entry
  const rels = new Map(); // dedupeKey → entry
  // mergeKey → 속성 → 값 키 → { value, files } — 선착에서 버려진 값 포함 전체 관측
  // (§2.3.2 v2.10 속성 충돌 가시화. **노드 속성만** — 관계 속성의 동형 결함은 개선 큐 Q11).
  const observations = new Map();
  let canonicalized = 0;

  for (const { file, doc } of docs) {
    const inputFile = doc?.meta?.input_file ?? file.replace(/\.kg\.json$/, '.md');
    const kgidByLocalId = new Map();

    for (const node of doc.nodes) {
      // **정규화가 병합 키 계산보다 먼저 온다** — 갈라진 표기를 정본으로 바꾼 뒤에
      // 키를 만들어야 같은 노드로 모인다(§2.3.2 v2.8).
      const canon = canonicalize(canonicalIndex, node.label, node.properties.name);
      if (canon.changed) canonicalized += 1;
      const key = nameKey(canon.name);
      const mergeKey = `${canon.label}${US}${key}`;
      const kgid = nodeKgid(canon.label, key);
      kgidByLocalId.set(node.id, kgid);

      let entry = nodes.get(mergeKey);
      if (!entry) {
        entry = {
          label: canon.label,
          kgid,
          // 표시 이름은 **첫 등장 표기를 유지**한다(§2.3.1) — 병합 키는 정규화하지만 화면에
          // 보이는 이름까지 뭉개면 사용자가 자기 자료를 못 알아본다.
          // 단 사전이 정본을 지정했다면 그 이름을 쓴다 — 사람이 명시적으로 고른 표기다.
          name: String(canon.name).normalize('NFC'),
          name_key: key,
          props: {},
          reviewed_files: new Set(),
          input_files: new Set(),
        };
        nodes.set(mergeKey, entry);
      }
      mergeProps(entry.props, node.properties);
      entry.reviewed_files.add(file);
      entry.input_files.add(inputFile);

      // 관측 기록 — mergeProps가 버린 값도 포함해야 충돌이 보인다(§2.3.2 v2.10)
      for (const [propKey, propValue] of Object.entries(node.properties)) {
        if (!isObservableProp(propKey)) continue;
        let propMap = observations.get(mergeKey);
        if (!propMap) observations.set(mergeKey, (propMap = new Map()));
        let valueMap = propMap.get(propKey);
        if (!valueMap) propMap.set(propKey, (valueMap = new Map()));
        const vk = propValueKey(propValue);
        let seen = valueMap.get(vk);
        if (!seen) valueMap.set(vk, (seen = { value: propValue, files: new Set() }));
        seen.files.add(file);
      }
    }

    for (const rel of doc.relationships) {
      // 참조 무결성은 normalizeCanonicalGraph가 이미 보장한다(§2.2 검증 1단) — 여기서 다시 막지 않는다.
      const fromKgid = kgidByLocalId.get(rel.start_node_id);
      const toKgid = kgidByLocalId.get(rel.end_node_id);
      const dedupeKey = `${fromKgid}${US}${rel.type}${US}${toKgid}`;

      let entry = rels.get(dedupeKey);
      if (!entry) {
        entry = {
          type: rel.type,
          fromKgid,
          toKgid,
          kgid: relKgid(fromKgid, rel.type, toKgid),
          props: {},
          reviewed_files: new Set(),
          input_files: new Set(),
        };
        rels.set(dedupeKey, entry);
      }
      mergeProps(entry.props, rel.properties ?? {});
      entry.reviewed_files.add(file);
      entry.input_files.add(inputFile);
    }
  }

  return {
    nodes: [...nodes.values()].map(finalizeEntry),
    rels: [...rels.values()].map(finalizeEntry),
    canonicalized,
    observations,
  };
}

/** 없는 키는 추가, 있는 키는 **선착 값 유지**(§2.3.2). `name`은 entry가 따로 소유한다. */
function mergeProps(target, incoming) {
  for (const [key, value] of Object.entries(incoming)) {
    if (key === 'name') continue;
    if (!(key in target)) target[key] = value;
  }
}

/** 출처 Set → 정렬·중복 제거된 배열 (§2.3.1). */
function finalizeEntry(entry) {
  return {
    ...entry,
    reviewed_files: [...entry.reviewed_files].sort(),
    input_files: [...entry.input_files].sort(),
  };
}

/**
 * 유사 이름 쌍 — 같은 표시 라벨 안에서 한쪽 name_key가 다른 쪽을 **포함**하는 쌍 (§2.3.2).
 * 병합 누락을 눈으로 잡는 장치다("탄지로" ⊂ "카마도 탄지로"). 자동 병합은 하지 않는다 — 과병합 방지.
 * @param {{label: string, name: string, name_key: string}[]} nodes
 * @returns {{ label: string, shorter: string, longer: string }[]}
 */
export function similarNamePairs(nodes) {
  const byLabel = new Map();
  for (const n of nodes) {
    if (!byLabel.has(n.label)) byLabel.set(n.label, []);
    byLabel.get(n.label).push(n);
  }
  const pairs = [];
  for (const [label, group] of byLabel) {
    const sorted = [...group].sort((a, b) => a.name_key.length - b.name_key.length || a.name_key.localeCompare(b.name_key));
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        if (sorted[j].name_key.includes(sorted[i].name_key)) {
          pairs.push({ label, shorter: sorted[i].name, longer: sorted[j].name });
        }
      }
    }
  }
  return pairs;
}

/**
 * buildId — 재빌드 세대 식별용 타임스탬프(§3.5-5). 매칭에는 쓰지 않는다(kgid가 그 일을 한다).
 * @param {Date} [now]
 * @returns {string} 예: "20260823T142530"
 */
export function makeBuildId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
    + `T${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** 노드·관계를 라벨/유형별로 묶는다 — 라벨은 Cypher에 보간되므로 묶어야 한 번에 넣을 수 있다. */
function groupBy(items, keyOf) {
  const out = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(item);
  }
  return out;
}

function* batches(rows, size) {
  for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size);
}

/**
 * Reviewed/ 전체를 읽어 검증한다. **하나라도 실패하면 전체를 중단한다** — DB는 손대지 않는다.
 * @param {string} reviewedDir
 * @returns {Promise<{ ok: true, docs: {file: string, doc: object}[] } | { ok: false, errors: string[] }>}
 */
export async function loadReviewed(reviewedDir) {
  let files;
  try {
    files = (await fs.readdir(reviewedDir)).filter((f) => f.endsWith('.kg.json')).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, docs: [] };
    throw err;
  }
  const docs = [];
  const errors = [];
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(path.join(reviewedDir, file), 'utf8'));
    } catch (err) {
      errors.push(`${file} — JSON을 읽지 못했습니다: ${err.message}`);
      continue;
    }
    const structural = normalizeCanonicalGraph(parsed);
    if (!structural.ok) {
      errors.push(`${file} — 구조 검증 실패: ${structural.errors.slice(0, 3).join(' / ')}`);
      continue;
    }
    // 라벨·관계 유형은 Cypher에 **보간**되므로 명명 규칙 게이트를 여기서 통과시킨다.
    // 규칙 위반은 검증 실패이기도 하지만, 통과시키면 그대로 질의문에 들어간다.
    for (const n of structural.graph.nodes) {
      if (!NODE_LABEL_RULE.test(n.label)) errors.push(`${file} — 라벨 "${n.label}"이 명명 규칙 위반입니다.`);
    }
    for (const r of structural.graph.relationships) {
      if (!RELATIONSHIP_RULE.test(r.type)) errors.push(`${file} — 관계 유형 "${r.type}"이 명명 규칙 위반입니다.`);
    }
    docs.push({ file, doc: { ...structural.graph, meta: parsed.meta } });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, docs };
}

/**
 * `kg_rebuild` — Reviewed/ 전체를 Neo4j에 재조립한다 (§4.3-8).
 *
 * @param {object} [options]
 * @param {() => import('neo4j-driver').Session} [options.sessionFactory] 테스트 주입용
 * @param {Date} [options.now] 테스트 주입용
 * @returns {Promise<object>} 결과 요약
 */
export async function rebuildGraph(options = {}) {
  const { sessionFactory = getWriteSession, now = new Date() } = options;
  ensureDataDirs();
  const paths = dataPaths();
  const startedAt = Date.now();

  // ── 0. 잠금 (§2.5-6) — 두 챗이 동시에 재빌드하면 DB가 오염된다 ──
  const lock = acquireLock({ holder: 'kg_rebuild' });
  if (!lock.ok) {
    return {
      ok: false, reason: 'locked', holder: lock.holder,
      summary: `다른 재빌드가 진행 중입니다(PID ${lock.holder.pid}, 시작 ${lock.holder.at}) — 끝난 뒤 다시 실행하세요.`,
    };
  }

  try {
    // ── 1. 검증 (DB에 손대기 전) ──
    const loaded = await loadReviewed(paths.reviewed);
    if (!loaded.ok) {
      return {
        ok: false, reason: 'invalid_input', errors: loaded.errors,
        summary: `승인분 ${loaded.errors.length}건이 검증을 통과하지 못해 재빌드를 중단했습니다 — **DB는 건드리지 않았습니다.**`,
      };
    }
    const schema = await readSchema(paths.schemaFile);
    // 정본 엔티티 사전(§2.3.2 v2.8) — 사전이 잘못됐으면 **주입 전에** 멈춘다.
    // 잘못된 사전은 멀쩡한 노드를 엉뚱한 곳으로 합쳐 버리므로 조용히 넘어가면 안 된다.
    const canon = buildCanonicalIndex(schema);
    if (canon.problems.length > 0) {
      return {
        ok: false, reason: 'invalid_canonical', errors: canon.problems,
        summary: `정본 엔티티 사전에 문제가 ${canon.problems.length}건 있어 재빌드를 중단했습니다 — **DB는 건드리지 않았습니다.**`,
      };
    }
    // 속성 승자 사전(§2.3.2 v2.10) — 내부 모순이면 **주입 전에** 멈춘다. 미관측·대상 부재는
    // 중단 사유가 아니라 미적용 보고다(반려·source_remove의 자동 재빌드를 막지 않기 위함).
    const overrides = buildPropertyOverrideIndex(schema, canon.index);
    if (overrides.problems.length > 0) {
      return {
        ok: false, reason: 'invalid_property_overrides', errors: overrides.problems,
        summary: `속성 승자 사전(property_overrides)에 문제가 ${overrides.problems.length}건 있어 재빌드를 중단했습니다 — **DB는 건드리지 않았습니다.** data/schema.json을 수정하세요.`,
      };
    }
    const merged = mergeReviewed(loaded.docs, canon.index);
    const propRes = resolvePropertyOverrides(merged, overrides.index);
    const pairs = similarNamePairs(merged.nodes);

    const summary = {
      ok: true, buildId: makeBuildId(now), files: loaded.docs.length,
      nodes: merged.nodes.length, relationships: merged.rels.length,
      mergedNodes: countMerges(loaded.docs, merged),
      canonicalized: merged.canonicalized,
      overridesApplied: propRes.applied.length,
      overridesUnapplied: propRes.unapplied, // 전량 — 잘라서 숨기지 않는다(§2.3.2 v2.10)
      propertyConflicts: propRes.conflicts.slice(0, SIMILAR_PAIR_LIMIT),
      propertyConflictTotal: propRes.conflictTotal,
      foreignNodes: 0, deleted: 0, verified: null,
      similarPairs: pairs.slice(0, SIMILAR_PAIR_LIMIT), similarPairTotal: pairs.length,
      constraints: 0, elapsedMs: 0, tookOverStaleLock: Boolean(lock.tookOver),
    };

    // ── 2. DB 작업 ──
    const session = sessionFactory();
    try {
      // 보호 확인 — 도구 외 데이터는 건드리지 않음을 수치로 보고한다(§2.3.4)
      summary.foreignNodes = await countOf(session,
        'MATCH (n) WHERE NOT n:RKEntity OR n.reviewed_files IS NULL RETURN count(n) AS c');

      // 이중 방벽 삭제 — 라벨 + 출처 속성 **둘 다** 있는 것만. 배치 tx(Aura 메모리 상한)
      summary.deleted = await countOf(session,
        `MATCH (n:RKEntity) WHERE n.reviewed_files IS NOT NULL RETURN count(n) AS c`);
      await session.run(
        `MATCH (n:RKEntity) WHERE n.reviewed_files IS NOT NULL
         CALL { WITH n DETACH DELETE n } IN TRANSACTIONS OF ${DELETE_BATCH} ROWS`,
      );

      // 제약 — 전역 스키마의 각 표시 라벨(자동 등재분도 다음 재빌드에서 자동 추종, §2.3.3)
      for (const label of schemaLabels(schema)) {
        await session.run(
          `CREATE CONSTRAINT kg_uniq_${label} IF NOT EXISTS FOR (n:\`${label}\`) REQUIRE n.name_key IS UNIQUE`,
        );
        summary.constraints += 1;
      }

      // 노드 → 관계 순 (관계는 양 끝 노드가 있어야 붙는다)
      for (const [label, rows] of groupBy(merged.nodes, (n) => n.label)) {
        for (const batch of batches(rows.map(toNodeRow), INJECT_BATCH)) {
          await session.run(
            `UNWIND $rows AS row CREATE (n:RKEntity:\`${label}\`) SET n = row.props`,
            { rows: batch },
          );
        }
      }
      for (const [type, rows] of groupBy(merged.rels, (r) => r.type)) {
        for (const batch of batches(rows.map(toRelRow), INJECT_BATCH)) {
          await session.run(
            `UNWIND $rows AS row
             MATCH (a:RKEntity { kgid: row.fromKgid }), (b:RKEntity { kgid: row.toKgid })
             CREATE (a)-[r:\`${type}\`]->(b) SET r = row.props`,
            { rows: batch },
          );
        }
      }

      await ensureIndexes(session);

      // 자기검증 — 넣으려던 수와 DB가 실제로 가진 수를 **대조**한다(넣었다고 믿지 않는다)
      const actualNodes = await countOf(session, 'MATCH (n:RKEntity) RETURN count(n) AS c');
      const actualRels = await countOf(session,
        'MATCH (:RKEntity)-[r]->(:RKEntity) WHERE r.kgid IS NOT NULL RETURN count(r) AS c');
      summary.verified = {
        nodes: actualNodes, relationships: actualRels,
        match: actualNodes === summary.nodes && actualRels === summary.relationships,
      };
    } finally {
      await session.close();
    }

    // ── 3. buildId 원장 기록 (§3.5-5) ──
    await recordBuild(paths.ledgerFile, {
      buildId: summary.buildId, at: isoKst(), source: 'kg_rebuild',
      counts: { nodes: summary.nodes, relationships: summary.relationships },
      // 사전(canonical_entities·property_overrides)도 재빌드의 입력이다 — 같은 Reviewed/인데
      // 결과가 다른 경우의 재현성 근거(§2.1.2 v2.10)
      schemaUpdatedAt: schema.updated_at ?? null,
    });

    summary.elapsedMs = Date.now() - startedAt;
    return summary;
  } finally {
    lock.release();
  }
}

/** 병합으로 줄어든 노드 수 = 파일별 노드 합계 − 병합 후 노드 수. */
function countMerges(docs, merged) {
  const raw = docs.reduce((sum, d) => sum + d.doc.nodes.length, 0);
  return Math.max(0, raw - merged.nodes.length);
}

function toNodeRow(n) {
  return {
    props: {
      ...n.props,
      name: n.name,
      name_key: n.name_key,
      kgid: n.kgid,
      reviewed_files: n.reviewed_files,
      input_files: n.input_files,
    },
  };
}

function toRelRow(r) {
  return {
    fromKgid: r.fromKgid,
    toKgid: r.toKgid,
    props: { ...r.props, kgid: r.kgid, reviewed_files: r.reviewed_files, input_files: r.input_files },
  };
}

async function countOf(session, cypher) {
  const res = await session.run(cypher);
  return res.records[0]?.get('c')?.toInt?.() ?? Number(res.records[0]?.get('c') ?? 0);
}

/** 검색 인덱스 2종 보장 (§2.3.3·§6.2.4) — 분석기가 다르면 DROP 후 재생성. */
async function ensureIndexes(session) {
  await session.run('CREATE RANGE INDEX kg_name_key IF NOT EXISTS FOR (n:RKEntity) ON (n.name_key)');
  const idx = await session.run("SHOW INDEXES YIELD name, options WHERE name = 'kg_fulltext' RETURN options");
  const analyzer = idx.records[0]?.get('options')?.indexConfig?.['fulltext.analyzer'];
  if (idx.records.length > 0 && analyzer !== 'cjk') {
    await session.run('DROP INDEX kg_fulltext');
  }
  await session.run(
    "CREATE FULLTEXT INDEX kg_fulltext IF NOT EXISTS FOR (n:RKEntity) ON EACH [n.name] OPTIONS { indexConfig: { `fulltext.analyzer`: 'cjk' } }",
  );
  // population 대기 — 직후 T2 검색이 0건으로 나오는 것을 막는다(슬라이스 0.5 실측 교훈).
  await session.run('CALL db.awaitIndexes(300)');
}

async function readSchema(schemaFile) {
  try {
    return JSON.parse(await fs.readFile(schemaFile, 'utf8'));
  } catch {
    return JSON.parse(await fs.readFile(SCHEMA_DEFAULT_FILE, 'utf8'));
  }
}

/** 제약을 걸 표시 라벨 목록 — 명명 규칙을 통과한 것만(Cypher 보간 게이트). */
function schemaLabels(schema) {
  return (schema.node_labels ?? [])
    .map((x) => x.label)
    .filter((l) => NODE_LABEL_RULE.test(l));
}

/** 원장의 build 항목을 갱신한다 — sources는 건드리지 않는다. */
async function recordBuild(ledgerFile, build) {
  let ledger = { version: 1, sources: {} };
  try {
    ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  } catch { /* 첫 실행 — 빈 원장 */ }
  ledger.build = build;
  await atomicWriteJson(ledgerFile, ledger);
}

/** 결과 요약 텍스트 (§4.3-8 반환 규약). */
export function formatRebuildSummary(s) {
  if (!s.ok) return s.summary;
  const secs = (s.elapsedMs / 1000).toFixed(1);
  const lines = [
    `승인분 ${s.files}건 → 노드 ${s.nodes}·관계 ${s.relationships} 주입 (${secs}초, buildId ${s.buildId})`,
  ];
  if (s.deleted > 0) lines.push(`이전 세대 ${s.deleted}노드를 지우고 새로 넣었습니다(전체 재빌드).`);
  if (s.mergedNodes > 0) lines.push(`병합 ${s.mergedNodes}건 — 여러 자료에 같은 이름으로 나온 노드를 하나로 합쳤습니다.`);
  if (s.canonicalized > 0) lines.push(`정본 정규화 ${s.canonicalized}건 — 갈라진 표기를 사전에 따라 정본으로 모았습니다(§2.3.2).`);
  if (s.overridesApplied > 0) lines.push(`속성 승자 사전 적용 ${s.overridesApplied}건 — 충돌 값을 사람이 지정한 승자로 교정했습니다(§2.3.2).`);
  for (const u of s.overridesUnapplied ?? []) {
    const observed = u.observed.length > 0
      ? ` 현재 관측값: ${u.observed.map((o) => `${JSON.stringify(o.value)}(${o.files.join(', ')})`).join(' / ')}`
      : '';
    lines.push(`⚠ 사전 미적용 — [${u.label}] "${u.name}".${u.property}: ${u.reason}.${observed}`);
  }
  if (s.propertyConflictTotal > 0) {
    lines.push(`미해결 속성 충돌 ${s.propertyConflictTotal}건(선착 값 유지 중 — 반복되면 property_overrides 등재 후보):`);
    for (const c of s.propertyConflicts) {
      lines.push(`  · [${c.label}] "${c.name}".${c.property}: ${c.values.map((v) => `${JSON.stringify(v.value)}(${v.files.join(', ')})`).join(' vs ')}`);
    }
  }
  if (s.verified && !s.verified.match) {
    lines.push(`⚠ 자기검증 불일치 — 넣으려던 ${s.nodes}·${s.relationships}, DB 실측 ${s.verified.nodes}·${s.verified.relationships}. 다시 실행하세요.`);
  }
  if (s.foreignNodes > 0) lines.push(`도구 외 데이터 ${s.foreignNodes}개 존재 — 건드리지 않음.`);
  if (s.tookOverStaleLock) lines.push('이전 실행이 비정상 종료로 남긴 잠금을 해제하고 진행했습니다.');
  if (s.similarPairTotal > 0) {
    lines.push(`유사 이름 쌍 ${s.similarPairTotal}건(병합 누락 후보 — 같은 대상이면 반려 후 명칭을 통일해 재생성 권장):`);
    for (const p of s.similarPairs) lines.push(`  · [${p.label}] "${p.shorter}" ⊂ "${p.longer}"`);
  }
  if (s.files === 0) lines.push('승인분이 없어 빈 그래프가 되었습니다 — review_approve로 먼저 승인하세요.');
  return lines.join('\n');
}
