import { describe, expect, it } from 'vitest';
import { collectRelationshipProperties, createFilteredGraph, resolveRelationshipFilterValue } from '../src/lib/filters.js';
import { buildRenderData } from '../src/lib/renderData.js';
import { normalizeCanonicalGraph } from '../src/lib/canonicalGraph.js';

// 코드 리뷰에서 확정된 결함들의 회귀 테스트.

describe('properties 키가 최상위 키와 충돌하는 경우 (review finding #2)', () => {
  const rels = [
    {
      id: 'r1',
      type: 'KNOWS',
      start_node_id: 'A',
      end_node_id: 'B',
      properties: { type: 'friend', id: 'custom-1' },
    },
  ];

  it('필터 후보에는 매칭 가능한 값만 노출된다', () => {
    const props = collectRelationshipProperties(rels);
    // 'type' 그룹: 최상위 type("KNOWS")만 — properties.type("friend")은 매칭 불가능하므로 제외.
    expect(props.type).toEqual(['KNOWS']);
    // 예약 키 'id'는 properties 쪽 값("custom-1")으로 수집된다.
    expect(props.id).toEqual(['custom-1']);
  });

  it('수집과 필터링이 같은 값 해석을 사용한다', () => {
    const props = collectRelationshipProperties(rels);
    Object.entries(props).forEach(([property, values]) => {
      values.forEach((value) => {
        const matched = rels.some((rel) => String(resolveRelationshipFilterValue(rel, property)) === value);
        expect(matched).toBe(true);
      });
    });
  });

  it('UI가 제안한 값을 선택하면 실제로 관계가 매칭된다 (빈 그래프가 되지 않음)', () => {
    const graph = {
      nodes: [
        { id: 'A', label: 'T', properties: {} },
        { id: 'B', label: 'T', properties: {} },
      ],
      relationships: rels,
    };
    const props = collectRelationshipProperties(rels);
    props.type.forEach((value) => {
      const filtered = createFilteredGraph(graph, {
        customFilter: (rel) => String(resolveRelationshipFilterValue(rel, 'type')) === value,
      });
      expect(filtered.relationships.length).toBeGreaterThan(0);
    });
  });
});

describe('공백 포함 노드 ID의 곡률 그룹 키 충돌 (review finding #3)', () => {
  it('"A B"→"C"와 "A"→"B C"는 서로 다른 쌍으로 취급되어 직선을 유지한다', () => {
    const { graph } = normalizeCanonicalGraph({
      nodes: [
        { id: 'A B', label: 'T', properties: {} },
        { id: 'C', label: 'T', properties: {} },
        { id: 'A', label: 'T', properties: {} },
        { id: 'B C', label: 'T', properties: {} },
      ],
      relationships: [
        { type: 'X', start_node_id: 'A B', end_node_id: 'C', properties: {} },
        { type: 'Y', start_node_id: 'A', end_node_id: 'B C', properties: {} },
      ],
    });
    const render = buildRenderData(graph);
    render.links.forEach((link) => {
      expect(link.curvature).toBe(0);
    });
  });

  it('공백 포함 ID의 동일 삼중항 다중 관계도 안정적인 고유 ID를 얻는다', () => {
    const input = {
      nodes: [
        { id: 'A B', label: 'T', properties: {} },
        { id: 'C', label: 'T', properties: {} },
      ],
      relationships: [
        { type: 'X', start_node_id: 'A B', end_node_id: 'C', properties: {} },
        { type: 'X', start_node_id: 'A B', end_node_id: 'C', properties: {} },
      ],
    };
    const result = normalizeCanonicalGraph(input);
    expect(result.ok).toBe(true);
    const ids = result.graph.relationships.map((r) => r.id);
    expect(new Set(ids).size).toBe(2);
  });
});
