// 시각화 허브 푸시 클라이언트 (§5 정본의 송신측).
// **무-throw 계약(§5.5 v2.2)**: 연결 거부·타임아웃·비 2xx(404 포함) 어떤 실패에도
// throw하지 않고 상태 객체로 환원한다 — 검색·답변은 항상 정상 동작(하이라이트만 유실).
import { loadEnv } from '@bibliomind/shared/env';

const PUSH_TIMEOUT_MS = 1500;

/**
 * @param {string} apiPath 예: "/api/highlight"
 * @param {object} payload §5.2 메시지
 * @returns {Promise<{ hubUp: boolean, connected: number, delivered: boolean, note: string | null }>}
 */
export async function pushToHub(apiPath, payload) {
  loadEnv();
  const base = process.env.VIZ_SERVER_URL || 'http://127.0.0.1:8787';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
  try {
    const res = await fetch(base + apiPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (res.status === 404) {
      // 2026-08-22 정정: 이전 문구는 수신 라우트가 아직 없는 과도기를 안내했다.
      // 라우트 3종은 슬라이스 1에서 이미 구현·실왕복 검증됐으므로(`npm run hub:e2e` 8/8),
      // 지금 404가 나면 원인이 전혀 다르다 — 대개 옛 서버가 떠 있거나 포트가 어긋난 것이다.
      // 낡은 안내는 사용자를 엉뚱한 곳으로 보낸다(M3에서 고친 "틀린 안내"와 같은 유형).
      return {
        hubUp: true,
        connected: 0,
        delivered: false,
        note: `허브는 응답했지만 ${apiPath} 경로가 없습니다 — 옛 시각화 서버가 떠 있거나 VIZ_SERVER_URL이 다른 포트를 가리킵니다. npm run dev:all을 재기동하세요. (검색·답변은 정상 동작)`,
      };
    }
    if (!res.ok) {
      return { hubUp: true, connected: 0, delivered: false, note: `허브 응답 오류(HTTP ${res.status}) — 검색·답변은 정상 동작` };
    }
    const body = await res.json().catch(() => ({}));
    const connected = Number(body.connected ?? 0);
    return {
      hubUp: true,
      connected,
      delivered: Boolean(body.delivered),
      note: connected === 0
        ? '3D 앱이 열려 있지 않아 화면에 표시되지 않았습니다 — 크롬에서 http://localhost:5173 을 열면 마지막 하이라이트가 자동 표시됩니다'
        : null,
    };
  } catch {
    return { hubUp: false, connected: 0, delivered: false, note: '시각화 서버가 꺼져 있습니다. npm run dev:all 실행 후 크롬에서 http://localhost:5173 을 여세요. (검색·답변은 정상 동작)' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 허브 상태 조회 — GET /api/health (v2.12, kg_status 전용). 무-throw 계약은 push와 동일.
 * pushToHub를 재사용하지 않는 이유: 푸시는 뷰어 화면에 부수효과를 만든다 — 조회는 조회여야 한다.
 * @returns {Promise<{ hubUp: boolean, connected: number, note: string | null }>}
 */
export async function getHubHealth() {
  loadEnv();
  const base = process.env.VIZ_SERVER_URL || 'http://127.0.0.1:8787';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/health`, { signal: controller.signal });
    if (res.status === 404) {
      return { hubUp: true, connected: 0, note: '허브는 응답했지만 /api/health 경로가 없습니다 — 옛 시각화 서버가 떠 있습니다. npm run dev:all을 재기동하세요.' };
    }
    if (!res.ok) return { hubUp: true, connected: 0, note: `허브 응답 오류(HTTP ${res.status})` };
    const body = await res.json().catch(() => ({}));
    return { hubUp: true, connected: Number(body.connected ?? 0), note: null };
  } catch {
    return { hubUp: false, connected: 0, note: '시각화 서버가 꺼져 있습니다 — npm run dev:all 실행 후 크롬에서 http://localhost:5173 을 여세요.' };
  } finally {
    clearTimeout(timer);
  }
}
