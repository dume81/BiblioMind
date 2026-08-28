// capture-golden — 개선 전/후 대조용 기준선 캡처 (유지보수 M1).
//
// 두 가지를 뜬다:
//   (A) Aura 실물 덤프 + examples 원본 대조  → data/backups/aura-<stamp>.json  (data/ 는 커밋 제외)
//   (B) 골든 픽스처(검색 동작 기준선)        → mcp-server/fixtures/golden-searches.json  (커밋 대상)
//
// 결정론 검증: 모든 케이스를 2회 실행해 완전 일치를 확인한다(불일치 시 비정상 종료).
// 주의: MCP 왕복 없이 searchEngine을 직접 호출하므로 data/runtime/last-searches.json(5건 롤링)을 오염시키지 않는다.
//
// 골든 픽스처는 2패스로 뜬다: 패스 A = question 없음(현행 폴백 증거) / 패스 B = 전건 question 부여(적중 경로 무개입 오라클).
//
// 사용법:  node scripts/capture-golden.js [--stamp YYYYMMDDTHHmmss] [--out <REPO 기준 상대경로>]
//          --out 미지정 시 mcp-server/fixtures/golden-searches.json 을 덮어쓴다(개선 전 기준선 보호를 위해 M4 재캡처는 반드시 --out 사용).

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getReadSession, closeDriver } from '../shared/src/neo4jClient.js';
import { runSearch, escapeLucene } from '../mcp-server/src/lib/searchEngine.js';
import { nameKey } from '../shared/src/normalize.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const EXAMPLE_FILE = path.join(REPO, 'examples', 'KG_Demon Slayer_Draft_01.json');
const outArg = process.argv.indexOf('--out');
const FIXTURE_FILE = outArg > -1
  ? path.resolve(REPO, process.argv[outArg + 1]) // REPO 기준 — cwd 기준 경로 금지
  : path.join(REPO, 'mcp-server', 'fixtures', 'golden-searches.json');
const BACKUP_DIR = path.join(REPO, 'data', 'backups');

const stampArg = process.argv.indexOf('--stamp');
/** 기본값은 **실제 실행 시각**이다 — 하드코딩 stamp는 서로 다른 회차의 픽스처를 구별 불가능하게 만든다. */
const STAMP = stampArg > -1
  ? process.argv[stampArg + 1]
  : new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');

/** 픽스처가 자기 출처를 증명하도록 캡처 시점 코드 버전을 함께 기록한다. */
function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/**
 * 판정 21문에서 실제 사용된 키워드 + 손상 프로브 + 오탐 프로브.
 * note = 어느 판정 문항과 연결되는지(추적용).
 */
