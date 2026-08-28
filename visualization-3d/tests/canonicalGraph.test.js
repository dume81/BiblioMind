import { describe, expect, it } from 'vitest';
import { normalizeCanonicalGraph, parseAndNormalizeJson } from '../src/lib/canonicalGraph.js';

const validInput = () => ({
  nodes: [
    { id: 'N0', label: '사람', properties: { name: '탄지로' } },
    { id: 'N1', label: '사람', properties: {} },
    { id: 'N2', label: '오니', properties: { name: '네즈코' } },
  ],
  relationships: [
    { type: 'PROTECTS', start_node_id: 'N0', end_node_id: 'N2', properties: { episode: 'S1E1' } },
    { type: 'KNOWS', start_node_id: 'N0', end_node_id: 'N1', properties: {} },
  ],
});

describe('normalizeCanonicalGraph', () => {
  it('유효한 그래프를 정규화한다', () => {
    const result = normalizeCanonicalGraph(validInput());
    expect(result.ok).toBe(true);
    expect(result.graph.nodes).toHaveLength(3);
    expect(result.graph.relationships).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  it('빈 properties {}는 정상 데이터로 유지한다', () => {
    const result = normalizeCanonicalGraph(validInput());
    expect(result.graph.nodes[1].properties).toEqual({});
    expect(result.graph.relationships[1].properties).toEqual({});
  });

  it('숫자 ID를 문자열로 정규화한다', () => {
    const result = normalizeCanonicalGraph({
      nodes: [
        { id: 0, label: 'A', properties: {} },
        { id: 1, label: 'B', properties: {} },
      ],
      relationships: [{ type: 'REL', start_node_id: 0, end_node_id: 1, properties: {} }],
    });
    expect(result.ok).toBe(true);
    expect(result.graph.nodes[0].id).toBe('0');
    expect(result.graph.relationships[0].start_node_id).toBe('0');
    expect(result.graph.relationships[0].end_node_id).toBe('1');
  });

  it('nodes 배열이 없으면 실패한다', () => {
    const result = normalizeCanonicalGraph({ relationships: [] });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('nodes');
  });

  it('relationships 배열이 없으면 실패한다', () => {
    const result = normalizeCanonicalGraph({ nodes: [] });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('relationships');
  });

  it('최상위가 객체가 아니면 실패한다', () => {
    expect(normalizeCanonicalGraph([1, 2]).ok).toBe(false);
    expect(normalizeCanonicalGraph('text').ok).toBe(false);
    expect(normalizeCanonicalGraph(null).ok).toBe(false);
  });

  it('중복 노드 ID를 거부한다', () => {
    const input = validInput();
    input.nodes.push({ id: 'N0', label: '중복', properties: {} });
    const result = normalizeCanonicalGraph(input);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('중복된 노드 ID');
  });

  it('빈 노드 ID를 거부한다', () => {
    const result = normalizeCanonicalGraph({
      nodes: [{ id: '  ', label: 'A', properties: {} }],
      relationships: [],
    });
    expect(result.ok).toBe(false);
  });

  it('빈 label은 "Node"로 처리하고 경고를 남긴다', () => {
    const result = normalizeCanonicalGraph({
      nodes: [{ id: 'N0', properties: {} }],
      relationships: [],
    });
    expect(result.ok).toBe(true);
    expect(result.graph.nodes[0].label).toBe('Node');
    expect(result.warnings).toHaveLength(1);
  });

  it('빈 관계 type을 거부한다', () => {
    const input = validInput();
    input.relationships.push({ type: '', start_node_id: 'N0', end_node_id: 'N1', properties: {} });
    expect(normalizeCanonicalGraph(input).ok).toBe(false);
  });

  it('존재하지 않는 노드를 참조하는 관계를 거부한다', () => {
    const input = validInput();
    input.relationships.push({ type: 'BAD', start_node_id: 'N0', end_node_id: 'GHOST', properties: {} });
    const result = normalizeCanonicalGraph(input);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('GHOST');
  });

  it('잘못된 properties(배열)를 거부한다', () => {
    const result = normalizeCanonicalGraph({
      nodes: [{ id: 'N0', label: 'A', properties: [] }],
      relationships: [],
    });
    expect(result.ok).toBe(false);
  });

  it('관계 ID가 없으면 안정적인 ID를 생성한다 (다중 관계 포함)', () => {
    const input = {
      nodes: [
        { id: 'A', label: 'T', properties: {} },
        { id: 'B', label: 'T', properties: {} },
      ],
      relationships: [
        { type: 'KNOWS', start_node_id: 'A', end_node_id: 'B', properties: {} },
        { type: 'KNOWS', start_node_id: 'A', end_node_id: 'B', properties: {} },
      ],
    };
    const first = normalizeCanonicalGraph(structuredClone(input));
    const second = normalizeCanonicalGraph(structuredClone(input));
    expect(first.ok).toBe(true);
    const ids = first.graph.relationships.map((r) => r.id);
    expect(new Set(ids).size).toBe(2);
    // 같은 입력이면 같은 ID (안정성)
    expect(second.graph.relationships.map((r) => r.id)).toEqual(ids);
  });

  it('명시된 관계 ID의 중복을 거부한다', () => {
    const input = validInput();
    input.relationships = [
      { id: 'R1', type: 'A', start_node_id: 'N0', end_node_id: 'N1', properties: {} },
      { id: 'R1', type: 'B', start_node_id: 'N1', end_node_id: 'N2', properties: {} },
    ];
    const result = normalizeCanonicalGraph(input);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('중복된 관계 ID');
  });

  it('다중·역방향·셀프 관계를 허용한다', () => {
    const result = normalizeCanonicalGraph({
      nodes: [
        { id: 'A', label: 'T', properties: {} },
        { id: 'B', label: 'T', properties: {} },
      ],
      relationships: [
        { type: 'X', start_node_id: 'A', end_node_id: 'B', properties: {} },
        { type: 'X', start_node_id: 'B', end_node_id: 'A', properties: {} },
        { type: 'Y', start_node_id: 'A', end_node_id: 'A', properties: {} },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.graph.relationships).toHaveLength(3);
  });

  it('빈 그래프를 거부한다', () => {
    const result = normalizeCanonicalGraph({ nodes: [], relationships: [] });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('빈 그래프');
  });

  it('Canonical Graph는 동결되어 변형할 수 없다', () => {
    'use strict';
    const result = normalizeCanonicalGraph(validInput());
    expect(Object.isFrozen(result.graph)).toBe(true);
    expect(Object.isFrozen(result.graph.nodes[0])).toBe(true);
    expect(Object.isFrozen(result.graph.nodes[0].properties)).toBe(true);
    expect(() => {
      result.graph.nodes[0].id = 'mutated';
    }).toThrow();
  });
});

describe('parseAndNormalizeJson', () => {
  it('JSON 구문 오류를 구조 오류와 구분해 보고한다', () => {
    const result = parseAndNormalizeJson('{ not json');
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('JSON 구문 오류');
  });

  it('같은 JSON의 텍스트 파싱 결과는 deep-equal이다 (붙여넣기 vs 파일 경로 동등성)', () => {
    const text = JSON.stringify(validInput());
    const fromPaste = parseAndNormalizeJson(text);
    const fromFile = normalizeCanonicalGraph(JSON.parse(text));
    expect(fromPaste.ok).toBe(true);
    expect(fromPaste.graph).toEqual(fromFile.graph);
  });

  it('UTF-8 한글 데이터를 정상 처리한다', () => {
    const result = parseAndNormalizeJson('{"nodes":[{"id":"한글아이디","label":"귀살대","properties":{"name":"카마도 탄지로"}}],"relationships":[]}');
    expect(result.ok).toBe(true);
    expect(result.graph.nodes[0].id).toBe('한글아이디');
    expect(result.graph.nodes[0].properties.name).toBe('카마도 탄지로');
  });
});
