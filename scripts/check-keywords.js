// check-keywords — 챗 LLM이 생성한 한글 키워드의 손상 계측기 (유지보수 M1).
//
// TECH-SPEC §1.14 가정 7 반증분의 상시 계측 수단. 챗 모델이 질문에 등장한 이름을
// 자모 수준에서 손상시켜 도구에 넘기면 "그래프에 있는데 없다"는 거짓 부재가 생긴다.
// 이 도구는 (question, keywords) 쌍을 자모 편집거리로 대조해 그 손상을 사후 검출한다.
//
// 런타임 복원(§6.2.3 pickAnchorCandidate)과 같은 판정 함수를 쓴다 — 구현이 갈리면
// "계측기는 잡았는데 런타임은 못 고친다"(또는 그 반대)가 되므로 단일 구현을 공유한다.
//
// 입력: mcp-server/fixtures/keyword-probes.json (판정 시점 기록의 고정본, DB·네트워크 불요)
// 사용법: node scripts/check-keywords.js [--json]
// 종료 코드: 0 = known-answer 통과 / 1 = 통과 실패(회귀)

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pickAnchorCandidate, ANCHOR_MIN_KEYWORD_CHARS } from '../mcp-server/src/lib/searchEngine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const fixtureArg = process.argv.indexOf('--fixture');
const FIXTURE = fixtureArg > -1
  ? path.resolve(REPO, process.argv[fixtureArg + 1])
  : path.join(REPO, 'mcp-server', 'fixtures', 'keyword-probes.json');

const asJson = process.argv.includes('--json');

/**
 * 프로브 1건의 키워드를 전부 검사한다.
 * @param {{ question: string | null, keywords: string[], ts: string | null }} probe
 * @returns {Array<{ keyword: string, question: string | null, suspected: string | null, reason: string }>}
 */
function inspectProbe(probe) {
  return probe.keywords.map((keyword) => {
    const suspected = pickAnchorCandidate(keyword, probe.question);
    let reason = '무경보';
    if (suspected !== null) reason = '손상 의심 — 질문에 자모 1자 차이 표기가 있음';
    else if ([...String(keyword)].length < ANCHOR_MIN_KEYWORD_CHARS) reason = `무경보(${ANCHOR_MIN_KEYWORD_CHARS}글자 미만은 검사 대상 아님)`;
    return { keyword, question: probe.question, suspected, reason };
  });
}

/**
 * survey 모드 — 정답이 미리 정해지지 않은 새 판정 회차의 조사.
 * known-answer 모드와 판정 규칙이 다르다: 손상 의심 자체는 실패가 아니다(런타임 복원이 살렸을 수 있다).
 * **실패는 "손상 의심인데 복원도 안 됐고 시드도 0건"인 건**뿐이며, 그것이 거짓 부재 후보다.
 */
