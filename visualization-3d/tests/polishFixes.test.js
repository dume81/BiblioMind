import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createPinTracker } from '../src/lib/pinTracker.js';
import { computeExpandedSubset, findHighestDegreeNodeId } from '../src/lib/graphShape.js';

const graph3dSource = readFileSync(
  fileURLToPath(new URL('../src/components/Graph3D.jsx', import.meta.url)),
  'utf8',
);

// 품질 스프린트 회귀 테스트.

describe('createPinTracker (이슈 1: 드래그 고정 해제)', () => {
  it('pin()은 좌표를 고정하고 추적 목록에 추가한다', () => {
    const tracker = createPinTracker();
    const node = { id: 'A', x: 1, y: 2, z: 3 };
    tracker.pin(node);
    expect(node.fx).toBe(1);
    expect(node.fy).toBe(2);
    expect(node.fz).toBe(3);
    expect(tracker.size).toBe(1);
  });

  it('releaseAll()은 추적된 모든 노드를 해제한다 — 현재 화면에 없는 노드 포함', () => {
    const tracker = createPinTracker();
    const visible = { id: 'A', x: 1, y: 1, z: 1 };
    const hiddenByFilter = { id: 'B', x: 2, y: 2, z: 2 };
    tracker.pin(visible);
    tracker.pin(hiddenByFilter);

    const released = tracker.releaseAll();
    expect(released).toBe(2);
    expect(visible.fx).toBeUndefined();
    expect(hiddenByFilter.fx).toBeUndefined();
    expect(hiddenByFilter.fy).toBeUndefined();
    expect(hiddenByFilter.fz).toBeUndefined();
    expect(tracker.size).toBe(0);
  });

  it('빈 상태에서 releaseAll()은 0을 반환한다', () => {
    expect(createPinTracker().releaseAll()).toBe(0);
  });

  it('clear()는 고정을 풀지 않고 추적만 초기화한다 (새 그래프 교체용)', () => {
    const tracker = createPinTracker();
    const node = { id: 'A', x: 1, y: 1, z: 1 };
    tracker.pin(node);
    tracker.clear();
    expect(tracker.size).toBe(0);
    expect(node.fx).toBe(1); // 이전 그래프 객체는 건드리지 않는다
  });

  // 원래 이슈 1의 결함 유형(추적기는 있으나 배선 누락)을 소스 수준에서 막는다.
  it('Graph3D 배선: 드래그 종료 시 pin(), 해제 버튼·스타일 이탈 시 releaseAllPins가 연결되어 있다', () => {
    expect(graph3dSource).toContain('pinTrackerRef.current.pin(node)');
    expect(graph3dSource).toContain('releaseFixedNodes: releaseAllPins');
    expect(graph3dSource).toContain('if (!flags.fixOnDrag) releaseAllPins();');
    expect(graph3dSource).toContain('pinTrackerRef.current.clear();');
  });
});

describe('computeExpandedSubset (탐색 확장/접기 스타일)', () => {
  const data = {
    nodes: [
      { id: 'hub' }, { id: 'a' }, { id: 'b' }, { id: 'far' },
    ],
    links: [
      { id: 'l1', source: 'hub', target: 'a' },
      { id: 'l2', source: 'hub', target: 'b' },
      { id: 'l3', source: 'b', target: 'far' },
    ],
  };

  it('확장된 노드 + 직접 이웃만 보인다', () => {
    const subset = computeExpandedSubset(data, new Set(['hub']));
    expect(subset.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'hub']);
    expect(subset.links.map((l) => l.id).sort()).toEqual(['l1', 'l2']);
  });

  it('이웃의 이웃은 그 이웃을 확장해야 보인다', () => {
    const subset = computeExpandedSubset(data, new Set(['hub', 'b']));
    expect(subset.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'far', 'hub']);
    expect(subset.links).toHaveLength(3);
  });

  it('빈 확장 집합이면 아무것도 보이지 않는다', () => {
    expect(computeExpandedSubset(data, new Set())).toEqual({ nodes: [], links: [] });
  });

  it('source/target이 객체로 치환된 후에도 동작한다', () => {
    const mutated = {
      nodes: data.nodes,
      links: [{ id: 'l1', source: { id: 'hub' }, target: { id: 'a' } }],
    };
    const subset = computeExpandedSubset(mutated, new Set(['hub']));
    expect(subset.nodes.map((n) => n.id).sort()).toEqual(['a', 'hub']);
  });
});

describe('findHighestDegreeNodeId (탐색 시작점)', () => {
  it('연결이 가장 많은 노드를 찾는다', () => {
    const data = {
      nodes: [{ id: 'a' }, { id: 'hub' }, { id: 'b' }],
      links: [
        { source: 'hub', target: 'a' },
        { source: 'hub', target: 'b' },
      ],
    };
    expect(findHighestDegreeNodeId(data)).toBe('hub');
  });

  it('빈 그래프는 null', () => {
    expect(findHighestDegreeNodeId({ nodes: [], links: [] })).toBe(null);
  });
});
