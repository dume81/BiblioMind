// refresh-keyword-probes — 판정 회차의 (question, keywords) 쌍을 대화 기록에서 새로 떠온다 (유지보수 M4).
//
// 왜 필요한가: `mcp-server/fixtures/keyword-probes.json`은 **개선 전 판정 시점의 고정본**이라
// known-answer 회귀 테스트용이다. 새 판정 회차에서 모델이 새로 만들어낸 키워드는 그 파일에 없으므로,
// 그 파일만 돌려서는 "이번 회차에 손상이 없었다"를 증명할 수 없다. 이 도구가 그 공백을 메운다.
//
// 개선 전 기준선을 덮지 않는다 — 항상 --out 파일에 쓴다(기본값도 별도 파일).
//
// 사용: node scripts/refresh-keyword-probes.js --since 2026-08-22T16:00 [--out <REPO 기준 경로>]
// 결과 검사: node scripts/check-keywords.js --fixture mcp-server/fixtures/keyword-probes-m4.json

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { claudeProjectDirName } from './lib/claude-project-dir.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

// 판정 창(Claude Code, GraphRAG_1st 루트)의 대화 기록 위치. 폴더명은 현재 저장소 경로에서
// 동적으로 산출한다 — PC별 경로를 하드코딩하면 타 PC에서 조용히 빈 결과가 된다(2026-08-27 감사).
const PROJECT_DIRS = [
  claudeProjectDirName(REPO),
  claudeProjectDirName(path.join(REPO, 'mcp-server')),
];
const ROOT = path.join(homedir(), '.claude', 'projects');

const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
};

const sinceRaw = argValue('--since');
const SINCE = sinceRaw ? Date.parse(sinceRaw.length <= 10 ? `${sinceRaw}T00:00:00` : sinceRaw) : null;
if (sinceRaw && Number.isNaN(SINCE)) {
  console.error(`✗ --since 값을 해석할 수 없습니다: ${sinceRaw}`);
  process.exit(2);
}
const OUT = path.resolve(REPO, argValue('--out') ?? 'mcp-server/fixtures/keyword-probes-m4.json');

/**
 * tool_result 본문에서 동봉된 JSON 블록을 꺼낸다(요약 텍스트 + ```json 블록 구조).
 *
 * **파싱 실패는 반드시 성공과 구분해서 돌려준다(A1, 2026-08-22).** 이전 판은 실패 시에도
 * null을 돌려줬고, 호출부가 그것을 `seeds = []` → `seedCount: 0` · `unmatched: []`로 옮겼다.
 * 그러면 "도구 출력을 읽지 못했다"가 "시드가 0건이었다"와 완전히 같은 기록이 된다.
 * 더 나쁜 것은 `unmatched: []`가 빈 **배열**이라 check-keywords survey가 그것을 유효한
 * 목록으로 믿고 손상 키워드를 "시드를 얻음(무해)"으로 분류해 **거짓 부재 후보를 은폐**한다는 점이다.
 * @returns {{ ok: true, data: any } | { ok: false, reason: string }}
 */
function parseResultData(part) {
  const raw = typeof part.content === 'string'
    ? part.content
    : (part.content ?? []).map((c) => (typeof c === 'string' ? c : c.text ?? '')).join('\n');
  const m = /```json\s*([\s\S]*?)```/.exec(raw);
  if (!m) return { ok: false, reason: 'json 블록 없음' };
  try {
    return { ok: true, data: JSON.parse(m[1]) };
  } catch (e) {
    return { ok: false, reason: `JSON 파싱 실패: ${e.message}` };
  }
}

