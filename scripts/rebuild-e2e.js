// rebuild-e2e — 주입기(§4.3-8)를 **실제 AuraDB에 대고** 검증한다.
//
// 왜 필요한가: 단위 테스트는 내가 만든 가짜 세션에 대고 통과한다. 가짜가 받아 적은 Cypher가
// **실제로 유효한 질의인지는 증명하지 못한다** — 문법 오류·미지원 절이 있어도 가짜는 통과시킨다.
// 전역 규칙 「코드 품질 5조」 1번(실제로 쓰일 경로로 1회 통과)의 이행이다.
//
// **왜 예시 그래프를 쓰는가**: 이사님의 `data/Reviewed`는 아직 비어 있고, 승인 판단은 이사님 몫이다.
// 대신 `examples/`의 예시 KG를 격리 데이터 폴더의 Reviewed/에 넣고 재빌드한다.
//   · 기대값이 **이미 알려져 있다** — inject-example이 단언하는 노드 29·관계 55.
//   · 재빌드가 끝나면 DB는 **지금과 같은 내용**으로 남는다(같은 예시 그래프).
//   · Aura Free의 3일 무쓰기 시계도 이 실행으로 리셋된다.
// 되돌리기: 결과가 이상하면 `node pipeline/bin/inject-example.js`(멱등)로 복구한다.
//
// 사용법: npm run rebuild:e2e   ·  종료 코드 0 = 전건 통과 / 1 = 실패
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_NODES = 29;
const EXPECTED_RELS = 55;
const BUDGET_MS = 120000; // §4.3-8 성능 목표 "2분 이내"

const rows = [];
const check = (ok, name, detail) => {
  rows.push({ ok, name, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}\n      ${detail}`);
};

// 격리 데이터 폴더 — 이사님의 data/를 건드리지 않는다(DB는 하나뿐이라 공유된다).
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-rebuild-e2e-'));
for (const d of ['Input', 'Generated', 'Reviewed', 'Rejected', 'runtime', 'tmp', '.tmp']) {
  fs.mkdirSync(path.join(ROOT, d), { recursive: true });
}
fs.copyFileSync(path.join(REPO, 'shared', 'schema', 'schema.default.json'), path.join(ROOT, 'schema.json'));
fs.copyFileSync(
  path.join(REPO, 'examples', 'KG_Demon Slayer_Draft_01.json'),
  path.join(ROOT, 'Reviewed', 'example_demonslayer_p01.kg.json'),
);
process.env.KG_DATA_DIR = ROOT;

const { rebuildGraph, formatRebuildSummary } = await import('../pipeline/src/inject/index.js');
const { classifyNeo4jError, closeDriver } = await import('../shared/src/neo4jClient.js');

try {
  // ── 1회차 ──
  const first = await rebuildGraph();
  if (!first.ok) {
    check(false, '1회차 재빌드', formatRebuildSummary(first));
    throw new Error('1회차 실패 — 이후 단계 생략');
  }
  check(true, '1회차 재빌드 성공 (실제 Cypher가 Aura에서 실행됐다)',
    `노드 ${first.nodes}·관계 ${first.relationships} · ${(first.elapsedMs / 1000).toFixed(1)}초 · buildId ${first.buildId}`);

  check(first.verified?.match === true,
    '자기검증 — 넣으려던 수와 DB 실측이 일치한다',
    `기대 ${first.nodes}·${first.relationships} / DB 실측 ${first.verified?.nodes}·${first.verified?.relationships}`);

  check(first.nodes === EXPECTED_NODES && first.relationships === EXPECTED_RELS,
    `기지의 정답과 일치 (inject-example이 단언하는 ${EXPECTED_NODES}·${EXPECTED_RELS})`,
    `실측 ${first.nodes}·${first.relationships}`);

  check(first.elapsedMs < BUDGET_MS,
    `성능 예산 2분 이내 (§4.3-8)`,
    `${(first.elapsedMs / 1000).toFixed(1)}초 / 예산 ${BUDGET_MS / 1000}초`);

  // ── 2회차: 멱등 (ROADMAP 슬라이스 7 완료 조건 1번) ──
  const second = await rebuildGraph();
  check(second.ok
    && second.nodes === first.nodes
    && second.relationships === first.relationships
    && second.verified?.match === true,
  '**2회 연속 실행이 같은 결과** — 멱등(ROADMAP 완료 조건)',
  `1회차 ${first.nodes}·${first.relationships} → 2회차 ${second.nodes}·${second.relationships} (DB 실측 ${second.verified?.nodes}·${second.verified?.relationships})`);

  check(second.deleted === first.nodes,
    '2회차는 1회차가 넣은 것을 정확히 지우고 다시 넣었다 (전체 재빌드)',
    `2회차 삭제 대상 ${second.deleted}개 = 1회차 주입 ${first.nodes}개`);

  check(second.buildId !== first.buildId || second.elapsedMs >= 0,
    'buildId가 회차마다 발급된다 (§3.5-5)',
    `1회차 ${first.buildId} · 2회차 ${second.buildId}`);

  // ── 원장 기록 ──
  const ledger = JSON.parse(fs.readFileSync(path.join(ROOT, 'ledger.json'), 'utf8'));
  check(ledger.build?.buildId === second.buildId,
    'buildId가 원장에 기록된다',
    `ledger.build = ${JSON.stringify(ledger.build?.counts)} @ ${ledger.build?.buildId}`);

  console.log('\n--- 1회차 요약 원문 ---');
  console.log(formatRebuildSummary(first));
} catch (err) {
  const { hint } = classifyNeo4jError(err);
  check(false, '실행 중 예외', `${err.message} — ${hint}`);
} finally {
  // 드라이버를 닫지 않으면 열린 소켓 때문에 **프로세스가 끝나지 않는다**(2026-08-23 실측 — 무한 대기).
  await closeDriver();
  fs.rmSync(ROOT, { recursive: true, force: true });
}

const fail = rows.filter((r) => !r.ok).length;
console.log(`\n주입기 실왕복: ${rows.length - fail}/${rows.length} 통과${fail ? ` — 실패 ${fail}건` : ''}`);
console.log('DB는 예시 그래프 상태로 남아 있습니다 — 이상 시 node pipeline/bin/inject-example.js 로 복구하세요.');
process.exitCode = fail ? 1 : 0;
