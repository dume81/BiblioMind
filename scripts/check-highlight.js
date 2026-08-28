// check-highlight — 판정 항목 ④(3상태 표시)를 육안이 아니라 기계로 대조한다 (유지보수 M4).
//
// 대조 대상:
//   (푸시한 것) data/runtime/last-searches.json 의 해당 검색 레코드
//   (화면이 아는 것) 3D 앱 전역 window.__bibliomind 스냅샷 (TECH-SPEC §7.9)
//
// 사용법:
//   1) 크롬 개발자도구 콘솔에서:  copy(JSON.stringify(window.__bibliomind))
//      또는 판정 세션의 브라우저 도구로 같은 값을 파일로 저장
//   2) node scripts/check-highlight.js --snapshot <파일경로>
//      (파일 대신 - 를 주면 표준입력에서 읽는다)
//
// 한계(§7.9): 이 도구는 "앱이 어느 집합을 어느 상태로 판정했는가"까지 증명한다.
// 판정이 실제로 그 색으로 칠해졌는지는 증명하지 않는다 — 그 구간은 육안 몫이다.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const RUNTIME_FILE = path.join(REPO, 'data', 'runtime', 'last-searches.json');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
}

function readSnapshot() {
  const src = arg('--snapshot');
  if (!src) {
    console.error('✗ --snapshot <파일경로|-> 가 필요합니다. 사용법은 이 파일 머리 주석 참조.');
    process.exit(2);
  }
  const raw = src === '-' ? readFileSync(0, 'utf8') : readFileSync(path.resolve(process.cwd(), src), 'utf8');
  const parsed = JSON.parse(raw);
  // window.__bibliomind를 JSON.stringify로 두 번 감싼 경우(문자열)도 받아준다.
  return typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
}

const rows = [];
const check = (name, expected, actual) => {
  rows.push({ ok: JSON.stringify(expected) === JSON.stringify(actual), name, expected, actual });
};
const sorted = (a) => [...a].sort();
const subset = (a, b) => a.every((x) => b.includes(x));

const snap = readSnapshot();
if (snap === null) {
  console.error('✗ 스냅샷이 null입니다 — 화면에 하이라이트가 없습니다. 검색을 먼저 실행하세요.');
  process.exit(1);
}

const searches = JSON.parse(readFileSync(RUNTIME_FILE, 'utf8')).searches;
const wantedId = arg('--search-id') ?? snap.searchId;
const record = searches.find((s) => s.searchId === wantedId);
if (!record) {
  console.error(`✗ runtime 기록에서 searchId ${wantedId} 를 찾지 못했습니다 (보관 ${searches.length}건: ${searches.map((s) => s.searchId).join(', ')}).`);
  console.error('  5건 롤링이라 오래된 검색은 밀려납니다 — 판정 직후에 대조하세요.');
  process.exit(1);
}

const pushedNodeKgids = sorted(Object.values(record.nodes).map((n) => n.kgid));
const pushedRelKgids = sorted(Object.values(record.rels).map((r) => r.kgid));

console.log(`검색 ${record.searchId} · 질문 "${record.question ?? '(없음)'}"`);
console.log(`푸시: 1층 노드 ${pushedNodeKgids.length} · 관계 ${pushedRelKgids.length}\n`);

// ── 1. 화면이 아는 집합 == 푸시한 집합 ──
check('searchId 일치', record.searchId, snap.searchId);
check('질문 원문 일치', record.question ?? null, snap.question);
check('1층 노드 집합 일치', pushedNodeKgids, sorted(snap.layer1.nodeKgids));
check('1층 관계 집합 일치', pushedRelKgids, sorted(snap.layer1.relKgids));
check('N(총수) 일치', pushedNodeKgids.length + pushedRelKgids.length, snap.total);
check('truncated 일치', Boolean(record.truncated), Boolean(snap.truncated));

// ── 2. 2층 규약 — 2층은 1층의 부분집합이어야 한다(1층 구성상 dangling 없음, §6.5.4) ──
check('2층 노드 ⊆ 1층 노드', true, subset(snap.layer2.nodeKgids, snap.layer1.nodeKgids));
check('2층 관계 ⊆ 1층 관계', true, subset(snap.layer2.relKgids, snap.layer1.relKgids));

// ── 3. 실제 렌더 상태 — 2층 우선 규칙(§7.4)이 반영됐는가 ──
const overlapNodes = snap.rendered.layer1.nodeKgids.filter((k) => snap.rendered.layer2.nodeKgids.includes(k));
const overlapRels = snap.rendered.layer1.relKgids.filter((k) => snap.rendered.layer2.relKgids.includes(k));
check('렌더 1층·2층 겹침 없음', [[], []], [overlapNodes, overlapRels]);

const renderedTotal = snap.rendered.layer1.nodeKgids.length + snap.rendered.layer1.relKgids.length
  + snap.rendered.layer2.nodeKgids.length + snap.rendered.layer2.relKgids.length;
if (snap.active) {
  check('M(매칭수) == 실제 렌더 총수', snap.matched, renderedTotal);
} else {
  check('비활성 시 렌더 집합 비어 있음', 0, renderedTotal);
}

// ── 4. citation 상태 ↔ 2층 존재 정합 ──
const hasLayer2 = snap.layer2.nodeKgids.length + snap.layer2.relKgids.length > 0;
if (snap.citation?.status === 'verified' || snap.citation?.status === 'partial') {
  check(`citation=${snap.citation.status} → 2층 존재`, true, hasLayer2);
} else {
  check(`citation=${snap.citation?.status ?? '없음'} → 2층 없음`, false, hasLayer2);
}

let fail = 0;
for (const r of rows) {
  if (!r.ok) fail += 1;
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}`);
  if (!r.ok) {
    console.log(`    기대: ${JSON.stringify(r.expected)}`);
    console.log(`    실측: ${JSON.stringify(r.actual)}`);
  }
}

// N > M 은 결함이 아니다 — 현재 렌더 데이터에 없는 kgid(필터 숨김·낡은 그래프)의 내역이다(§7.9).
if (snap.total > snap.matched) {
  const missingN = snap.layer1.nodeKgids.filter((k) => !snap.rendered.layer1.nodeKgids.includes(k) && !snap.rendered.layer2.nodeKgids.includes(k));
  const missingR = snap.layer1.relKgids.filter((k) => !snap.rendered.layer1.relKgids.includes(k) && !snap.rendered.layer2.relKgids.includes(k));
  console.log(`\nℹ N/M 격차 ${snap.total - snap.matched}건 — 결함이 아니라 화면에 없는 kgid의 내역입니다(필터 숨김·낡은 그래프).`);
  console.log(`  노드 ${missingN.length}: ${missingN.join(', ') || '없음'}`);
  console.log(`  관계 ${missingR.length}: ${missingR.join(', ') || '없음'}`);
}

console.log(`\n판정 ④: ${rows.length - fail}/${rows.length} 통과${fail ? ` — 미달 ${fail}건` : ''}`);
process.exitCode = fail ? 1 : 0;
