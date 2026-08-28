import { describe, expect, it } from 'vitest';
import { collectNodePropertyOptions, collectRelationshipProperties, createFilteredGraph } from '../src/lib/filters.js';

const graph = {
  nodes: [
    { id: 'A', label: 'T', properties: {} },
    { id: 'B', label: 'T', properties: {} },
    { id: 'ISOLATED', label: 'T', properties: {} },
  ],
  relationships: [
    { id: 'r1', type: 'KNOWS', start_node_id: 'A', end_node_id: 'B', properties: { episode_number: 'S1E1' } },
    { id: 'r2', type: 'LIKES', start_node_id: 'B', end_node_id: 'A', properties: { episode_number: 'S1E2' } },
  ],
};

describe('collectRelationshipProperties', () => {
  it('type과 properties.* 키를 수집하고 id/start/end/properties 키는 제외한다', () => {
    const props = collectRelationshipProperties(graph.relationships);
    expect(Object.keys(props).sort()).toEqual(['episode_number', 'type']);
    expect(props.type).toEqual(['KNOWS', 'LIKES']);
    expect(props.episode_number).toEqual(['S1E1', 'S1E2']);
  });

  it('관계가 없으면 빈 결과를 반환한다', () => {
    expect(collectRelationshipProperties([])).toEqual({});
  });
});

describe('createFilteredGraph', () => {
  it('필터에 걸린 관계에 연결된 노드만 남긴다 (기존 동작 유지)', () => {
    const filtered = createFilteredGraph(graph, {
      customFilter: (rel) => rel.type === 'KNOWS',
    });
    expect(filtered.relationships).toHaveLength(1);
    expect(filtered.nodes.map((n) => n.id).sort()).toEqual(['A', 'B']);
  });

  it('필터가 없으면 관계 전체를 유지한다', () => {
    const filtered = createFilteredGraph(graph, {});
    expect(filtered.relationships).toHaveLength(2);
  });
});

// 참고: pruneActiveFilters는 "새 데이터 로드 시 완전 초기화" 사양 변경(이슈 3)으로 제거되었다.

describe('collectNodePropertyOptions (하이라이트 Property/Value 후보)', () => {
  it('노드 properties의 키·값을 정렬해 수집한다', () => {
    const options = collectNodePropertyOptions([
      { id: 'A', label: 'T', properties: { name: '탄지로', role: '주인공' } },
      { id: 'B', label: 'T', properties: { name: '네즈코' } },
      { id: 'C', label: 'T', properties: {} },
    ]);
    expect(Object.keys(options)).toEqual(['name', 'role']);
    expect(options.name).toEqual(['네즈코', '탄지로']);
    expect(options.role).toEqual(['주인공']);
  });

  it('null·중첩 객체 값은 후보에서 제외한다', () => {
    const options = collectNodePropertyOptions([
      { id: 'A', label: 'T', properties: { ok: 'v', skipNull: null, skipObj: { a: 1 }, skipArr: [1] } },
    ]);
    expect(Object.keys(options)).toEqual(['ok']);
  });

  it('숫자·불리언 값은 문자열로 수집한다', () => {
    const options = collectNodePropertyOptions([
      { id: 'A', label: 'T', properties: { since: 2020, active: true } },
    ]);
    expect(options.since).toEqual(['2020']);
    expect(options.active).toEqual(['true']);
  });
});