function surveyMain(fixture) {
  const suspects = [];
  for (const probe of fixture.probes) {
    for (const row of inspectProbe(probe)) {
      if (row.suspected === null) continue;
      const restored = (probe.restoredFrom ?? []).includes(row.keyword);
      // **키워드 단위**로 본다. 호출 단위 seedCount로 판정하면 다중 키워드 호출에서
      // 다른 키워드의 시드에 가려 손상 키워드의 미적중이 은폐된다(실측 재현: keywords=['네즈코','일륨도']
      // → seedCount 5라서 '무해'로 통과했으나 '일륨도'는 unmatched에 있었다).
      const unmatchedList = Array.isArray(probe.unmatched) ? probe.unmatched : null;
      const missed = unmatchedList
        ? unmatchedList.includes(row.keyword)
        : (probe.seedCount ?? 0) === 0; // unmatched가 없는 낡은 픽스처용 폴백
      // 수집기가 도구 출력을 못 읽은 호출은 **미측정**이다(A1, 2026-08-22).
      // 이전 판은 파싱 실패가 seedCount:0·unmatched:[] 로 기록돼 여기서 "시드를 얻음(무해)"으로
      // 분류됐다 — 즉 읽기 실패가 거짓 부재 후보를 조용히 지워 버렸다. 이제는 세 번째 값으로 센다.
      const unmeasured = probe.parseFailed === true;
      suspects.push({ ...row, restored, missed, unmeasured, seedCount: probe.seedCount ?? null, seedTiers: probe.seedTiers ?? [], ts: probe.ts });
    }
  }
  const tokens = fixture.probes.reduce((s, p) => s + p.keywords.length, 0);
  // 복원됐거나 그 키워드 자신이 시드를 얻었으면 결과에 해가 없다 — 관측 표본으로만 보고한다.
  const unmeasuredSuspects = suspects.filter((s) => s.unmeasured);
  const falseAbsenceCandidates = suspects.filter((s) => !s.unmeasured && !s.restored && s.missed);
  const parseFailedProbes = fixture.probes.filter((p) => p.parseFailed === true).length;
  const verdict = {
    mode: 'survey',
    probes: fixture.probes.length,
    tokens,
    suspects: suspects.length,
    rescued: suspects.length - falseAbsenceCandidates.length - unmeasuredSuspects.length,
    falseAbsenceCandidates: falseAbsenceCandidates.length,
    parseFailedProbes,
    unmeasured: unmeasuredSuspects.length,
    // 미측정이 남아 있으면 "거짓 부재 0건"을 주장할 수 없다 — 상시 규칙 8조 제4조의 4값 판정.
    pass: falseAbsenceCandidates.length === 0 && unmeasuredSuspects.length === 0,
  };

  if (asJson) {
    console.log(JSON.stringify({ verdict, suspects, falseAbsenceCandidates, unmeasuredSuspects }, null, 2));
  } else {
    console.log(`[check-keywords · survey] 프로브 ${verdict.probes}건 · 키워드 토큰 ${verdict.tokens}개 (수집 ${fixture.capturedAt ?? '?'}${fixture.since ? ` / --since ${fixture.since}` : ''})`);
    console.log('');
    if (suspects.length === 0) {
      console.log('  손상 의심: 없음 — 이 회차에서 키워드 손상이 관측되지 않았다.');
    } else {
      console.log('  손상 의심:');
      for (const s of suspects) {
        const fate = s.unmeasured
          ? '미측정 — 수집기가 이 호출의 도구 출력을 읽지 못했다(무해의 근거 아님)'
          : s.restored
            ? '런타임 복원됨 ✓'
            : s.missed ? '복원 실패 · 이 키워드 미적중 ← 거짓 부재 후보' : '이 키워드가 시드를 얻음(손상 무해)';
        console.log(`    "${s.keyword}" → "${s.suspected}"  [${fate}]`);
        console.log(`        질문: ${JSON.stringify(s.question)}`);
      }
    }
    console.log('');
    if (verdict.parseFailedProbes > 0) {
      console.log(`  ⚠ 파싱 실패 호출 ${verdict.parseFailedProbes}건 — 이 호출의 키워드는 운명을 알 수 없다(미측정 ${verdict.unmeasured}건)`);
      console.log('');
    }
    console.log(verdict.pass
      ? `  ✓ 거짓 부재 후보 0건 · 미측정 0건 — 손상 의심 ${verdict.suspects}건 중 ${verdict.rescued}건은 복원 또는 적중으로 무해`
      : verdict.falseAbsenceCandidates > 0
        ? `  ✗ 거짓 부재 후보 ${verdict.falseAbsenceCandidates}건 — Aura 직접 조회로 실재 여부를 확정할 것`
        : `  ✗ 미측정 ${verdict.unmeasured}건 — 거짓 부재 0건을 주장할 수 없다. 파싱 실패 원인을 먼저 해소할 것`);
    for (const c of falseAbsenceCandidates) console.log(`      후보: "${c.keyword}" (질문 표기 "${c.suspected}")`);
    for (const u of unmeasuredSuspects) console.log(`      미측정: "${u.keyword}" (질문 표기 "${u.suspected}") ts=${u.ts}`);
  }
  process.exitCode = verdict.pass ? 0 : 1;
}

