import { describe, expect, it } from 'vitest';
import { mapNode, mapRelationship, mapToCanonicalGraph } from '../server/core/mapper.js';

function rawNode(elementId, labels = ['Person'], properties = {}) {
  return { elementId, labels, properties };
}

function rawRel(elementId, startId, endId, type = 'KNOWS', properties = {}) {
  return { elementId, type, startNodeElementId: startId, endNodeElementId: endId, properties };
}

const LIMITS = { nodeLimit: 300, relationshipLimit: 600 };

describe('mapNode / mapRelationship', () => {
  it('elementId 계열 필드만 사용한다 (deprecated identity/start/end 미사용)', () => {
    const node = mapNode({ elementId: 'e1', identity: 999, labels: ['A'], properties: {} });
    expect(node.id).toBe('e1');

    const rel = mapRelationship({
      elementId: 'r1',
      identity: 999,
      start: 111,
      end: 222,
      type: 'REL',
      startNodeElementId: 'e1',
      endNodeElementId: 'e2',
      properties: {},
    });
    expect(rel.id).toBe('r1');
    expect(rel.start_node_id).toBe('e1');
    expect(rel.end_node_id).toBe('e2');
  });

  it('다중 label은 첫 번째 label만 사용한다', () => {
    expect(mapNode(rawNode('e1', ['Person', 'Actor', 'Director'])).label).toBe('Person');
  });

  it('label이 없으면 "Node"를 사용한다', () => {
    expect(mapNode(rawNode('e1', [])).label).toBe('Node');
    expect(mapNode({ elementId: 'e1', properties: {} }).label).toBe('Node');
  });

  it('전체 label 목록을 properties에 삽입하지 않는다', () => {
    const node = mapNode(rawNode('e1', ['Person', 'Actor'], { name: 'kim' }));
    expect(node.properties).toEqual({ name: 'kim' });
  });
});

describe('mapToCanonicalGraph', () => {
  it('노드와 관계를 element ID로 중복 제거한다', () => {
    const result = mapToCanonicalGraph(
      [rawNode('n1'), rawNode('n1'), rawNode('n2')],
      [rawRel('r1', 'n1', 'n2'), rawRel('r1', 'n1', 'n2')],
      LIMITS,
    );
    expect(result.nodes).toHaveLength(2);
    expect(result.relationships).toHaveLength(1);
  });

  it('포함되지 않은 노드를 참조하는 관계(dangling)를 제외하고 truncated로 표시한다', () => {
    const result = mapToCanonicalGraph(
      [rawNode('n1')],
      [rawRel('r1', 'n1', 'missing')],
      LIMITS,
    );
    expect(result.relationships).toHaveLength(0);
    expect(result.meta.truncated).toBe(true);
  });

  it('고립 노드를 유지한다', () => {
    const result = mapToCanonicalGraph([rawNode('n1'), rawNode('n2')], [], LIMITS);
    expect(result.nodes).toHaveLength(2);
    expect(result.relationships).toHaveLength(0);
  });

  it('다중·역방향·셀프 관계를 유지한다', () => {
    const result = mapToCanonicalGraph(
      [rawNode('n1'), rawNode('n2')],
      [
        rawRel('r1', 'n1', 'n2', 'A'),
        rawRel('r2', 'n1', 'n2', 'A'),
        rawRel('r3', 'n2', 'n1', 'B'),
        rawRel('r4', 'n1', 'n1', 'SELF'),
      ],
      LIMITS,
    );
    expect(result.relationships).toHaveLength(4);
  });

  it('결과가 limit에 도달하면 truncated를 표시한다', () => {
    const nodes = Array.from({ length: 3 }, (_, i) => rawNode(`n${i}`));
    const result = mapToCanonicalGraph(nodes, [], { nodeLimit: 3, relationshipLimit: 10 });
    expect(result.meta.truncated).toBe(true);
  });

  it('limit 미만이면 truncated가 아니다', () => {
    const result = mapToCanonicalGraph([rawNode('n1')], [], LIMITS);
    expect(result.meta.truncated).toBe(false);
  });

  it('meta에 정확한 개수를 담는다', () => {
    const result = mapToCanonicalGraph(
      [rawNode('n1'), rawNode('n2')],
      [rawRel('r1', 'n1', 'n2')],
      LIMITS,
    );
    expect(result.meta).toEqual({
      source: 'neo4j',
      truncated: false,
      nodeCount: 2,
      relationshipCount: 1,
    });
  });

  it('원본 객체를 변형하지 않는다', () => {
    const node = Object.freeze(rawNode('n1', ['A'], Object.freeze({ key: 'value' })));
    const rel = Object.freeze(rawRel('r1', 'n1', 'n1'));
    const result = mapToCanonicalGraph([node], [rel], LIMITS);
    expect(result.nodes[0].properties).not.toBe(node.properties);
    expect(node.properties).toEqual({ key: 'value' });
  });
});
