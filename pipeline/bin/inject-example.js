#!/usr/bin/env node
// 스파이크용 최소 주입 (TECH-SPEC §1.14 슬라이스 0.5) — kg_rebuild(슬라이스 7)의 씨앗 코드.
// 범위: examples JSON 1개 → RKEntity + kgid·name_key·출처 속성(더미) 주입 + 인덱스 2종 생성.
// 병합·원장 상태 관리·체크포인트는 불요(§1.14). 예외: buildId 원장 기록(§3.5-5 축소 이행 — 총감사 확정).
// 멱등성(총감사 확정): delete-then-inject — §2.3.4 이중 방벽 삭제를 선행하므로
// 몇 번을 실행해도 결과가 같다(완료 판정 = 2회 연속 실행 후 노드 29·관계 55 동일).
import fs from 'node:fs';
import path from 'node:path';
import neo4j from 'neo4j-driver';
import { loadEnv } from '../../shared/src/env.js';
import { REPO_ROOT, SCHEMA_DEFAULT_FILE, ensureDataDirs } from '../../shared/src/paths.js';
import { nameKey, nodeKgid, relKgid } from '../../shared/src/normalize.js';
import { normalizeCanonicalGraph } from '../../shared/src/canonicalGraph.js';
import { validateKgSchema, NODE_LABEL_RULE, RELATIONSHIP_RULE } from '../../shared/src/kgSchemaValidate.js';

const EXAMPLE_FILE = path.join(REPO_ROOT, 'examples', 'KG_Demon Slayer_Draft_01.json');
/** 더미 출처 — 결정적 고정값 (§2.3.1 배열 형식, 총감사 확정). */
const DUMMY_SOURCE = ['KG_Demon Slayer_Draft_01.json'];

function fail(message) {
  console.error(`[bibliomind] inject-example 실패: ${message}`);
  process.exit(1);
}

loadEnv();
const { NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD } = process.env;
const database = process.env.NEO4J_DATABASE || 'neo4j';
if (!NEO4J_URI || !NEO4J_PASSWORD || NEO4J_PASSWORD === 'replace-me') {
  fail('.env의 Neo4j 접속 정보가 없습니다 — npm run setup으로 상태를 확인하세요.');
}

// ── 1. 로드 + 검증 프리플라이트 (구조 → 스키마, requireMeta:false — 예시엔 meta 없음) ──
const raw = JSON.parse(fs.readFileSync(EXAMPLE_FILE, 'utf8'));
const structural = normalizeCanonicalGraph(raw);
if (!structural.ok) fail(`구조 검증 실패:\n- ${structural.errors.join('\n- ')}`);

const paths = ensureDataDirs();
const schemaFile = fs.existsSync(paths.schemaFile) ? paths.schemaFile : SCHEMA_DEFAULT_FILE;
const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
const validated = validateKgSchema(structural.graph, schema, { requireMeta: false });
if (!validated.ok) fail(`스키마 검증 실패:\n- ${validated.errors.join('\n- ')}`);
const doc = validated.doc;

// ── 2. kgid·name_key·시스템 속성 산출 (라벨 보간 전 명명 규칙 게이트) ──
const nodesByLabel = new Map(); // label → rows
const kgidByLocalId = new Map(); // 파일 내 로컬 id → kgid
const mergeKeys = new Set();
for (const node of doc.nodes) {
  if (!NODE_LABEL_RULE.test(node.label)) fail(`라벨 보간 게이트: "${node.label}" 명명 규칙 위반`);
  const key = nameKey(node.properties.name);
  const mergeKey = `${node.label}\u001f${key}`;
  if (mergeKeys.has(mergeKey)) fail(`병합 충돌 감지: (${node.label}, ${key}) — 최소 주입 범위 밖(kg_rebuild 필요)`);
  mergeKeys.add(mergeKey);
  const kgid = nodeKgid(node.label, key);
  kgidByLocalId.set(node.id, kgid);
  const props = {
    ...node.properties,
    name_key: key,
    kgid,
    reviewed_files: DUMMY_SOURCE,
    input_files: DUMMY_SOURCE,
  };
  if (!nodesByLabel.has(node.label)) nodesByLabel.set(node.label, []);
  nodesByLabel.get(node.label).push({ props });
}

const relsByType = new Map(); // type → rows
const relKeys = new Set();
for (const rel of doc.relationships) {
  if (!RELATIONSHIP_RULE.test(rel.type)) fail(`관계 유형 보간 게이트: "${rel.type}" 명명 규칙 위반`);
  const fromKgid = kgidByLocalId.get(rel.start_node_id);
  const toKgid = kgidByLocalId.get(rel.end_node_id);
  const dedupeKey = `${fromKgid}\u001f${rel.type}\u001f${toKgid}`;
  if (relKeys.has(dedupeKey)) continue; // 중복 관계 제거(§2.3.2) — 예시 데이터 실측 0건
  relKeys.add(dedupeKey);
  const kgid = relKgid(fromKgid, rel.type, toKgid);
  const props = { ...rel.properties, kgid, reviewed_files: DUMMY_SOURCE, input_files: DUMMY_SOURCE };
  if (!relsByType.has(rel.type)) relsByType.set(rel.type, []);
  relsByType.get(rel.type).push({ fromKgid, toKgid, props });
}

