import { useEffect, useRef } from 'react';

// SSE 구독·재접속 (TECH-SPEC §7.2): 앱 시작 시 /api/events를 EventSource로 구독하고
// §5.2 메시지 4종을 핸들러로 디스패치한다. 재생 메시지는 일반 메시지와 동일하게
// 처리된다(§5.3 — 허브가 최신 의도 1건을 재생하므로 별도 복구 로직이 필요 없다).
// 끊김은 EventSource 기본 재시도에 맡기고, 완전 종료(CLOSED)만 지수 백오프로 보강한다.

const EVENT_TYPES = ['graph.show', 'highlight.set', 'highlight.clear', 'graph.refresh'];
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30 * 1000;
// 한 번도 연결된 적 없이 이 횟수만큼 실패하면 재시도를 멈춘다 — SSE 라우트가 없는
// 환경(Vercel 배포 등)에서의 무한 재접속 방지. 연결된 적이 있으면 무제한 재시도.
const MAX_ATTEMPTS_BEFORE_FIRST_OPEN = 8;

/**
 * @param {(type: string, message: object) => void} onMessage
 */
export function usePushChannel(onMessage) {
  // 핸들러가 바뀌어도 재구독하지 않도록 ref로 최신 핸들러만 갱신한다.
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

  useEffect(() => {
    if (typeof EventSource === 'undefined') return undefined; // 테스트 등 비브라우저 환경
    let source = null;
    let retryTimer = null;
    let attempts = 0;
    let everConnected = false;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      source = new EventSource('/api/events');
      source.onopen = () => {
        attempts = 0;
        everConnected = true;
      };
      EVENT_TYPES.forEach((type) => {
        source.addEventListener(type, (event) => {
          let message;
          try {
            message = JSON.parse(event.data);
          } catch {
            return; // 손상된 메시지는 무시한다
          }
          handlerRef.current?.(type, message);
        });
      });
      source.onerror = () => {
        // CONNECTING이면 EventSource가 스스로 재시도한다 — CLOSED만 보강 재접속.
        if (source.readyState === EventSource.CLOSED) {
          source.close();
          attempts += 1;
          if (!everConnected && attempts >= MAX_ATTEMPTS_BEFORE_FIRST_OPEN) return;
          const delay = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
          retryTimer = setTimeout(connect, delay);
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      source?.close();
    };
  }, []);
}
