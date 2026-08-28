// 푸시 허브 코어 (TECH-SPEC §5.1) — 보관·재생·검증·중계 규칙을 순수하게 분리해
// localServer.js는 HTTP/SSE 배선만 담당한다 (tests/hub.test.js가 이 규칙을 검증).

// 라우트별 본문 상한 (§5.1 표 — 기존 /api/graph 100KB 단일 상수를 라우트별로 확장)
export const ROUTE_BODY_LIMITS = {
  '/api/graph': 100 * 1024,
  '/api/show': 10 * 1024 * 1024,
  '/api/highlight': 1 * 1024 * 1024,
  '/api/refresh': 4 * 1024,
};

// 라우트 ↔ 허용 메시지 type (/api/highlight만 설정·해제 공용 2종)
export const ROUTE_MESSAGE_TYPES = {
  '/api/show': ['graph.show'],
  '/api/highlight': ['highlight.set', 'highlight.clear'],
  '/api/refresh': ['graph.refresh'],
};

export function isValidHubMessage(route, message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return false;
  const allowed = ROUTE_MESSAGE_TYPES[route];
  return Boolean(allowed && allowed.includes(message.type));
}

// SSE 형식 (§5.1): `event: <type>` + `data: <JSON 한 줄>`
export function sseFrame(message) {
  return `event: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`;
}

function parseTs(message) {
  const t = Date.parse(message?.ts);
  return Number.isNaN(t) ? 0 : t;
}

// 재생 순서 규칙 (§5.1 v2 확정): 보관 2건의 ts를 비교해 최신 1건의 '의도'만 재생한다 —
// graph.show가 최신이면 highlight 재생 생략, highlight.set이 최신이면 highlight만 재생.
export function pickReplay(lastShow, lastHighlight) {
  if (lastShow && lastHighlight) {
    return parseTs(lastShow) >= parseTs(lastHighlight) ? lastShow : lastHighlight;
  }
  return lastShow || lastHighlight || null;
}

export function createHub() {
  const subscribers = new Set(); // (frame: string) => void
  // 최신 상태 보관 — 영속화하지 않는다(§5.1: 허브 재시작 시 화면도 새로 시작).
  let lastShow = null;
  let lastHighlight = null;

  return {
    /**
     * 새 SSE 구독자 등록 + 보관 상태 재생.
     * @param {(frame: string) => void} send
     * @returns {() => void} 구독 해제 함수
     */
    subscribe(send) {
      subscribers.add(send);
      const replay = pickReplay(lastShow, lastHighlight);
      if (replay) send(sseFrame(replay));
      return () => subscribers.delete(send);
    },

    /**
     * 보관 갱신 + 전 구독자 즉시 중계 (§5.1 허브 동작 규칙).
     * highlight.clear·graph.refresh는 보관 상태를 각각 무효화한다.
     * @param {{type: string}} message 검증(isValidHubMessage)을 통과한 §5.2 메시지
     * @returns {{ok: true, hubUp: true, connected: number, delivered: boolean}}
     */
    publish(message) {
      if (message.type === 'graph.show') lastShow = message;
      else if (message.type === 'highlight.set') lastHighlight = message;
      else if (message.type === 'highlight.clear') lastHighlight = null;
      else if (message.type === 'graph.refresh') lastShow = null;

      const frame = sseFrame(message);
      subscribers.forEach((send) => send(frame));
      const connected = subscribers.size;
      return { ok: true, hubUp: true, connected, delivered: connected > 0 };
    },

    /**
     * 현재 SSE 구독 수 — GET /api/health(v2.12) 전용의 부수효과 없는 조회.
     * publish가 반환하는 connected와 같은 사실의 단일 구현(별도 계수 변수 금지 — 드리프트 방지).
     * @returns {number}
     */
    connectedCount() {
      return subscribers.size;
    },
  };
}
