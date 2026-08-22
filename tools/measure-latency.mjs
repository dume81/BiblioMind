// 스파이크 ⑤ 소요 시간 자동 측정 (육안 측정 대체 — 2026-08-22 오너 지시)
//
// 판정 세션(Claude Code)의 대화 기록에 남는 타임스탬프로 구간을 자동 산출한다:
//   t0 사용자 질문 전송  →  t1 kg_search 호출  →  t2 kg_search 반환(=허브 푸시 완료 ≈ 1층 표시)
//   판정 지표 "질문→1층 표시" = t2 - t0
//   내역: 모델 판단 시간(t1-t0) + 시스템 시간(t2-t1)
//
// 사용: node bibliomind/tools/measure-latency.mjs [--all] [--since <ISO|YYYY-MM-DD>] [--fresh A3,D1] [--continuous B1]
//   --all        평가 세트 21문 외의 호출도 포함
//   --since      그 시각 **이후**의 질문만 — 회차 분리용. 없으면 과거 판정 회차가 한 표에 섞인다.
//                **로컬 시각으로 해석한다**(예: 2026-08-22T16:00). 픽스처의 capturedStamp는 UTC이므로 혼동 주의.
//   --fresh      새 컨텍스트 첫 질문으로 **강제 분류**할 문항(자동 분류를 덮어씀)
//   --continuous 연속 대화로 강제 분류할 문항
//
// 모집단 분리(2026-08-22 M4 실행표 v2): 같은 세트라도 **새 컨텍스트 첫 질문은 12~16초, 연속 대화는 5~7초**로
// 계통 차이가 있다(개선 전 실측 — 예산 초과 4건이 전부 새 컨텍스트 첫 질문이었다). 섞어서 중앙값을 내면
// 개선과 무관한 이유로 미달이 뜨므로, 합격 판정은 **연속 대화 모집단의 중앙값**으로만 한다.
// 자동 분류 규칙: 세션 파일 안에서 **처음 측정된 질문 = 새 컨텍스트 첫 질문**, 나머지 = 연속.
// (/clear가 같은 파일 안에서 일어나면 자동 분류가 틀릴 수 있다 — 그때는 --fresh로 명시할 것.)

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PROJECT_DIRS = [
  'C--Users-DUME-Desktop-Claude-Code-Workspace-GraphRAG-1st',
  'C--Users-DUME-Desktop-Claude-Code-Workspace-GraphRAG-1st-mcp-server',
];
const ROOT = join(homedir(), '.claude', 'projects');

// 평가 세트 21문 (spike-eval-questions.md) — 질문 원문 → 문항 번호
const EVAL = {
  '귀살대는 어떤 조직이야?': 'A1',
  '우로코다키 사콘지는 누구야?': 'A2',
  '일륜도가 뭐야?': 'A3',
  '전집중 호흡은 뭐야?': 'A4',
  '다이쇼 시대에 무슨 일이 있었어?': 'A5',
  '탄지로는 어디 소속이야?': 'B1',
  '네즈코는 어떻게 도깨비가 됐어?': 'B2',
  '기유가 한 일을 알려줘': 'B3',
  '호타루는 무엇을 다루는 사람이야?': 'B4',
  '최종선별이 뭐야?': 'B5',
  '탄지로와 귀살대는 무슨 관계야?': 'C1',
  '사비토와 마코모는 무슨 관계야?': 'C2',
  '카마도 가족에게 무슨 일이 일어났어?': 'C3',
  '네즈코와 재갈은 무슨 관련이 있어?': 'C4',
  '우로코다키와 탄지로 사이에 무슨 일이 있었어?': 'C5',
  '귀멸의 칼날 주인공이 누구야?': 'D1',
  '탄지로는 어떤 성격이야?': 'D2',
  '네즈코와 탄지로는 남매야?': 'D3',
  '무잔은 누구야?': 'E1',
  '탄지로의 아버지 이름은 뭐야?': 'E2',
  '사부로 영감의 직업은 뭐야?': 'E3',
};

const onlyEval = !process.argv.includes('--all');
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
};
const csv = (name) => (argValue(name) || '').split(',').map((x) => x.trim()).filter(Boolean);

