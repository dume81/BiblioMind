import { describe, expect, it } from 'vitest';
import { buildRenderData } from '../src/lib/renderData.js';
import { normalizeCanonicalGraph } from '../src/lib/canonicalGraph.js';

function makeGraph() {
  return normalizeCanonicalGraph({
    nodes: [
      { id: 'A', label: 'Person', properties: { name: '가' } },
      { id: 'B', label: 'Person', properties: { name: '나' } },
      { id: 'C', label: 'Place', properties: {} },
    ],
    relationships: [
      { type: 'KNOWS', start_node_id: 'A', end_node_id: 'B', properties: {} },
      { type: 'LIKES', start_node_id: 'A', end_node_id: 'B', properties: {} },
      { type: 'REVERSE', start_node_id: 'B', end_node_id: 'A', properties: {} },
      { type: 'SELF', start_node_id: 'C', end_node_id: 'C', properties: {} },
      { type: 'SINGLE', start_node_id: 'A', end_node_id: 'C', properties: {} },
    ],
  }).graph;
}

describe('buildRenderData', () => {
  it('렌더 데이터는 Canonical Graph의 복제본이다 — 렌더 데이터 변형이 원본에 영향을 주지 않는다', () => {
    const graph = makeGraph();
    const render = buildRenderData(graph);

    // react-force-graph-3d가 하듯이 렌더 데이터를 변형해 본다.
    render.nodes[0].x = 123;
    render.nodes[0].properties.name = 'mutated';
    render.links[0].source = render.nodes[0]; // id 문자열 → 노드 객체 치환

    expect(graph.nodes[0].properties.name).toBe('가');
    expect(graph.relationships[0].start_node_id).toBe('A');
    expect(Object.isFrozen(graph)).toBe(true);
  });

  it('단독 관계는 곡률 0', () => {
    const render = buildRenderData(makeGraph());
    const single = render.links.find((l) => l.type === 'SINGLE');
    expect(single.curvature).toBe(0);
  });

  it('다중·역방향 관계는 곡률로 분리한다 (역방향도 같은 쌍 그룹)', () => {
    const render = buildRenderData(makeGraph());
    const pairLinks = render.links.filter((l) => ['KNOWS', 'LIKES', 'REVERSE'].includes(l.type));
    expect(pairLinks).toHaveLength(3);
    pairLinks.forEach((link) => expect(link.curvature).toBe(0.4));
    const rotations = new Set(pairLinks.map((l) => l.curveRotation));
    expect(rotations.size).toBe(3);
  });

  it('셀프 관계는 항상 곡률을 가진다', () => {
    const render = buildRenderData(makeGraph());
    const self = render.links.find((l) => l.type === 'SELF');
    expect(self.curvature).toBeGreaterThan(0);
  });

  it('노드 색상은 label 기반으로 결정적이다', () => {
    const render = buildRenderData(makeGraph());
    const personColors = render.nodes.filter((n) => n.label === 'Person').map((n) => n.color);
    expect(personColors[0]).toBe(personColors[1]);
    const placeColor = render.nodes.find((n) => n.label === 'Place').color;
    expect(placeColor).not.toBe(personColors[0]);
  });

  it('표시 이름이 없는 노드는 id를 사용한다', () => {
    const render = buildRenderData(makeGraph());
    expect(render.nodes.find((n) => n.id === 'C').name).toBe('C');
    expect(render.nodes.find((n) => n.id === 'A').name).toBe('가');
  });
});
