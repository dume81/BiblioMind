#!/usr/bin/env node
// 가짜 엔진 실행 스크립트 (TECH-SPEC §1.12-2) — **실구독을 소모하지 않는다.**
// 시나리오를 argv로 받아 고정 출력을 뱉거나 고장을 흉내낸다.
//
// 사용: node fake-engine.js <시나리오> [--out <파일>] [--envelope]
//   good        정상 KG JSON
//   fenced      백틱 펜스로 감싼 JSON (프롬프트 지시 위반이지만 파서가 견뎌야 한다)
//   bad         JSON이 아닌 텍스트 → bad_output
//   badthengood 첫 호출은 깨진 출력, 두 번째부터 정상 (교정 재호출 시험 — 카운터 파일 사용)
//   ratelimit   한도 안내 문구 출력
//   crash       종료 코드 3
//   hang        응답 없이 매달림 → timeout
//   empty       빈 출력
//
// --out <파일>  : codex 어댑터처럼 결과를 파일로 쓴다
// --envelope    : claude 어댑터처럼 stdout에 JSON 봉투로 감싼다

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const scenario = argv.find((a) => !a.startsWith('--')) ?? 'good';
const outIdx = argv.indexOf('--out');
const outFile = outIdx > -1 ? argv[outIdx + 1] : null;
const envelope = argv.includes('--envelope');
const counterIdx = argv.indexOf('--counter');
const counterFile = counterIdx > -1 ? argv[counterIdx + 1] : null;

// stdin을 실제로 읽어 "본문이 argv가 아니라 stdin으로 왔는지"를 증명한다.
let stdin = '';
try {
  stdin = readFileSync(0, 'utf8');
} catch { /* stdin 없음 */ }

const GOOD = JSON.stringify({
  nodes: [
    { id: '0', label: 'Person', properties: { name: '카마도 탄지로' } },
    { id: '1', label: 'Person', properties: { name: '카마도 네즈코' } },
    { id: '2', label: 'Ritual', properties: { name: '가짜 의식' } },
  ],
  relationships: [
    { type: 'OLDER_BROTHER_OF', start_node_id: '0', end_node_id: '1', properties: {} },
    { type: 'INVENTED_BY', start_node_id: '2', end_node_id: '0', properties: {} },
  ],
});

function emit(text, code = 0) {
  if (outFile) writeFileSync(outFile, text, 'utf8');
  const payload = envelope
    ? JSON.stringify({ type: 'result', is_error: false, num_turns: 1, result: text })
    : text;
  if (!outFile || envelope) process.stdout.write(payload);
  process.exit(code);
}

let effective = scenario;
if (scenario === 'badthengood' && counterFile) {
  const n = existsSync(counterFile) ? Number(readFileSync(counterFile, 'utf8')) : 0;
  writeFileSync(counterFile, String(n + 1), 'utf8');
  effective = n === 0 ? 'bad' : 'good';
}

// 프롬프트가 stdin으로 오지 않았으면 그 자체가 계약 위반이다 — 눈에 띄게 실패시킨다.
if (!stdin.includes('[자료 본문]') && effective !== 'hang') {
  process.stderr.write('가짜 엔진: stdin에서 프롬프트를 받지 못했습니다(계약 위반)');
  process.exit(4);
}

switch (effective) {
  case 'good': emit(GOOD); break;
  case 'fenced': emit('```json\n' + GOOD + '\n```'); break;
  case 'bad': emit('죄송합니다. 요청을 이해하지 못했습니다.'); break;
  case 'ratelimit': process.stderr.write('Error: rate limit exceeded — please try again later'); process.exit(1); break;
  case 'crash': process.stderr.write('가짜 엔진 폭발'); process.exit(3); break;
  case 'empty': emit(''); break;
  case 'hang': setTimeout(() => process.exit(0), 60000); break;
  default: process.stderr.write(`알 수 없는 시나리오: ${effective}`); process.exit(5);
}