// ── 3. 주입: 이중 방벽 삭제 → 노드 → 관계 → 인덱스 → 자기검증 ──
const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USERNAME || 'neo4j', NEO4J_PASSWORD));
const session = driver.session({ database });
try {
  // §2.3.4 이중 방벽: 시스템 라벨 + 출처 속성 둘 다 가진 것만 삭제 (도구 외 데이터 불가침)
  await session.run('MATCH (n:RKEntity) WHERE n.reviewed_files IS NOT NULL DETACH DELETE n');

  for (const [label, rows] of nodesByLabel) {
    await session.run(
      `UNWIND $rows AS row CREATE (n:RKEntity:\`${label}\`) SET n = row.props`,
      { rows },
    );
  }
  for (const [type, rows] of relsByType) {
    await session.run(
      `UNWIND $rows AS row
       MATCH (a:RKEntity { kgid: row.fromKgid }), (b:RKEntity { kgid: row.toKgid })
       CREATE (a)-[r:\`${type}\`]->(b) SET r = row.props`,
      { rows },
    );
  }

  // 인덱스 2종 (§2.3.3·§6.2.4) — 분석기 불일치 시 DROP 후 재생성
  await session.run('CREATE RANGE INDEX kg_name_key IF NOT EXISTS FOR (n:RKEntity) ON (n.name_key)');
  const idx = await session.run("SHOW INDEXES YIELD name, options WHERE name = 'kg_fulltext' RETURN options");
  const analyzer = idx.records[0]?.get('options')?.indexConfig?.['fulltext.analyzer'];
  if (idx.records.length > 0 && analyzer !== 'cjk') {
    await session.run('DROP INDEX kg_fulltext');
  }
  await session.run(
    "CREATE FULLTEXT INDEX kg_fulltext IF NOT EXISTS FOR (n:RKEntity) ON EACH [n.name] OPTIONS { indexConfig: { `fulltext.analyzer`: 'cjk' } }",
  );
  await session.run('CALL db.awaitIndexes(300)'); // population 대기 — 직후 T2 검증 0건 방지

  // buildId 원장 기록 (§3.5-5 축소 이행) — 원자적 쓰기(§2.5 스테이징)
  const buildId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', 'T');
  let ledger = { version: 1, sources: {} };
  if (fs.existsSync(paths.ledgerFile)) ledger = JSON.parse(fs.readFileSync(paths.ledgerFile, 'utf8'));
  ledger.build = { buildId, at: new Date().toISOString(), source: 'inject-example', counts: null };

  // ── 자기검증 (ROADMAP #0.5 완료 조건의 판정 출력) ──
  const nodeCount = (await session.run('MATCH (n:RKEntity) RETURN count(n) AS c')).records[0].get('c').toInt();
  const relCount = (await session.run('MATCH (:RKEntity)-[r]->(:RKEntity) WHERE r.kgid IS NOT NULL RETURN count(r) AS c')).records[0].get('c').toInt();
  const indexes = await session.run("SHOW INDEXES YIELD name, type, state WHERE name IN ['kg_name_key','kg_fulltext'] RETURN name, type, state ORDER BY name");
  const analyzers = await session.run('CALL db.index.fulltext.listAvailableAnalyzers() YIELD analyzer RETURN collect(analyzer) AS a');
  const hasCjk = analyzers.records[0].get('a').includes('cjk');

  ledger.build.counts = { nodes: nodeCount, relationships: relCount };
  const staging = path.join(paths.staging, 'ledger.json');
  fs.writeFileSync(staging, JSON.stringify(ledger, null, 2));
  fs.renameSync(staging, paths.ledgerFile);

  console.log('[bibliomind] inject-example 자기검증 결과');
  console.log('─'.repeat(60));
  console.log(`✓ 주입: 노드 ${nodeCount} · 관계 ${relCount} (기대: 29 · 55)`);
  for (const record of indexes.records) {
    console.log(`✓ 인덱스: ${record.get('name')} (${record.get('type')}) — ${record.get('state')}`);
  }
  console.log(`✓ cjk 분석기: ${hasCjk ? '존재' : '없음(경고 — T2 검색 비활성)'}`);
  console.log(`✓ buildId: ${buildId} (원장 기록)`);
  console.log('─'.repeat(60));
  console.log('재실행 안전(멱등): 같은 명령을 다시 실행해도 같은 수치가 나와야 정상입니다.');
  if (nodeCount !== 29 || relCount !== 55) {
    console.error('✗ 기대 수치 불일치 — 판정 실패');
    process.exit(1);
  }
} finally {
  await session.close();
  await driver.close();
}
