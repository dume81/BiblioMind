import { handleGraphRequest } from '../server/core/handler.js';

// Vercel Node.js Function (Edge runtime 아님).
// 클라이언트는 이 엔드포인트만 호출하며, 서버 전용 환경 변수로 Neo4j에 접근한다.
export default async function handler(req, res) {
  let body = req.body;
  if (typeof body === 'string' && body.length > 0) {
    try {
      body = JSON.parse(body);
    } catch {
      body = null;
    }
  }

  const result = await handleGraphRequest({ method: req.method, body, env: process.env });

  for (const [key, value] of Object.entries(result.headers || {})) {
    res.setHeader(key, value);
  }
  res.status(result.status).json(result.body);
}