const CASES = [
  { id: 'S01', keywords: ['귀살대'], note: 'A1 — T1 기대' },
  { id: 'S02', keywords: ['우로코다키 사콘지'], note: 'A2 — T1 확정' },
  { id: 'S03', keywords: ['일륜도'], note: 'A3 정상 표기 — T1 적중(반증 실행 근거)' },
  { id: 'S04', keywords: ['전집중 호흡'], note: 'A4 — T1 확정' },
  { id: 'S05', keywords: ['다이쇼 시대'], note: 'A5 — T1' },
  { id: 'S06', keywords: ['탄지로'], note: 'B1/D2/E2 — T2 확정' },
  { id: 'S07', keywords: ['네즈코'], note: 'B2 — T2. 오탐(하가네즈카 호타루) 관찰 지점' },
  { id: 'S08', keywords: ['기유'], note: 'B3 — T2 확정' },
  { id: 'S09', keywords: ['호타루'], note: 'B4 — T2 확정' },
  { id: 'S10', keywords: ['최종선별'], note: 'B5 — T2' },
  { id: 'S11', keywords: ['사비토'], note: 'C2 — T1 확정' },
  { id: 'S12', keywords: ['마코모'], note: 'C2 — T1 확정' },
  { id: 'S13', keywords: ['카마도 가족'], note: 'C3 — T1 확정' },
  { id: 'S14', keywords: ['재갈'], note: 'C4' },
  { id: 'S15', keywords: ['도깨비'], note: 'B2 보조 — T1 기대' },
  { id: 'S16', keywords: ['사부로 영감'], note: 'E3 — 시드 적중·속성 부재' },
  { id: 'S17', keywords: ['무잔'], note: 'E1 — 부정 대조(unmatched 기대)' },
  { id: 'S18', keywords: ['혈귀'], note: 'E1 정상 표기 — 부재 기대' },
  // ── 손상 프로브: M2 개선 후 S19는 반전(적중), S20은 불변(여전히 부재)이어야 한다 ──
  { id: 'S19', keywords: ['일륨도'], note: '손상 프로브 — 거짓 부재 1호(A3). 개선 후 반전 기대' },
  { id: 'S20', keywords: ['혐귀'], note: '손상 프로브 — 대상 자체 부재. 개선 후에도 불변 기대' },
  // ── 복합 키워드(경로 문항 재현) ──
  { id: 'M01', keywords: ['탄지로', '귀살대'], note: 'C1' },
  { id: 'M02', keywords: ['사비토', '마코모'], note: 'C2' },
  { id: 'M03', keywords: ['네즈코', '재갈'], note: 'C4' },
  { id: 'M04', keywords: ['우로코다키 사콘지', '탄지로'], note: 'C5' },
  { id: 'M05', keywords: ['네즈코', '도깨비'], note: 'B2' },
];

/** 손상 프로브의 실사고 재현 문장. CASES에 넣으면 픽스처 케이스 객체가 바뀌므로 분리한다. */
const PROBE_QUESTIONS = {
  S19: '일륜도가 뭐야?',
  S20: '혈귀가 뭐야?',
};

/** 앵커 패스 질문 — 손상 프로브는 실사고 문장, 나머지는 키워드를 축자 포함(가드4로 복원 무발화). */
function anchorQuestion(c) {
  return PROBE_QUESTIONS[c.id] ?? `${c.keywords.join('와 ')}에 대해 알려줘.`;
}

const sortedKgids = (arr) => arr.map((x) => x.kgid).filter(Boolean).sort();

/** 픽스처에 담을 결정론적 요약으로 축약한다(휘발 필드 제외). */
function digest(result) {
  return {
    seeds: result.seeds.map((s) => ({
      keyword: s.keyword,
      tier: s.tier,
      ...(s.restoredFrom ? { restoredFrom: s.restoredFrom } : {}),
      matched: [...s.matched].sort(),
    })),
    unmatched: [...result.unmatched].sort(),
    layer1: {
      nodeCount: result.nodes.length,
      relCount: result.rels.length,
      truncated: result.truncated,
      nodeKgids: sortedKgids(result.nodes),
      relKgids: sortedKgids(result.rels),
    },
    ftWarning: result.ftWarning,
  };
}

/** T2 원점수 분포 — 점수 하한(50%) 도입 전의 '전' 상태 증거. */
async function t2Probe(session, keyword) {
  const q = escapeLucene(nameKey(keyword));
  try {
    const res = await session.run(
      `CALL db.index.fulltext.queryNodes('kg_fulltext', $q) YIELD node, score
       RETURN node.name AS name, node.kgid AS kgid, score ORDER BY score DESC, name LIMIT 10`,
      { q },
    );
    const rows = res.records.map((r) => ({
      name: r.get('name'),
      kgid: r.get('kgid'),
      score: Number(r.get('score')),
    }));
    if (rows.length === 0) return { hits: [] };
    const top = rows[0].score;
    return {
      topScore: top,
      hits: rows.map((r) => ({ ...r, ratioToTop: Number((r.score / top).toFixed(4)) })),
      // 50% 하한 적용 시 잘려나갈 항목 — 개선 후 실제 결과와 대조할 예측치
      wouldCutAt50: rows.filter((r) => r.score / top < 0.5).map((r) => r.name),
    };
  } catch (err) {
    return { error: String(err.message || err) };
  }
}

