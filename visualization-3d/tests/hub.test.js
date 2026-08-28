import { describe, expect, it } from 'vitest';
import {
  ROUTE_BODY_LIMITS,
  ROUTE_MESSAGE_TYPES,
  isValidHubMessage,
  sseFrame,
  pickReplay,
  createHub,
} from '../server/core/hub.js';
import { mapNode } from '../server/core/mapper.js';

function msg(type, ts, extra = {}) {
  return { type, ts, ...extra };
}

describe('허브 라우트 규약 (§5.1)', () => {
  it('라우트별 본문 상한 — show 10MB, highlight 1MB, refresh 4KB, graph 100KB', () => {
    expect(ROUTE_BODY_LIMITS['/api/show']).toBe(10 * 1024 * 1024);
    expect(ROUTE_BODY_LIMITS['/api/highlight']).toBe(1024 * 1024);
    expect(ROUTE_BODY_LIMITS['/api/refresh']).toBe(4 * 1024);
    expect(ROUTE_BODY_LIMITS['/api/graph']).toBe(100 * 1024);
  });

  it('라우트 ↔ type 검증: highlight만 설정·해제 공용', () => {
    expect(isValidHubMessage('/api/highlight', msg('highlight.set', 't'))).toBe(true);
    expect(isValidHubMessage('/api/highlight', msg('highlight.clear', 't'))).toBe(true);
    expect(isValidHubMessage('/api/show', msg('graph.show', 't'))).toBe(true);
    expect(isValidHubMessage('/api/refresh', msg('graph.refresh', 't'))).toBe(true);
    // 교차·미지정은 거부
    expect(isValidHubMessage('/api/show', msg('highlight.set', 't'))).toBe(false);
    expect(isValidHubMessage('/api/highlight', msg('graph.show', 't'))).toBe(false);
    expect(isValidHubMessage('/api/graph', msg('graph.show', 't'))).toBe(false);
    expect(isValidHubMessage('/api/highlight', null)).toBe(false);
    expect(isValidHubMessage('/api/highlight', [])).toBe(false);
    expect(isValidHubMessage('/api/highlight', { ts: 't' })).toBe(false);
  });

  it('SSE 형식: event + data(JSON 한 줄)', () => {
    const frame = sseFrame(msg('highlight.set', 't1', { searchId: 's-1' }));
    expect(frame).toBe('event: highlight.set\ndata: {"type":"highlight.set","ts":"t1","searchId":"s-1"}\n\n');
  });

  it('ROUTE_MESSAGE_TYPES에 /api/graph는 없다 (허브 라우트가 아님)', () => {
    expect(Object.keys(ROUTE_MESSAGE_TYPES).sort()).toEqual(['/api/highlight', '/api/refresh', '/api/show']);
  });
});

describe('재생 순서 규칙 (§5.1 — ts 최신 의도 1건)', () => {
  const show = msg('graph.show', '2026-08-21T10:00:00+09:00');
  const highlight = msg('highlight.set', '2026-08-21T11:00:00+09:00');

  it('둘 다 있으면 ts 최신 1건만', () => {
    expect(pickReplay(show, highlight)).toBe(highlight);
    const newerShow = msg('graph.show', '2026-08-21T12:00:00+09:00');
    expect(pickReplay(newerShow, highlight)).toBe(newerShow);
  });

  it('하나만 있으면 그것을, 없으면 null', () => {
    expect(pickReplay(show, null)).toBe(show);
    expect(pickReplay(null, highlight)).toBe(highlight);
    expect(pickReplay(null, null)).toBeNull();
  });

  it('ts가 손상된 메시지는 0으로 취급되어 정상 ts에 밀린다', () => {
    const broken = msg('graph.show', 'not-a-date');
    expect(pickReplay(broken, highlight)).toBe(highlight);
  });
});

