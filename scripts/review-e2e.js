// review-e2e — S4 검수 워크플로(§4.3-4~7)를 **실제 MCP stdio 서버**로 왕복 검증한다.
//
// 단위 테스트가 못 덮는 것을 여기서 덮는다: 도구가 챗 클라이언트에게 실제로 어떻게 보이는가.
//   · JSON-RPC 왕복(tools/list → tools/call)이 성립하는가
//   · 반환이 클라이언트 스키마를 통과하는가 — `kg_generate`는 여기서 -32602로 죽고 있었다(2026-08-23)
//   · 승인·반려가 폴더와 원장을 실제로 옮기는가
//
// 왜 격리 데이터 폴더인가: 이사님의 `data/Generated` 6건은 **검수 판단이 필요한 실물**이다.
// 시험이 그 판단을 대신 내리면 안 된다 — 실물을 복사해 임시 폴더에서 왕복만 증명한다.
// 반려의 자동 재생성도 `regenerate:false`로 끈다(엔진 구독 미소모).
//
// 사용법: npm run review:e2e   ·  종료 코드 0 = 전건 통과 / 1 = 실패
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rows = [];
const check = (ok, name, detail) => {
  rows.push({ ok, name, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}\n      ${detail}`);
};

// ── 격리 데이터 폴더 준비 ──
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-review-e2e-'));
for (const d of ['Input', 'Generated', 'Reviewed', 'Rejected', 'runtime', 'tmp', '.tmp']) {
  fs.mkdirSync(path.join(ROOT, d), { recursive: true });
}
fs.copyFileSync(path.join(REPO, 'shared', 'schema', 'schema.default.json'), path.join(ROOT, 'schema.json'));

// 실물 검수 대상 1건을 복사한다(없으면 합성 그래프로 대체 — 클론 직후에도 돌아야 한다).
const realGenerated = path.join(REPO, 'data', 'Generated');
const sample = fs.existsSync(realGenerated) ? fs.readdirSync(realGenerated).filter((f) => f.endsWith('.kg.json'))[0] : null;
const STEM = sample ? sample.slice(0, -'.kg.json'.length) : 'e2e_sample_p01';
const FILE = `${STEM}.kg.json`;
if (sample) {
  fs.copyFileSync(path.join(realGenerated, sample), path.join(ROOT, 'Generated', FILE));
} else {
  fs.writeFileSync(path.join(ROOT, 'Generated', FILE), JSON.stringify({
    nodes: [{ id: '0', label: 'Person', properties: { name: '카마도 탄지로' } },
      { id: '1', label: 'Person', properties: { name: '카마도 네즈코' } }],
    relationships: [{ type: 'OLDER_BROTHER_OF', start_node_id: '0', end_node_id: '1', properties: {} }],
  }, null, 2), 'utf8');
}
fs.writeFileSync(path.join(ROOT, 'Input', `${STEM}.md`), '---\ntitle: e2e\n---\n본문\n', 'utf8');
fs.writeFileSync(path.join(ROOT, 'ledger.json'), JSON.stringify({
  version: 1, sources: { e2ekey: { kind: 'web', file: `${STEM}.md`, status: 'collected', reject_count: 0 } },
}, null, 2), 'utf8');

// ⚠️ **재빌드 안전핀 — 스크립트 전체에 미리 건다** (2026-08-23 실사고 수리).
// 데이터 폴더는 격리했지만 **Neo4j 인스턴스는 하나뿐이라 공유된다.** 이 스크립트에는 재빌드를
// 부르는 경로가 **둘** 있다: ①아래 "모든 도구 호출" 루프가 kg_rebuild를 부른다 ②승인분 반려가
// §4.3-7 ②로 자동 재빌드를 부른다. 처음엔 ②만 막았는데 ①이 먼저 터져 **실제 예시 그래프가
// 통째로 지워졌다**(빈 Reviewed/로 재빌드 = 빈 그래프). 잠금을 **시작 시점에** 걸어 둘 다 막는다.
// 재빌드 성공 경로는 `npm run rebuild:e2e`가 전담한다 — 이 스크립트는 DB를 만지지 않는다.
fs.writeFileSync(path.join(ROOT, '.lock'),
  JSON.stringify({ pid: process.pid, holder: 'review-e2e-guard', at: 'test' }), 'utf8');

// ── MCP stdio 클라이언트(최소 구현) ──
const child = spawn(process.execPath, ['mcp-server/src/index.js'], {
  cwd: REPO,
  // 허브는 죽은 포트로 돌린다 — 이사님이 보고 있는 3D 화면을 시험이 바꾸지 않는다.
  env: { ...process.env, KG_DATA_DIR: ROOT, VIZ_SERVER_URL: 'http://127.0.0.1:59098' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map();
let buf = '';
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const waiter = pending.get(msg.id);
    if (waiter) { pending.delete(msg.id); waiter(msg); }
  }
});
let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 응답 없음(10초)`)), 10000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
/** 도구 호출 — **JSON-RPC 오류를 성공으로 세지 않는다**(이 시험의 존재 이유). */
async function callTool(name, args) {
  const msg = await rpc('tools/call', { name, arguments: args ?? {} });
  if (msg.error) return { rpcError: msg.error.message, text: null, data: null };
  const texts = (msg.result?.content ?? []).map((c) => c.text ?? '');
  const json = texts.find((t) => t.startsWith('```json'));
  return {
    rpcError: null,
    text: texts[0] ?? '',
    data: json ? JSON.parse(json.replace(/^```json\n/, '').replace(/\n```$/, '')) : null,
  };
}