function main() {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  if (fixture.mode === 'survey') {
    surveyMain(fixture);
    return;
  }
  const rows = fixture.probes.flatMap(inspectProbe);
  const flagged = rows.filter((r) => r.suspected !== null);

  // ── known-answer 판정 ──
  const expected = fixture.expectedDamaged || [];
  const mustDetect = expected.filter((e) => e.detectable);
  const cannotDetect = expected.filter((e) => !e.detectable);

  const missed = mustDetect.filter(
    (e) => !flagged.some((f) => f.keyword === e.keyword && f.suspected === e.correct),
  );
  const falseAlarms = flagged.filter((f) => !expected.some((e) => e.keyword === f.keyword));

  // ── mustNotDetect — 검출되면 안 되는 것 (A1, 2026-08-22) ──
  // expectedDamaged가 "검출해야 할 것"이라면 이쪽은 반대 방향의 known-answer다.
  // 필요한 이유: 계측기가 **느슨해지는** 방향(가드 제거·거리 상한 상향)은 픽스처의
  // 정상 토큰 32개로는 드러나지 않는다 — 그 토큰들은 애초에 질문에 거리 1 후보가
  // 없어서 가드를 꺼도 무경보이기 때문이다(뮤테이션 실측: 가드 제거 뮤턴트 생존).
  // 여기 쌍은 **가드를 끄면 실제로 값이 튀어나오는** 입력만 골랐다.
  const mustNotDetect = fixture.mustNotDetect || [];
  const overDetected = mustNotDetect
    .map((m) => ({ ...m, got: pickAnchorCandidate(m.keyword, m.question) }))
    .filter((m) => m.got !== null);

  const verdict = {
    probes: fixture.probes.length,
    tokens: rows.length,
    flagged: flagged.length,
    mustDetect: mustDetect.length,
    missed: missed.length,
    falseAlarms: falseAlarms.length,
    undetectable: cannotDetect.length,
    mustNotDetect: mustNotDetect.length,
    overDetected: overDetected.length,
    pass: missed.length === 0 && falseAlarms.length === 0 && overDetected.length === 0,
  };

  if (asJson) {
    console.log(JSON.stringify({ verdict, flagged, missed, falseAlarms, overDetected }, null, 2));
  } else {
    console.log(`[check-keywords] 프로브 ${verdict.probes}건 · 키워드 토큰 ${verdict.tokens}개 (픽스처 ${fixture.capturedStamp})`);
    console.log('');
    if (flagged.length === 0) {
      console.log('  손상 의심: 없음');
    } else {
      console.log('  손상 의심:');
      for (const f of flagged) {
        console.log(`    "${f.keyword}" → "${f.suspected}"   질문: ${JSON.stringify(f.question)}`);
      }
    }
    console.log('');
    console.log(`  정상 토큰 ${verdict.tokens - verdict.flagged}개 무경보 · 오경보 ${verdict.falseAlarms}건`);
    if (cannotDetect.length > 0) {
      console.log('');
      console.log('  검출 불가로 확정된 기존 사례(계측 한계 — 이 도구의 결함이 아님):');
      for (const e of cannotDetect) {
        console.log(`    "${e.keyword}" (정상 표기 "${e.correct}") — ${e.judgment}`);
      }
    }
    if (mustNotDetect.length > 0) {
      console.log('');
      console.log(`  검출되면 안 되는 것 ${mustNotDetect.length}건 (가드 판별력) — 과잉 검출 ${overDetected.length}건`);
      for (const m of mustNotDetect) {
        const got = pickAnchorCandidate(m.keyword, m.question);
        console.log(`    ${got === null ? '✓' : '✗'} "${m.keyword}" + ${JSON.stringify(m.question)} → ${JSON.stringify(got)}  [${m.guard}]`);
      }
    }
    console.log('');
    console.log(verdict.pass
      ? `  ✓ known-answer 통과 — 검출해야 할 ${verdict.mustDetect}건 전건 검출, 오경보 0, 과잉 검출 0`
      : `  ✗ known-answer 실패 — 미검출 ${verdict.missed}건 / 오경보 ${verdict.falseAlarms}건 / 과잉 검출 ${verdict.overDetected}건`);
    for (const m of missed) console.log(`      미검출: "${m.keyword}" (기대 복원 "${m.correct}")`);
    for (const f of falseAlarms) console.log(`      오경보: "${f.keyword}" → "${f.suspected}"`);
    for (const o of overDetected) console.log(`      과잉 검출: "${o.keyword}" → "${o.got}" — ${o.why}`);
  }

  process.exitCode = verdict.pass ? 0 : 1;
}

main();