async function dumpGraph(session) {
  const nodes = (
    await session.run(
      `MATCH (n:RKEntity) RETURN n.kgid AS kgid, n.name AS name, labels(n) AS labels, properties(n) AS props
       ORDER BY n.kgid`,
    )
  ).records.map((r) => ({
    kgid: r.get('kgid'),
    name: r.get('name'),
    labels: [...r.get('labels')].sort(),
    props: r.get('props'),
  }));

  const rels = (
    await session.run(
      `MATCH (a:RKEntity)-[x]->(b:RKEntity)
       RETURN x.kgid AS kgid, type(x) AS type, a.kgid AS from, b.kgid AS to, properties(x) AS props
       ORDER BY type(x), a.kgid, b.kgid`,
    )
  ).records.map((r) => ({
    kgid: r.get('kgid'),
    type: r.get('type'),
    from: r.get('from'),
    to: r.get('to'),
    props: r.get('props'),
  }));

  return { nodes, rels };
}

function compareWithExample(dump) {
  const src = JSON.parse(readFileSync(EXAMPLE_FILE, 'utf8'));
  const srcNames = src.nodes.map((n) => n.properties?.name).filter(Boolean).sort();
  const dbNames = dump.nodes.map((n) => n.name).filter(Boolean).sort();
  const srcTypes = src.relationships.map((r) => r.type).sort();
  const dbTypes = dump.rels.map((r) => r.type).sort();

  const missing = srcNames.filter((n) => !dbNames.includes(n));
  const extra = dbNames.filter((n) => !srcNames.includes(n));

  return {
    source: path.basename(EXAMPLE_FILE),
    nodeCount: { example: src.nodes.length, aura: dump.nodes.length, match: src.nodes.length === dump.nodes.length },
    relCount: {
      example: src.relationships.length,
      aura: dump.rels.length,
      match: src.relationships.length === dump.rels.length,
    },
    nodeNamesIdentical: JSON.stringify(srcNames) === JSON.stringify(dbNames),
    relTypesIdentical: JSON.stringify(srcTypes) === JSON.stringify(dbTypes),
    missingInAura: missing,
    extraInAura: extra,
  };
}

