// 로컬 개발용 Neo4j API 서버 — Vercel 배포 없이 프런트엔드와 함께 전체 스택을 테스트한다.
// Vercel Function(api/graph.js)과 동일한 server/core/handler.js를 공유한다.
// 실행: npm run dev:api  (또는 npm run dev:full 로 Vite와 동시 실행)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '@bibliomind/shared/env';
import { handleGraphRequest } from './core/handler.js';
import { createHub, isValidHubMessage, ROUTE_BODY_LIMITS, ROUTE_MESSAGE_TYPES } from './core/hub.js';

const PORT = Number(process.env.API_PORT) || 8787;
const SSE_KEEPALIVE_MS = 25 * 1000;

// .env.local의 서버 전용 환경 변수를 로드한다 (이미 설정된 값은 덮어쓰지 않음).
// 값은 어디에도 로그로 남기지 않는다.
function loadEnvLocal() {
  const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvLocal();
// 저장소 루트 .env도 인식한다 (TECH-SPEC §1.10 — 루트 단일 파일 통일, .env.local이 우선).
// 두 로더 모두 이미 설정된 값은 덮어쓰지 않으므로 호출 순서가 곧 우선순위다.
loadEnv();

// 푸시 허브 (TECH-SPEC §5.1): MCP 서버의 POST를 SSE 구독자(3D 앱)에게 중계하고
// 최신 상태를 보관했다가 새 구독자에게 재생한다.
const hub = createHub();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // SSE 이벤트 중계 구독 (§5.1 — 단일 채널)
  if (url.pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const unsubscribe = hub.subscribe((frame) => res.write(frame));
    const keepAlive = setInterval(() => res.write(': ping\n\n'), SSE_KEEPALIVE_MS);
    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
    return;
  }

  // 허브 상태 조회 (v2.12 — kg_status 전용, 로컬 허브 전용 라우트). 본문 수신 블록을 타지
  // 않는 조기 반환이어야 한다 — ROUTE_BODY_LIMITS 미등재 라우트가 아래 블록에 합류하면
  // `received > undefined`가 항상 false라 무제한 버퍼링이 된다.
  if (url.pathname === '/api/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, connected: hub.connectedCount() }));
    return;
  }

  const isHubRoute = Object.prototype.hasOwnProperty.call(ROUTE_MESSAGE_TYPES, url.pathname);
  if (url.pathname !== '/api/graph' && !isHubRoute) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
    return;
  }

  const maxBodyBytes = ROUTE_BODY_LIMITS[url.pathname];
  const chunks = [];
  let received = 0;
  let aborted = false;

  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > maxBodyBytes) {
      aborted = true;
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'INVALID_REQUEST' } }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', async () => {
    if (aborted) return;
    let body = null;
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
    }

    // 허브 라우트 (§5.1): POST + type 검증 → 보관 갱신 + SSE 중계 → {connected, delivered} 응답.
    if (isHubRoute) {
      if (req.method !== 'POST' || !isValidHubMessage(url.pathname, body)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'INVALID_REQUEST' } }));
        return;
      }
      const result = hub.publish(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    try {
      const result = await handleGraphRequest({ method: req.method, body, env: process.env });
      res.writeHead(result.status, { 'Content-Type': 'application/json', ...(result.headers || {}) });
      res.end(JSON.stringify(result.body));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }));
    }
  });
});

// 바인딩은 127.0.0.1 (§5.1 — 허브는 로컬 전용)
server.listen(PORT, '127.0.0.1', () => {
  const enabled = process.env.NEO4J_SOURCE_ENABLED === 'true';
  const configured = Boolean(process.env.NEO4J_URI && process.env.NEO4J_USERNAME && process.env.NEO4J_PASSWORD);
  // 자격증명 값은 절대 출력하지 않는다 — 상태 불리언만 표시.
  console.log(`[dev-api] http://127.0.0.1:${PORT}/api/graph (Neo4j enabled: ${enabled}, configured: ${configured})`);
  console.log(`[dev-api] push hub: POST /api/show·/api/highlight·/api/refresh + SSE /api/events`);
});
