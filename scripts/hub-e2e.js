// hub-e2e — 푸시 허브(§5.1)의 라우트 3종 + SSE 실왕복을 격리 인스턴스에서 검증한다.
//
// 왜 격리 포트인가: 개발 중인 8787 허브에 쏘면 사용자가 보고 있는 3D 화면이 바뀐다.
// API_PORT로 별도 인스턴스를 띄워 상태를 오염시키지 않는다.
//
// 왜 저장소 도구인가(2026-08-22): 최초 작성분은 scratchpad 일회용이었다. check-absence와
// 같은 실수를 반복하지 않는다 — 검증기가 저장소 밖에 있으면 다음 회차에 존재하지 않는다.
//
// 사용법: npm run hub:e2e   ·  종료 코드 0 = 전건 통과 / 1 = 실패
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'visualization-3d');
const PORT = Number(process.env.HUB_E2E_PORT) || 8799; // 개발 허브(8787)와 충돌하지 않는 포트
const BASE = `http://127.0.0.1:${PORT}`;
const rows = [];
const check = (ok, name, detail) => { rows.push({ ok, name, detail }); console.log(`${ok ? '✓' : '✗'} ${name}\n      ${detail}`); };

const srv = spawn(process.execPath, ['server/localServer.js'], {
  cwd: REPO, env: { ...process.env, API_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
let boot = '';
srv.stdout.on('data', (d) => { boot += d; });
srv.stderr.on('data', (d) => { boot += d; });

try {
  for (let i = 0; i < 40 && !boot.includes('push hub'); i += 1) await sleep(150);
  check(boot.includes('push hub'), '허브 기동', boot.split('\n').filter(Boolean).slice(-1)[0] ?? '(출력 없음)');

  // ── SSE 구독자 1 ──
  const received = [];
  const ac = new AbortController();
  const sse = await fetch(`${BASE}/api/events`, { signal: ac.signal });
  (async () => {
    const reader = sse.body.getReader();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) > -1) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /event: (.+)/.exec(frame)?.[1];
        if (ev) received.push(ev);
      }
    }
  })().catch(() => {});
  await sleep(200);

  const post = async (path, body) => {
    const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const ts = (s) => new Date(Date.UTC(2026, 7, 22, 10, s)).toISOString();

  // ── 라우트 3종 실왕복 ──
  const show = await post('/api/show', { type: 'graph.show', ts: ts(1), purpose: 'review', file: 'x.kg.json', graph: { nodes: [], relationships: [] } });
  check(show.status === 200 && show.body?.ok === true, 'POST /api/show 200 + ok', JSON.stringify(show.body));

  const hl = await post('/api/highlight', { type: 'highlight.set', ts: ts(2), searchId: 's-x', layer1: { nodeIds: ['n_1'], relIds: [] }, layer2: { nodeIds: [], relIds: [] }, citation: { status: 'pending', submitted: 0, accepted: 0 } });
  check(hl.status === 200 && hl.body?.connected === 1 && hl.body?.delivered === true, 'POST /api/highlight — connected/delivered 보고', JSON.stringify(hl.body));

  const rf = await post('/api/refresh', { type: 'graph.refresh', ts: ts(3), buildId: 'b1', reason: 'rebuild', counts: { nodes: 1, relationships: 0 } });
  check(rf.status === 200 && rf.body?.ok === true, 'POST /api/refresh 200 + ok', JSON.stringify(rf.body));

  await sleep(250);
  check(JSON.stringify(received) === JSON.stringify(['graph.show', 'highlight.set', 'graph.refresh']),
    'SSE 중계 — 3건이 순서대로 도착', `수신: ${JSON.stringify(received)}`);

  // ── 상태 조회 (v2.12 — kg_status의 허브 확인 경로) ──
  const health = await fetch(`${BASE}/api/health`);
  const healthBody = await health.json().catch(() => null);
  check(health.status === 200 && healthBody?.ok === true && healthBody?.connected === 1,
    'GET /api/health — ok + SSE 구독 수 보고', JSON.stringify(healthBody));

  // ── 라우트↔type 교차 거부 ──
  const wrong = await post('/api/refresh', { type: 'highlight.set', ts: ts(4) });
  check(wrong.status >= 400, '라우트에 맞지 않는 type 거부', `HTTP ${wrong.status}`);

  // ── 본문 상한 (refresh 4KB) ──
  const big = await post('/api/refresh', { type: 'graph.refresh', ts: ts(5), reason: 'x'.repeat(5000) });
  check(big.status >= 400, '본문 상한 초과 거부 (refresh 4KB)', `HTTP ${big.status}`);

  // ── 재생 규칙: 지금 보관 = highlight(ts 2). refresh가 show 보관을 무효화했으므로 highlight만 재생 ──
  const ac2 = new AbortController();
  const sse2 = await fetch(`${BASE}/api/events`, { signal: ac2.signal });
  const r2 = sse2.body.getReader();
  // 첫 청크에는 `: connected` 코멘트가 섞여 온다 — 코멘트를 건너뛰고 **실제 event 줄**을 찾는다.
  // (초판은 첫 청크 통째로 includes()를 걸어서, 통과하더라도 무엇을 봤는지 출력이 오도했다.)
  const replayed = [];
  const deadline = Date.now() + 2000;
  let buf2 = '';
  while (replayed.length === 0 && Date.now() < deadline) {
    const chunk = await Promise.race([r2.read(), sleep(300).then(() => null)]);
    if (chunk?.value) buf2 += Buffer.from(chunk.value).toString('utf8');
    for (const line of buf2.split('\n')) {
      const m = /^event: (.+)$/.exec(line.trim());
      if (m) replayed.push(m[1]);
    }
  }
  check(replayed.length === 1 && replayed[0] === 'highlight.set',
    '신규 구독자에게 최신 의도 1건만 재생 (graph.refresh가 show 보관을 무효화)',
    `재생된 event: ${JSON.stringify(replayed)}`);
  ac2.abort(); ac.abort();
} finally {
  srv.kill();
}

const fail = rows.filter((r) => !r.ok).length;
console.log(`\n허브 실왕복: ${rows.length - fail}/${rows.length} 통과${fail ? ` — 실패 ${fail}건` : ''}`);
process.exitCode = fail ? 1 : 0;
