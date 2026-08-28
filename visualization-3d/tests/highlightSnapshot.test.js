// 하이라이트 상태 진단 스냅샷 단위 테스트 (TECH-SPEC §7.9).
// 순수 함수만 검증한다 — 전역 대입(App.jsx의 useEffect 1줄)은 렌더링에 관여하지 않는다.
import { describe, it, expect } from 'vitest';
import { resolveQueryHighlight, buildHighlightSnapshot } from '../src/lib/queryHighlight.js';

/** 노드 3·관계 2를 가진 렌더 집합 — 골든 S03(일륜도) 1층과 같은 규모. */
const renderData = {
  nodes: [
    { id: 'e1', properties: { kgid: 'n_a' } },
    { id: 'e2', properties: { kgid: 'n_b' } },
    { id: 'e3', properties: { kgid: 'n_c' } },
    { id: 'e9', properties: {} }, // kgid 없음 — 색인에서 빠진다
  ],
  links: [
    { id: 'r1', properties: { kgid: 'r_x' } },
    { id: 'r2', properties: { kgid: 'r_y' } },
  ],
};

const message = (over = {}) => ({
  searchId: 's-1',
  question: '일륜도가 뭐야?',
  truncated: false,
  citation: { status: 'pending', submitted: 0, accepted: 0 },
  layer1: { nodeIds: ['n_a', 'n_b', 'n_c'], relIds: ['r_x', 'r_y'] },
  layer2: { nodeIds: [], relIds: [] },
  ...over,
});

const snapshot = (over) => buildHighlightSnapshot(resolveQueryHighlight(message(over), renderData), renderData);

describe('buildHighlightSnapshot — 계약 (§7.9)', () => {
  it('하이라이트가 없으면 null이다', () => {
    expect(buildHighlightSnapshot(null, renderData)).toBeNull();
  });

  it('수신 집합과 식별 정보를 그대로 싣는다', () => {
    const s = snapshot();
    expect(s.schemaVersion).toBe(1);
    expect(s.searchId).toBe('s-1');
    expect(s.question).toBe('일륜도가 뭐야?');
    expect(s.layer1.nodeKgids).toEqual(['n_a', 'n_b', 'n_c']);
    expect(s.layer1.relKgids).toEqual(['r_x', 'r_y']);
    expect(s.total).toBe(5);
    expect(s.matched).toBe(5);
    expect(s.active).toBe(true);
  });

  it('2층이 지정되면 rendered.layer1에서 그 원소를 뺀다 (2층 우선 §7.4)', () => {
    const s = snapshot({ layer2: { nodeIds: ['n_a'], relIds: ['r_x'] } });
    expect(s.rendered.layer2.nodeKgids).toEqual(['n_a']);
    expect(s.rendered.layer2.relKgids).toEqual(['r_x']);
    expect(s.rendered.layer1.nodeKgids).toEqual(['n_b', 'n_c']);
    expect(s.rendered.layer1.relKgids).toEqual(['r_y']);
    // 수신 집합 자체는 빼지 않는다 — 푸시된 것과 그려지는 것을 구분해서 싣는다.
    expect(s.layer1.nodeKgids).toEqual(['n_a', 'n_b', 'n_c']);
  });

  it('렌더 집합에 없는 kgid는 rendered에서 빠지고 그 차집합이 N/M 격차와 일치한다', () => {
    const s = snapshot({ layer1: { nodeIds: ['n_a', 'n_zzz'], relIds: [] } });
    expect(s.layer1.nodeKgids).toEqual(['n_a', 'n_zzz']);
    expect(s.rendered.layer1.nodeKgids).toEqual(['n_a']);
    expect(s.total - s.matched).toBe(1);
  });

  it('매칭 0건이면 오버라이드 미발동 — rendered가 전부 비어 있다', () => {
    const s = snapshot({ layer1: { nodeIds: ['n_없음'], relIds: [] } });
    expect(s.active).toBe(false);
    expect(s.rendered.layer1.nodeKgids).toEqual([]);
    expect(s.rendered.layer2.nodeKgids).toEqual([]);
  });

  it('시드 0건(빈 1층)은 emptyResult로 실리고 rendered가 비어 있다', () => {
    const s = snapshot({ layer1: { nodeIds: [], relIds: [] } });
    expect(s.emptyResult).toBe(true);
    expect(s.active).toBe(false);
    expect(s.total).toBe(0);
    expect(s.rendered.layer1.relKgids).toEqual([]);
  });

  it('citation·truncated는 수신값을 그대로 전달한다', () => {
    const s = snapshot({ truncated: true, citation: { status: 'verified', submitted: 3, accepted: 3 } });
    expect(s.truncated).toBe(true);
    expect(s.citation).toEqual({ status: 'verified', submitted: 3, accepted: 3 });
  });

  it('스냅샷은 JSON 직렬화 가능하다 (Set 잔존 금지 — 전역 판독 계약)', () => {
    const s = snapshot({ layer2: { nodeIds: ['n_a'], relIds: [] } });
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});