async function main() {
  const session = getReadSession();
  const log = (...a) => console.log(...a);

  try {
    // ── (A) 실물 덤프 + 원본 대조 ──
    log('[1/4] Aura 실물 덤프...');
    const dump = await dumpGraph(session);
    const comparison = compareWithExample(dump);
    mkdirSync(BACKUP_DIR, { recursive: true });
    const backupPath = path.join(BACKUP_DIR, `aura-${STAMP}.json`);
    writeFileSync(
      backupPath,
      `${JSON.stringify({ capturedStamp: STAMP, comparison, graph: dump }, null, 2)}\n`,
      'utf8',
    );
    log(`      노드 ${dump.nodes.length} · 관계 ${dump.rels.length} → ${path.relative(REPO, backupPath)}`);
    log(`      원본 대조: 노드수 ${comparison.nodeCount.match ? '일치' : '불일치'} · 관계수 ${comparison.relCount.match ? '일치' : '불일치'} · 이름집합 ${comparison.nodeNamesIdentical ? '동일' : '상이'} · 관계유형집합 ${comparison.relTypesIdentical ? '동일' : '상이'}`);

    // ── (B) 골든 픽스처 1회차 — 2패스 ──
    log(`[2/4] 골든 픽스처 캡처 (${CASES.length}케이스 × 2패스, 1회차)...`);
    // (B-1) 패스 A: question 없음 — 완료조건 5(부재 시 무해 폴백)의 증거
    const pass1 = [];
    for (const c of CASES) {
      const r = await runSearch(session, { keywords: c.keywords });
      pass1.push({ ...c, ...digest(r) });
    }
    // (B-2) 앵커 패스: 전건 question 부여 — 완료조건 4(적중 경로 무개입)의 오라클
    const anchoredPass = [];
    for (const c of CASES) {
      const q = anchorQuestion(c);
      const r = await runSearch(session, { keywords: c.keywords, question: q });
      anchoredPass.push({ id: c.id, question: q, ...digest(r) });
    }

    // ── 결정론 검증 (2회차 — 두 패스 모두) ──
    log('[3/4] 결정론 검증 (2회차 실행 후 완전 비교)...');
    const drift = [];
    const same = (result, prev) =>
      JSON.stringify(digest(result)) ===
      JSON.stringify({
        seeds: prev.seeds,
        unmatched: prev.unmatched,
        layer1: prev.layer1,
        ftWarning: prev.ftWarning,
      });
    for (let i = 0; i < CASES.length; i += 1) {
      const rA = await runSearch(session, { keywords: CASES[i].keywords });
      if (!same(rA, pass1[i])) drift.push(`A:${CASES[i].id}`);
      const rB = await runSearch(session, { keywords: CASES[i].keywords, question: anchorQuestion(CASES[i]) });
      if (!same(rB, anchoredPass[i])) drift.push(`B:${CASES[i].id}`);
    }
    if (drift.length > 0) {
      console.error(`✗ 결정론 위반 — 두 실행 결과가 다름: ${drift.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    log(`      ✓ ${CASES.length}케이스 × 2패스 전건 2회 실행 완전 일치`);

    // ── T2 원점수 분포 (단일 키워드만) ──
    log('[4/4] T2 원점수 분포 캡처 (점수 하한 도입 전 기준선)...');
    const t2 = {};
    for (const c of CASES.filter((x) => x.keywords.length === 1)) {
      t2[c.keywords[0]] = await t2Probe(session, c.keywords[0]);
    }

    mkdirSync(path.dirname(FIXTURE_FILE), { recursive: true });
    writeFileSync(
      FIXTURE_FILE,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          capturedStamp: STAMP,
          purpose: outArg > -1
            ? `${path.relative(REPO, FIXTURE_FILE)} — ${STAMP} 캡처. 개선 전 기준선은 mcp-server/fixtures/golden-searches.json이며 이 파일이 그 대조본이다.`
            : '유지보수 M2(질문 원문 앵커 복원 + T2 점수 하한 50%) 적용 전 기준선. M4 재판정에서 이 파일과 대조한다.',
          capturedAt: new Date().toISOString(),
          gitHead: gitHead(),
          graphSnapshot: {
            nodeCount: dump.nodes.length,
            relCount: dump.rels.length,
            relTypeCount: new Set(dump.rels.map((r) => r.type)).size,
          },
          comparison,
          determinism: { passes: 2, identical: true, caseCount: CASES.length, anchoredCaseCount: anchoredPass.length },
          cases: pass1,
          anchoredCases: anchoredPass,
          t2RawScores: t2,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    log(`      → ${path.relative(REPO, FIXTURE_FILE)}`);

    // 요약
    const hit = pass1.filter((c) => c.seeds.length > 0).length;
    log('\n──────────── 요약 ────────────');
    const hitB = anchoredPass.filter((c) => c.seeds.length > 0).length;
    log(`시드 적중 케이스 : 패스 A ${hit}/${CASES.length} · 패스 B ${hitB}/${CASES.length}`);
    log(`패스 A 미적중    : ${pass1.filter((c) => c.seeds.length === 0).map((c) => `${c.id}(${c.keywords.join('+')})`).join(', ') || '없음'}`);
    log(`패스 B 미적중    : ${anchoredPass.filter((c) => c.seeds.length === 0).map((c) => c.id).join(', ') || '없음'}`);
    const restored = anchoredPass.flatMap((c) => c.seeds.filter((s) => s.restoredFrom).map((s) => `${c.id}:${s.restoredFrom}→${s.keyword}`));
    log(`패스 B 복원 발화 : ${restored.join(', ') || '없음'}`);
  } finally {
    await session.close();
    await closeDriver();
  }
}

await main();
