// check-absence — 모델이 "그래프에 없다"고 답한 주장을 Aura 직접 조회로 역검증한다.
//
// 판정 합격선 "거짓 부재 0건"의 **두 절차 중 두 번째**다(첫째는 check-keywords survey).
// 부재 주장은 3유형이며 셋 다 검사한다: 노드 부재 · 속성 부재 · 관계 부재.
//
// 왜 저장소 도구인가(2026-08-22 승격): M4에서는 scratchpad의 일회용 스크립트로 돌렸다.
// 그 결과 ① 다음 판정 회차에서 다시 쓸 수 없고 ② 그 스크립트의 결함이 버전 관리·리뷰를
// 거치지 않았다. 실제로 정규식이 `role`을 성격 계열로 묶어 **오탐 1건**을 냈다
// (카마도 탄지로의 role 값은 "주인공" — 역할이지 성격이 아니다).
//
// 사용법: node scripts/check-absence.js [--fixture <경로>] [--json]
// 필요: 살아 있는 Aura(.env). 종료 코드 0 = 부재 주장 전건 사실 / 1 = 반증(거짓 부재) 또는 미측정.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getReadSession, closeDriver } from '../shared/src/neo4jClient.js';
import { nameKey } from '../shared/src/normalize.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const fixtureArg = process.argv.indexOf('--fixture');
const FIXTURE = fixtureArg > -1
  ? path.resolve(REPO, process.argv[fixtureArg + 1])
  : path.join(REPO, 'mcp-server', 'fixtures', 'absence-claims.json');
const asJson = process.argv.includes('--json');

// ── 속성 계열 사전 ───────────────────────────────────────────────────
// 넓은 정규식 하나로 묶지 않는다. "성격이 없다"는 주장은 **성격 계열 키만** 봐야 한다.
// M4 오탐의 원인이 정확히 이것이었다: /occupation|job|role|personality|.../ 하나로
// 묶는 바람에 role="주인공"이 채워져 있다는 이유로 "성격 속성이 있다"고 반증 처리했다.
const PROP_FAMILIES = {
  성격: ['personality', 'character', 'trait', 'temperament', '성격', '성품', '기질'],
  직업: ['occupation', 'job', 'profession', 'vocation', '직업', '직무', '생업'],
  역할: ['role', 'position', '역할', '배역', '직위'],
  설명: ['summary', 'description', 'desc', 'detail', 'about', '설명', '요약', '소개'],
  나이: ['age', 'birthyear', '나이', '연령'],
  출신: ['origin', 'birthplace', 'hometown', 'residence', '출신', '고향', '거주지'],
  능력: ['ability', 'skill', 'power', 'technique', '능력', '기술', '호흡'],
};

/** 계열명을 찾는다. 사전에 없으면 null — 추측하지 않는다(제6조). */
function familyOf(prop) {
  const p = String(prop).toLowerCase();
  if (PROP_FAMILIES[prop]) return prop;
  for (const [name, aliases] of Object.entries(PROP_FAMILIES)) {
    if (aliases.some((a) => a.toLowerCase() === p)) return name;
  }
  return null;
}

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const rows = [];
const mark = (verdict, type, subject, detail) => rows.push({ verdict, type, subject, detail });

const session = getReadSession();
try {
  // ── 유형 1: 노드 부재 ──
  for (const c of fixture.nodeAbsent ?? []) {
    const kw = nameKey(c.name);
    const r = await session.run(
      'MATCH (n:RKEntity) WHERE n.name_key = $kw OR n.name_key CONTAINS $kw RETURN n.name AS name LIMIT 5',
      { kw },
    );
    const hits = r.records.map((x) => x.get('name'));
    mark(hits.length === 0 ? '사실' : '반증', '노드 부재', c.name,
      hits.length ? `발견: ${hits.join(', ')} ← 거짓 부재` : '정확·부분 일치 0건');
  }

  // ── 유형 2: 속성 부재 ──
  for (const c of fixture.propAbsent ?? []) {
    const family = familyOf(c.prop);
    if (family === null) {
      mark('미측정', '속성 부재', `${c.node}.${c.prop}`,
        `속성 계열 사전에 "${c.prop}"이 없다 — 어떤 키를 봐야 하는지 모른다. 사전에 계열을 추가한 뒤 재실행할 것`);
      continue;
    }
    const kw = nameKey(c.node);
    const r = await session.run(
      'MATCH (n:RKEntity) WHERE n.name_key = $kw RETURN properties(n) AS props LIMIT 1',
      { kw },
    );
    if (r.records.length === 0) {
      mark('반증', '속성 부재', `${c.node}.${c.prop}`, '노드 자체가 없음 — 주장의 전제가 틀렸다');
      continue;
    }
    const props = r.records[0].get('props');
    const aliases = PROP_FAMILIES[family].map((a) => a.toLowerCase());
    const filled = Object.keys(props).filter((k) =>
      aliases.includes(k.toLowerCase())
      && props[k] !== null && props[k] !== undefined && String(props[k]).trim() !== '');
    mark(filled.length === 0 ? '사실' : '반증', '속성 부재', `${c.node}.${c.prop}`,
      `계열 "${family}" 별칭 [${PROP_FAMILIES[family].join(', ')}] · 보유 키 [${Object.keys(props).join(', ')}]`
      + (filled.length ? ` · 채워진 계열 키 ${filled.map((k) => `${k}="${props[k]}"`).join(', ')} ← 거짓 부재` : ' · 계열 키 0건'));
  }

  // ── 유형 3: 관계 부재 ──
  for (const c of fixture.relAbsent ?? []) {
    const kw = nameKey(c.node);
    const r = await session.run(
      'MATCH (n:RKEntity)-[x]-(:RKEntity) WHERE n.name_key = $kw RETURN DISTINCT type(x) AS t ORDER BY t',
      { kw },
    );
    const types = r.records.map((x) => x.get('t'));
    const re = new RegExp(c.pattern, 'i');
    const found = types.filter((t) => re.test(t));
    mark(found.length === 0 ? '사실' : '반증', '관계 부재', `${c.node} ~ /${c.pattern}/`,
      `인접 관계 유형 ${types.length}종 [${types.join(', ')}]`
      + (found.length ? ` · 패턴 적중 ${found.join(', ')} ← 거짓 부재` : ' · 패턴 적중 0건'));
  }
} finally {
  await session.close();
  await closeDriver();
}

const counts = { 사실: 0, 반증: 0, 미측정: 0 };
for (const r of rows) counts[r.verdict] += 1;
const pass = counts.반증 === 0 && counts.미측정 === 0;

if (asJson) {
  console.log(JSON.stringify({ verdict: { ...counts, total: rows.length, pass }, rows }, null, 2));
} else {
  console.log(`[check-absence] 부재 주장 ${rows.length}건 (픽스처 ${fixture.capturedStamp ?? '?'})`);
  console.log('');
  for (const r of rows) {
    const glyph = r.verdict === '사실' ? '✓' : r.verdict === '반증' ? '✗' : '?';
    console.log(`  ${glyph} [${r.type}] ${r.subject}`);
    console.log(`      ${r.detail}`);
  }
  console.log('');
  console.log(pass
    ? `  ✓ 전건 사실 확인 ${counts.사실}/${rows.length} — 거짓 부재 0건`
    : `  ✗ 사실 ${counts.사실} · 반증 ${counts.반증}(거짓 부재!) · 미측정 ${counts.미측정}`);
  if (counts.미측정 > 0) console.log('     미측정이 남아 있으면 "거짓 부재 0건"을 주장할 수 없다(8조 제4조).');
}
process.exitCode = pass ? 0 : 1;