describe('createHub — 보관·중계·구독 (§5.1)', () => {
  it('publish는 전 구독자에게 중계하고 connected/delivered를 보고한다', () => {
    const hub = createHub();
    const a = [];
    const b = [];
    hub.subscribe((frame) => a.push(frame));
    hub.subscribe((frame) => b.push(frame));
    const result = hub.publish(msg('highlight.set', 't1'));
    expect(result).toEqual({ ok: true, hubUp: true, connected: 2, delivered: true });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).toContain('event: highlight.set');
  });

  it('구독자 0명이면 delivered:false (§5.5 — 보관은 유지)', () => {
    const hub = createHub();
    expect(hub.publish(msg('highlight.set', 't1'))).toEqual({
      ok: true, hubUp: true, connected: 0, delivered: false,
    });
    const late = [];
    hub.subscribe((frame) => late.push(frame));
    expect(late).toHaveLength(1); // 보관분 재생
  });

  it('새 구독자에게 최신 의도 1건만 재생한다 (show vs highlight)', () => {
    const hub = createHub();
    hub.publish(msg('graph.show', '2026-08-21T10:00:00+09:00', { file: 'a.kg.json' }));
    hub.publish(msg('highlight.set', '2026-08-21T11:00:00+09:00', { searchId: 's-1' }));
    const received = [];
    hub.subscribe((frame) => received.push(frame));
    expect(received).toHaveLength(1);
    expect(received[0]).toContain('event: highlight.set');
  });

  it('highlight.clear는 하이라이트 보관을 무효화하고 중계된다', () => {
    const hub = createHub();
    hub.publish(msg('highlight.set', 't1'));
    const live = [];
    hub.subscribe((frame) => live.push(frame));
    expect(live).toHaveLength(1); // 재생 1건
    hub.publish(msg('highlight.clear', 't2'));
    expect(live).toHaveLength(2); // clear 중계
    const late = [];
    hub.subscribe((frame) => late.push(frame));
    expect(late).toHaveLength(0); // 보관 없음 — 재생 없음
  });

  it('graph.refresh는 show 보관을 무효화한다 (하이라이트 보관은 유지)', () => {
    const hub = createHub();
    hub.publish(msg('graph.show', '2026-08-21T10:00:00+09:00'));
    hub.publish(msg('highlight.set', '2026-08-21T09:00:00+09:00', { searchId: 's-1' }));
    hub.publish(msg('graph.refresh', '2026-08-21T12:00:00+09:00'));
    const late = [];
    hub.subscribe((frame) => late.push(frame));
    // show는 무효화됐고, 남은 보관은 highlight뿐이므로 highlight가 재생된다.
    expect(late).toHaveLength(1);
    expect(late[0]).toContain('event: highlight.set');
  });

  it('구독 해제 후에는 중계되지 않는다', () => {
    const hub = createHub();
    const received = [];
    const unsubscribe = hub.subscribe((frame) => received.push(frame));
    unsubscribe();
    const result = hub.publish(msg('highlight.set', 't1'));
    expect(received).toHaveLength(0);
    expect(result.connected).toBe(0);
  });
});

describe('표시 라벨 — RKEntity 제외 (§2.3.1, 슬라이스 1)', () => {
  it('시스템 라벨 RKEntity를 제외한 첫 라벨을 쓴다', () => {
    const node = mapNode({ elementId: 'x', labels: ['RKEntity', 'Person'], properties: {} });
    expect(node.label).toBe('Person');
  });

  it('RKEntity뿐이거나 라벨이 없으면 Node로 폴백한다', () => {
    expect(mapNode({ elementId: 'x', labels: ['RKEntity'], properties: {} }).label).toBe('Node');
    expect(mapNode({ elementId: 'x', labels: [], properties: {} }).label).toBe('Node');
  });

  it('RKEntity가 없는 기존 데이터는 종전과 동일하다', () => {
    expect(mapNode({ elementId: 'x', labels: ['Person', 'Actor'], properties: {} }).label).toBe('Person');
  });
});

describe('connectedCount — 상태 조회 전용 계수 (v2.12 /api/health)', () => {
  it('구독·해제를 부수효과 없이 집계한다 — publish의 connected와 같은 사실의 단일 구현', () => {
    const hub = createHub();
    expect(hub.connectedCount()).toBe(0);
    const un1 = hub.subscribe(() => {});
    const un2 = hub.subscribe(() => {});
    expect(hub.connectedCount()).toBe(2);
    un1();
    expect(hub.connectedCount()).toBe(1);
    un2();
    expect(hub.connectedCount()).toBe(0);
  });
});