function extract(file) {
  const probes = [];
  const inflight = new Map(); // tool_use_id → { ts, question, keywords }
  let lastUserQuestion = null;

  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const ts = row.timestamp ? Date.parse(row.timestamp) : null;
    const content = row.message?.content;

    if (row.type === 'user' && typeof content === 'string' && !content.startsWith('<')) {
      lastUserQuestion = content.replace(/\s+/g, ' ').trim();
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      if (part.type === 'tool_use' && /kg_search/.test(part.name || '')) {
        const input = part.input || {};
        if (!Array.isArray(input.keywords) || input.keywords.length === 0) continue;
        inflight.set(part.id, {
          ts: row.timestamp ?? null,
          tsMs: ts,
          // question 인자가 없으면 직전 사용자 발화로 대체한다(앵커 채널이 실제로 무엇이었는지 기록).
          question: typeof input.question === 'string' && input.question ? input.question : lastUserQuestion,
          questionSource: typeof input.question === 'string' && input.question ? 'tool-arg' : 'user-utterance',
          keywords: input.keywords,
        });
      }
      if (part.type === 'tool_result' && inflight.has(part.tool_use_id)) {
        const call = inflight.get(part.tool_use_id);
        inflight.delete(part.tool_use_id);
        if (SINCE !== null && (call.tsMs === null || call.tsMs < SINCE)) continue;
        const parsed = parseResultData(part);
        const head = {
          ts: call.ts,
          question: call.question,
          questionSource: call.questionSource,
          keywords: call.keywords,
        };
        if (!parsed.ok) {
          // 미측정으로 명시한다 — 0건이 아니라 "모른다". null과 [] 를 섞지 않는다.
          probes.push({
            ...head,
            parseFailed: true,
            parseFailReason: parsed.reason,
            seedCount: null,
            seedTiers: [],
            restoredFrom: [],
            unmatched: null,
          });
          continue;
        }
        const data = parsed.data;
        const seeds = Array.isArray(data?.seeds) ? data.seeds : [];
        probes.push({
          ...head,
          parseFailed: false,
          seedCount: seeds.reduce((s, x) => s + (x.matched?.length ?? 0), 0),
          seedTiers: seeds.map((x) => `${x.keyword}:${x.tier}${x.restoredFrom ? `(복원←${x.restoredFrom})` : ''}`),
          restoredFrom: seeds.filter((x) => x.restoredFrom).map((x) => x.restoredFrom),
          unmatched: Array.isArray(data?.unmatched) ? data.unmatched : [],
        });
      }
    }
  }
  return probes;
}

const probes = [];
for (const dir of PROJECT_DIRS) {
  const p = path.join(ROOT, dir);
  if (!existsSync(p)) continue;
  for (const f of readdirSync(p).filter((x) => x.endsWith('.jsonl'))) {
    probes.push(...extract(path.join(p, f)));
  }
}
probes.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

if (probes.length === 0) {
  console.error('✗ 수집된 kg_search 호출이 0건입니다.');
  console.error(`  조사 범위: ${PROJECT_DIRS.join(', ')} (아래 .jsonl 전량)${sinceRaw ? ` / --since ${sinceRaw} 이후` : ''}`);
  console.error('  없었던 것: 해당 범위의 kg_search tool_use.');
  console.error('  확보 방법: 판정 창(GraphRAG_1st 루트 Claude Code)에서 문항을 실행한 뒤 다시 돌리세요.');
  process.exit(1);
}

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify({
  schemaVersion: 1,
  mode: 'survey',
  purpose: '판정 회차에서 모델이 실제로 생성한 (question, keywords) 쌍. known-answer 픽스처(keyword-probes.json)와 달리 정답이 미리 정해져 있지 않은 조사용이다.',
  capturedAt: new Date().toISOString(),
  since: sinceRaw ?? null,
  note: '검사: node scripts/check-keywords.js --fixture <이 파일>. survey 모드는 "손상 의심인데 복원도 안 됐고 시드도 0건"인 건만 실패로 센다.',
  expectedDamaged: [],
  probes,
}, null, 2)}\n`, 'utf8');

const tokens = probes.reduce((s, p) => s + p.keywords.length, 0);
console.log(`수집 ${probes.length}건 · 키워드 토큰 ${tokens}개 → ${path.relative(REPO, OUT)}`);
console.log(`질문 채널: tool-arg ${probes.filter((p) => p.questionSource === 'tool-arg').length}건 / 직전 발화 대체 ${probes.filter((p) => p.questionSource !== 'tool-arg').length}건`);
console.log(`시드 0건 호출: ${probes.filter((p) => p.seedCount === 0).length}건 · 복원 발화: ${probes.filter((p) => p.restoredFrom.length > 0).length}건`);
const failed = probes.filter((p) => p.parseFailed);
console.log(failed.length === 0
  ? '파싱 실패(미측정): 0건 — 수집분 전건이 도구 출력까지 읽혔다'
  : `⚠ 파싱 실패(미측정): ${failed.length}건 — 시드 0건과 구분해 seedCount:null로 기록했다. 이 호출들은 "손상 없음"의 근거가 되지 못한다`);
for (const f of failed) console.log(`    ${f.ts} keywords=${JSON.stringify(f.keywords)} — ${f.parseFailReason}`);