const sinceRaw = argValue('--since');
const SINCE = sinceRaw ? Date.parse(sinceRaw.length <= 10 ? `${sinceRaw}T00:00:00` : sinceRaw) : null;
if (sinceRaw && Number.isNaN(SINCE)) {
  console.error(`✗ --since 값을 해석할 수 없습니다: ${sinceRaw} (예: 2026-08-22 또는 2026-08-22T16:00)`);
  process.exit(2);
}
const FORCE_FRESH = new Set(csv('--fresh'));
const FORCE_CONT = new Set(csv('--continuous'));

/** 연속 대화 모집단의 합격 예산(§7-5). 새 컨텍스트 첫 질문에는 적용하지 않는다. */
const BUDGET_MS = 10_000;

function readSession(file) {
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* 손상 줄 무시 */ }
  }
  return rows;
}

/**
 * 한 세션에서 (질문 → 첫 kg_search 호출 → 반환) 구간을 추출한다.
 * '1층 표시'는 **첫 검색 반환** 시점이므로, 한 질문에 재검색(§6.5.3 항목 5)이 일어나도
 * 판정 지표는 첫 검색까지만 센다. 추가 검색 횟수는 별도 열로 보고한다.
 */
function extract(rows, sessionFile) {
  const results = [];
  let pending = null;   // { question, t0 }
  let current = null;   // 이 질문의 결과 레코드(첫 검색 확정 후)
  const inflight = new Map(); // tool_use_id → t1

  for (const row of rows) {
    const ts = row.timestamp ? Date.parse(row.timestamp) : null;
    if (!ts) continue;
    const content = row.message?.content;

    // 사용자 질문 (문자열 본문만 — 첨부·시스템 알림 제외)
    if (row.type === 'user' && typeof content === 'string' && !content.startsWith('<')) {
      pending = { question: norm(content), t0: ts };
      current = null;
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      if (part.type === 'tool_use' && /kg_search/.test(part.name || '')) {
        inflight.set(part.id, ts);
      }
      if (part.type === 'tool_result' && inflight.has(part.tool_use_id)) {
        const t1 = inflight.get(part.tool_use_id);
        inflight.delete(part.tool_use_id);
        if (!pending) continue;
        // 사용자가 중단한 호출은 유효 측정이 아니다 (2026-08-22 실측에서 1건 발견)
        const body = typeof part.content === 'string' ? part.content : JSON.stringify(part.content ?? '');
        if (part.is_error || /interrupt|중단/i.test(body)) continue;
        if (current) { current.extraSearches += 1; continue; } // 재검색 — 지표에 미산입
        current = {
          question: pending.question,
          item: EVAL[pending.question] || null,
          t0: pending.t0,
          modelMs: t1 - pending.t0,   // 모델 판단(도구 호출 결정 + 키워드 추출)
          toolMs: ts - t1,            // 도구 왕복(클라이언트 관측 — MCP 전송 오버헤드 포함)
          totalMs: ts - pending.t0,   // 질문 → 1층 표시 (판정 지표)
          extraSearches: 0,
          session: sessionFile.slice(0, 8),
          seqInSession: results.length, // 0 = 그 세션 파일의 첫 측정 질문
        };
        results.push(current);
      }
    }
  }
  return results;
}

const all = [];
for (const dir of PROJECT_DIRS) {
  const path = join(ROOT, dir);
  if (!existsSync(path)) continue;
  for (const file of readdirSync(path).filter((f) => f.endsWith('.jsonl'))) {
    all.push(...extract(readSession(join(path, file)), file));
  }
}

const rows = all
  .filter((r) => (onlyEval ? r.item : true))
  .filter((r) => (SINCE === null ? true : r.t0 >= SINCE))
  .sort((a, b) => a.t0 - b.t0);

// 모집단 분류 — **필터를 적용한 뒤** 세션 파일별로 첫 질문을 다시 고른다.
// extract() 시점의 seqInSession은 필터 전 기준이라, --since로 앞부분이 잘리면
// 그 회차에는 seq 0인 행이 하나도 남지 않아 전 행이 '연속'으로 분류된다(오염 재현).
const firstSeen = new Set();
for (const r of rows) {
  r.firstInScope = !firstSeen.has(r.session);
  firstSeen.add(r.session);
}
for (const r of rows) {
  const auto = r.firstInScope ? 'fresh' : 'cont';
  if (r.item && FORCE_FRESH.has(r.item)) r.pop = 'fresh';
  else if (r.item && FORCE_CONT.has(r.item)) r.pop = 'cont';
  else r.pop = auto;
  r.popForced = r.pop !== auto;
}

