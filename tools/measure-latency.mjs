// 스파이크 ⑤ 소요 시간 자동 측정 (육안 측정 대체 — 2026-08-22 오너 지시)
//
// 판정 세션(Claude Code)의 대화 기록에 남는 타임스탬프로 구간을 자동 산출한다:
//   t0 사용자 질문 전송  →  t1 kg_search 호출  →  t2 kg_search 반환(=허브 푸시 완료 ≈ 1층 표시)
//   판정 지표 "질문→1층 표시" = t2 - t0
//   내역: 모델 판단 시간(t1-t0) + 시스템 시간(t2-t1)
//
// 사용: node bibliomind/tools/measure-latency.mjs [--all]
//   기본 = 평가 세트 21문과 일치하는 질문만, --all = 전체 kg_search 호출

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
  .sort((a, b) => a.t0 - b.t0);

if (rows.length === 0) {
  console.log('측정 가능한 kg_search 호출이 없습니다. (판정 세션에서 질문을 실행한 뒤 다시 실행하세요)');
  process.exit(0);
}

const sec = (ms) => (ms / 1000).toFixed(1) + 's';
console.log('문항  질문                                    모델판단  도구왕복  합계(질문→1층)  재검색');
console.log('─'.repeat(88));
for (const r of rows) {
  const label = (r.item || '-').padEnd(5);
  const q = (r.question.length > 36 ? r.question.slice(0, 35) + '…' : r.question).padEnd(38);
  const extra = r.extraSearches ? `  +${r.extraSearches}회` : '';
  console.log(`${label} ${q} ${sec(r.modelMs).padStart(7)} ${sec(r.toolMs).padStart(8)} ${sec(r.totalMs).padStart(10)}${extra}`);
}

const avg = (key) => Math.round(rows.reduce((s, r) => s + r[key], 0) / rows.length);
const max = Math.max(...rows.map((r) => r.totalMs));
console.log('─'.repeat(88));
const sorted = rows.map((r) => r.totalMs).sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
console.log(`측정 ${rows.length}건 · 평균: 모델판단 ${sec(avg('modelMs'))} + 도구왕복 ${sec(avg('toolMs'))} = 합계 ${sec(avg('totalMs'))} (중앙값 ${sec(median)})`);
console.log('* 도구왕복은 클라이언트 관측치(MCP 전송 오버헤드 포함) — 서버 순수 구간 직접 측정치는 약 0.45s');
console.log(`최대 ${sec(max)} · 예산 10초 대비 ${max <= 10000 ? '전건 충족 ✓' : '초과 있음 ✗'}`);
