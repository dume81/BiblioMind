import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeCanonicalGraph, parseAndNormalizeJson } from '../src/lib/canonicalGraph.js';
import { buildRenderData } from '../src/lib/renderData.js';
import { collectRelationshipProperties } from '../src/lib/filters.js';
import { getColorForNodeType } from '../src/lib/colors.js';

// 대표 귀멸의 칼날 JSON fixture (원본 KG_Demon Slayer_Draft_01.json의 사본).
const fixtureText = readFileSync(
  fileURLToPath(new URL('./fixtures/kg-demon-slayer.json', import.meta.url)),
  'utf8',
);

describe('대표 귀멸의 칼날 JSON fixture', () => {
  it('정규화에 성공하고 전체 노드·관계를 보존한다', () => {
    const result = parseAndNormalizeJson(fixtureText);
    expect(result.ok).toBe(true);
    const raw = JSON.parse(fixtureText);
    expect(result.graph.nodes).toHaveLength(raw.nodes.length);
    expect(result.graph.relationships).toHaveLength(raw.relationships.length);
    expect(result.graph.nodes.length).toBeGreaterThan(0);
  });

  it('붙여넣기 경로와 파일 경로의 결과가 deep-equal이다', () => {
    const fromPaste = parseAndNormalizeJson(fixtureText);
    const fromFile = normalizeCanonicalGraph(JSON.parse(fixtureText));
    expect(fromPaste.graph).toEqual(fromFile.graph);
  });

  it('한글 표시 이름과 properties를 보존한다', () => {
    const { graph } = parseAndNormalizeJson(fixtureText);
    const tanjiro = graph.nodes.find((n) => n.properties.name === '카마도 탄지로');
    expect(tanjiro).toBeDefined();
    expect(tanjiro.label).toBe('Person');
  });

  it('렌더 데이터 생성이 성공하고 노드 유형별 색상이 결정적이다', () => {
    const { graph } = parseAndNormalizeJson(fixtureText);
    const render = buildRenderData(graph);
    expect(render.nodes).toHaveLength(graph.nodes.length);
    expect(render.links).toHaveLength(graph.relationships.length);
    render.nodes.forEach((node) => {
      expect(node.color).toBe(getColorForNodeType(node.label));
    });
  });

  it('필터 후보가 그래프에서 동적으로 계산된다', () => {
    const { graph } = parseAndNormalizeJson(fixtureText);
    const props = collectRelationshipProperties(graph.relationships);
    expect(props.type.length).toBeGreaterThan(0);
    // 필터 후보의 모든 값은 실제로 매칭 가능한 값이어야 한다.
    const allTypes = new Set(graph.relationships.map((r) => r.type));
    props.type.forEach((value) => expect(allTypes.has(value)).toBe(true));
  });
});