if (rows.length === 0) {
  console.log('측정 가능한 kg_search 호출이 없습니다. (판정 세션에서 질문을 실행한 뒤 다시 실행하세요)');
  if (SINCE !== null) console.log(`  — --since ${sinceRaw} 이후로 한정한 결과입니다. 범위를 넓혀 보세요.`);
  process.exit(0);
}

const sec = (ms) => (ms / 1000).toFixed(1) + 's';
const stats = (list) => {
  if (list.length === 0) return null;
  const sorted = [...list].sort((a, b) => a - b);
  return {
    n: sorted.length,
    median: sorted[Math.floor(sorted.length / 2)],
    avg: Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length),
    max: sorted[sorted.length - 1],
  };
};

console.log('문항  모집단  질문                                  모델판단  도구왕복  합계(질문→1층)  재검색');
console.log('─'.repeat(96));
for (const r of rows) {
  const label = (r.item || '-').padEnd(5);
  const pop = (r.pop === 'fresh' ? '새컨텍스트' : '연속') + (r.popForced ? '*' : '');
  const q = (r.question.length > 34 ? r.question.slice(0, 33) + '…' : r.question).padEnd(36);
  const extra = r.extraSearches ? `  +${r.extraSearches}회` : '';
  console.log(`${label} ${pop.padEnd(7)} ${q} ${sec(r.modelMs).padStart(7)} ${sec(r.toolMs).padStart(8)} ${sec(r.totalMs).padStart(10)}${extra}`);
}
console.log('─'.repeat(96));

const cont = stats(rows.filter((r) => r.pop === 'cont').map((r) => r.totalMs));
const fresh = stats(rows.filter((r) => r.pop === 'fresh').map((r) => r.totalMs));
const avgOf = (key) => Math.round(rows.reduce((s, r) => s + r[key], 0) / rows.length);

console.log(`측정 ${rows.length}건${SINCE === null ? '' : ` (--since ${sinceRaw} 이후)`} · 평균 내역: 모델판단 ${sec(avgOf('modelMs'))} + 도구왕복 ${sec(avgOf('toolMs'))}`);
console.log('* 도구왕복은 클라이언트 관측치(MCP 전송 오버헤드 포함) — 서버 순수 구간 직접 측정치는 약 0.45s');
if (rows.some((r) => r.popForced)) console.log("* '*' 표시는 --fresh/--continuous로 강제 분류한 문항");
console.log('');

// ── 합격 판정: 연속 대화 모집단의 **중앙값**만 예산과 대조한다 ──
if (cont) {
  const ok = cont.median <= BUDGET_MS;
  console.log(`[합격 판정] 연속 대화 ${cont.n}건 — 중앙값 ${sec(cont.median)} · 평균 ${sec(cont.avg)} · 최대 ${sec(cont.max)}`);
  console.log(`            예산 ${sec(BUDGET_MS)} 대비 중앙값 ${ok ? '충족 ✓' : '초과 ✗'}`);
} else {
  console.log('[합격 판정] 연속 대화 모집단이 비어 있어 **미측정** — 문항마다 새 컨텍스트로 돌리면 이 지표는 산출되지 않는다.');
}
if (fresh) {
  console.log(`[참고]      새 컨텍스트 첫 질문 ${fresh.n}건 — 중앙값 ${sec(fresh.median)} · 최대 ${sec(fresh.max)}`);
  console.log('            이 모집단은 컨텍스트·규칙 로드 시간이 포함돼 개선 전에도 12~16초였다. **합격 판정에 쓰지 않는다.**');
}
if (SINCE === null) {
  console.log('');
  console.log('⚠ --since 미지정 — 과거 판정 회차가 함께 집계됐을 수 있습니다. 회차별 판정에는 --since를 쓰세요.');
}

// 종료코드: 0 달성 · 1 미달 · 2 미측정 — 상시 규칙 8조 제4조의 4값 판정과 맞춘다.
if (!cont) process.exitCode = 2;
else process.exitCode = cont.median <= BUDGET_MS ? 0 : 1;