try {
  await rpc('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'review-e2e', version: '1' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

  // 1) 등록 목록
  const list = await rpc('tools/list', {});
  const names = (list.result?.tools ?? []).map((t) => t.name);
  const need = ['review_list', 'review_show', 'review_approve', 'review_reject'];
  check(need.every((n) => names.includes(n)), '검수 도구 4종이 tools/list에 노출된다',
    `등록 ${names.length}종: ${names.join(', ')}`);

  // 2) **모든 도구가 JSON-RPC 오류 없이 응답한다** — kg_generate가 여기서 죽고 있었다
  const SAFE = {
    kg_status: {}, kg_generate: {}, review_list: {},
    review_show: { file: 'no_such_p01.kg.json' },
    review_approve: { file: 'no_such_p01.kg.json' },
    review_reject: { file: 'no_such_p01.kg.json' },
    kg_search: { keywords: [] }, kg_cite: {}, highlight_clear: {},
    // 수집 2종(슬라이스 8.5) — 파싱·절대경로 검증이 네트워크·파일시스템 접촉 전에 거부한다.
    collect_web: { url: 'not-a-url' },
    collect_docs: { path: 'no_such_doc.pdf' },
  };
  const rpcErrors = [];
  for (const name of names) {
    const r = await callTool(name, SAFE[name] ?? {});
    if (r.rpcError) rpcErrors.push(`${name}: ${r.rpcError}`);
  }
  check(rpcErrors.length === 0, '모든 도구가 tools/call에서 프로토콜 오류 없이 응답한다',
    rpcErrors.length === 0 ? `${names.length}종 전건 정상 반환` : rpcErrors.join(' / '));

  // 3) review_list — 대기 1건
  const listed = await callTool('review_list');
  check(listed.data?.pendingCount === 1 && listed.data.items[0].file === FILE,
    'review_list가 검수 대기를 집계한다',
    `대기 ${listed.data?.pendingCount}건 · ${listed.data?.items?.[0]?.file} (노드 ${listed.data?.items?.[0]?.nodeCount}·관계 ${listed.data?.items?.[0]?.relCount})`);

  // 4) review_show — 구조 검증 + 푸시 시도(허브 없음 → 비치명)
  const shown = await callTool('review_show', { file: FILE });
  check(shown.data?.ok === true && shown.data.structure.nodeCount > 0,
    'review_show가 구조 검증을 통과하고 푸시를 시도한다',
    `노드 ${shown.data?.structure?.nodeCount}·관계 ${shown.data?.structure?.relCount} · 뷰어 전달 ${shown.data?.viewer?.delivered} (허브 없음 = 비치명)`);
  check(shown.data?.graph === undefined,
    'review_show 반환에 그래프 본문을 싣지 않는다 (챗 컨텍스트 보호)',
    `반환 키: ${Object.keys(shown.data ?? {}).join(', ')}`);

  // 5) review_approve — Generated → Reviewed
  const approved = await callTool('review_approve', { file: FILE });
  const movedToReviewed = fs.existsSync(path.join(ROOT, 'Reviewed', FILE))
    && !fs.existsSync(path.join(ROOT, 'Generated', FILE));
  check(approved.data?.ok === true && movedToReviewed,
    'review_approve가 Reviewed/로 원자 이동한다',
    `${approved.data?.file} → Reviewed/ · 잔여 대기 ${approved.data?.remaining}건`);

  // 6) review_reject — Reviewed → Rejected (의미 검수 경로) · 재생성은 끈다
  // 재빌드는 시작 시점에 건 잠금 때문에 거절된다(위 안전핀 참조) — 그 보고가 정직한지를 8)에서 잰다.
  const rejected = await callTool('review_reject', { file: FILE, reason: 'e2e 검증', regenerate: false });
  const rejFile = `${STEM}.kg.rej1.json`;
  const movedToRejected = fs.existsSync(path.join(ROOT, 'Rejected', rejFile))
    && !fs.existsSync(path.join(ROOT, 'Reviewed', FILE));
  check(rejected.data?.ok === true && movedToRejected && rejected.data.from === 'Reviewed',
    'review_reject가 Rejected/<stem>.kg.rej1.json으로 이력 보존 이동한다',
    `${rejected.data?.from} → ${rejected.data?.movedTo} · 누적 반려 ${rejected.data?.rejectCount}회`);

  // 7) 원장 카운터 — 승인 리셋 후 반려 +1
  const ledger = JSON.parse(fs.readFileSync(path.join(ROOT, 'ledger.json'), 'utf8'));
  check(ledger.sources.e2ekey.reject_count === 1 && ledger.sources.e2ekey.last_reject_reason === 'e2e 검증',
    '원장에 반려 횟수와 사유가 기록된다',
    `reject_count=${ledger.sources.e2ekey.reject_count} · 사유="${ledger.sources.e2ekey.last_reject_reason}"`);

  // 8) 승인분 반려는 제외 재빌드를 부르고, 못 했으면 **못 했다고 말한다**
  check(rejected.data?.rebuild?.required === true
    && rejected.data.rebuild.done === false
    && /kg_rebuild/.test(rejected.data.rebuild.note ?? ''),
  '승인분 반려 시 재빌드를 시도하고, 실패하면 복구 명령을 안내한다 (§4.3-7 ②)',
  rejected.data?.rebuild?.note ?? '(고지 없음)');
} catch (err) {
  check(false, '왕복 중 예외', err.message);
} finally {
  child.kill();
  fs.rmSync(ROOT, { recursive: true, force: true });
}

const fail = rows.filter((r) => !r.ok).length;
console.log(`\n검수 왕복: ${rows.length - fail}/${rows.length} 통과${fail ? ` — 실패 ${fail}건` : ''}`);
process.exitCode = fail ? 1 : 0;
