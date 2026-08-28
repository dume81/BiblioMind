import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  VIZ_STYLES,
  DEFAULT_VIZ_STYLE_ID,
  getVizStyle,
  resolveStyleProps,
  resolveStyleNotice,
  PARTICLE_LINK_THRESHOLD,
  BLOOM_NODE_THRESHOLD,
} from '../src/lib/vizStyles.js';
import { analyzeDag, isDirectedAcyclic } from '../src/lib/graphShape.js';

const ctx = (overrides = {}) => ({ reducedMotion: false, nodeCount: 30, linkCount: 50, ...overrides });

describe('시각화 스타일 레지스트리', () => {
  it('모든 스타일이 필수 필드(id, label, description)를 가진다', () => {
    VIZ_STYLES.forEach((style) => {
      expect(typeof style.id).toBe('string');
      expect(style.id.length).toBeGreaterThan(0);
      expect(typeof style.label).toBe('string');
      expect(style.label.length).toBeGreaterThan(0);
      expect(typeof style.description).toBe('string');
    });
  });

  it('id가 고유하다', () => {
    const ids = VIZ_STYLES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('기본 포함 최소 9개 스타일이 있다', () => {
    expect(VIZ_STYLES.length).toBeGreaterThanOrEqual(9);
  });

  it('첫 항목이자 기본값은 `기본`이며 오버라이드가 전혀 없다', () => {
    const first = VIZ_STYLES[0];
    expect(first.id).toBe(DEFAULT_VIZ_STYLE_ID);
    expect(first.label).toBe('기본');
    expect(first.props).toBeUndefined();
    expect(first.flags).toBeUndefined();
    expect(first.setup).toBeUndefined();
    expect(resolveStyleProps(first, ctx())).toEqual({});
    expect(resolveStyleNotice(first, ctx())).toBeNull();
  });

  it('기본이 아닌 모든 스타일은 참조 예제 폴더를 명시한다', () => {
    VIZ_STYLES.filter((s) => s.id !== DEFAULT_VIZ_STYLE_ID).forEach((style) => {
      expect(typeof style.referenceExample).toBe('string');
    });
  });

  it('getVizStyle: 알 수 없는 id는 기본으로 안전하게 폴백한다', () => {
    expect(getVizStyle('nonexistent').id).toBe(DEFAULT_VIZ_STYLE_ID);
    expect(getVizStyle('bloom').id).toBe('bloom');
  });

  it('setup이 있는 스타일은 flags 없이도 props가 안전하게 해석된다', () => {
    VIZ_STYLES.forEach((style) => {
      const props = resolveStyleProps(style, ctx());
      expect(props).toBeTypeOf('object');
    });
  });

  // react-kapsule은 렌더에서 "사라진 키"를 원복하지 않는다. 따라서 스타일이 쓰는
  // 모든 prop 키는 Graph3D의 base JSX에 기본값이 명시되어 있어야 스타일 이탈 시
  // 값 변경으로 원복된다. 이 테스트가 레지스트리와 base JSX의 동기화를 강제한다.
  it('모든 스타일 prop 키는 Graph3D base JSX에 기본값이 존재한다 (원복 보장)', () => {
    const graph3dSource = readFileSync(
      fileURLToPath(new URL('../src/components/Graph3D.jsx', import.meta.url)),
      'utf8',
    );
    const contexts = [
      ctx(),
      ctx({ reducedMotion: true }),
      ctx({ nodeCount: BLOOM_NODE_THRESHOLD + 1, linkCount: PARTICLE_LINK_THRESHOLD + 1 }),
    ];
    VIZ_STYLES.forEach((style) => {
      contexts.forEach((c) => {
        Object.keys(resolveStyleProps(style, c)).forEach((key) => {
          expect(
            graph3dSource.includes(key + '='),
            style.id + ' 스타일의 prop 키 "' + key + '"의 base 기본값이 Graph3D.jsx에 없습니다',
          ).toBe(true);
        });
      });
    });
  });
});

describe('이동 파티클 스타일 — 성능·모션 감쇠', () => {
  const particles = getVizStyle('particles');

  it('링크 임계값 초과 시 파티클 수를 줄이고 안내를 표시한다', () => {
    const big = ctx({ linkCount: PARTICLE_LINK_THRESHOLD + 1 });
    expect(resolveStyleProps(particles, big).linkDirectionalParticles).toBe(1);
    expect(resolveStyleNotice(particles, big)).toContain('파티클 수를 줄였습니다');

    const small = ctx({ linkCount: 10 });
    expect(resolveStyleProps(particles, small).linkDirectionalParticles).toBe(2);
    expect(resolveStyleNotice(particles, small)).toBeNull();
  });

  it('모션 감소 설정에서 파티클 속도를 낮춘다', () => {
    const reduced = resolveStyleProps(particles, ctx({ reducedMotion: true }));
    const normal = resolveStyleProps(particles, ctx({ reducedMotion: false }));
    expect(reduced.linkDirectionalParticleSpeed).toBeLessThan(normal.linkDirectionalParticleSpeed);
  });
});

describe('블룸·궤도·DAG 스타일 메타', () => {
  it('블룸은 노드 임계값 초과 시 안내를 표시한다', () => {
    const bloom = getVizStyle('bloom');
    expect(resolveStyleNotice(bloom, ctx({ nodeCount: BLOOM_NODE_THRESHOLD + 1 }))).toContain('블룸 강도');
    expect(resolveStyleNotice(bloom, ctx({ nodeCount: 10 }))).toBeNull();
  });

  // 이슈 5 사양 변경: 모션 감소 시 비활성 대신 느린 회전 + 정지/재생 버튼 제공.
  it('자동 궤도 회전은 모션 감소 시 느린 회전 안내를 표시한다', () => {
    const orbit = getVizStyle('autoOrbit');
    expect(resolveStyleNotice(orbit, ctx({ reducedMotion: true }))).toContain('느리게');
    expect(resolveStyleNotice(orbit, ctx({ reducedMotion: false }))).toContain('재생');
    expect(orbit.cameraStyle).toBe(true);
    expect(orbit.flags?.autoOrbit).toBe(true);
  });

  // 이슈 6 사양 변경: DAG 스타일은 상시 활성 — 사이클 간선은 계층 계산에서 제외.
  it('DAG 스타일은 방향(ctx.dagOrientation)을 반영하고 사이클 안내를 제공한다', () => {
    const dag = getVizStyle('dagMode');
    expect(dag.requiresDag).toBeUndefined();
    expect(resolveStyleProps(dag, ctx()).dagMode).toBe('td');
    expect(resolveStyleProps(dag, ctx({ dagOrientation: 'radialout' })).dagMode).toBe('radialout');
    expect(typeof resolveStyleProps(dag, ctx()).onDagError).toBe('function');
    expect(resolveStyleNotice(dag, ctx({ isDag: true }))).toBeNull();
    expect(resolveStyleNotice(dag, ctx({ isDag: false, cycleEdgeCount: 7 }))).toContain('7');
  });
});

describe('analyzeDag (사이클 간선 집계)', () => {
  const graph = (nodes, rels) => ({
    nodes: nodes.map((id) => ({ id, label: 'T', properties: {} })),
    relationships: rels.map(([s, e], i) => ({
      id: 'r' + i, type: 'REL', start_node_id: s, end_node_id: e, properties: {},
    })),
  });

  it('DAG이면 cycleEdgeCount 0', () => {
    expect(analyzeDag(graph(['A', 'B'], [['A', 'B']]))).toEqual({ isDag: true, cycleEdgeCount: 0 });
  });

  it('셀프 관계를 사이클 간선으로 센다', () => {
    const result = analyzeDag(graph(['A', 'B'], [['A', 'A'], ['A', 'B']]));
    expect(result.isDag).toBe(false);
    expect(result.cycleEdgeCount).toBe(1);
  });

  it('상호 참조 쌍의 간선을 사이클로 센다 (사이클 하류 간선은 제외)', () => {
    const result = analyzeDag(graph(['A', 'B', 'C'], [['A', 'B'], ['B', 'A'], ['A', 'C']]));
    expect(result.isDag).toBe(false);
    expect(result.cycleEdgeCount).toBe(2);
  });

  it('사이클 내부의 다중 관계는 관계 단위로 센다', () => {
    // A→B ×2, B→A ×1 — 같은 SCC 안의 관계 3개 전부
    const result = analyzeDag(graph(['A', 'B'], [['A', 'B'], ['A', 'B'], ['B', 'A']]));
    expect(result.cycleEdgeCount).toBe(3);
  });

  it('3개 노드 사이클의 간선 3개를 정확히 센다', () => {
    const result = analyzeDag(graph(['A', 'B', 'C'], [['A', 'B'], ['B', 'C'], ['C', 'A']]));
    expect(result.isDag).toBe(false);
    expect(result.cycleEdgeCount).toBe(3);
  });

  it('분리된 두 사이클을 모두 세고, 사이클을 잇는 다리 간선은 세지 않는다', () => {
    // A↔B 사이클(2) + C↔D 사이클(2), B→C는 서로 다른 SCC 간 다리 → 제외
    const result = analyzeDag(graph(
      ['A', 'B', 'C', 'D'],
      [['A', 'B'], ['B', 'A'], ['C', 'D'], ['D', 'C'], ['B', 'C']],
    ));
    expect(result.cycleEdgeCount).toBe(4);
  });

  it('대규모 단일 사이클(1만 노드)에서 스택 오버플로 없이 완료된다 (반복적 SCC)', () => {
    const size = 10000;
    const nodes = Array.from({ length: size }, (_, i) => 'n' + i);
    const rels = Array.from({ length: size }, (_, i) => ['n' + i, 'n' + ((i + 1) % size)]);
    const result = analyzeDag(graph(nodes, rels));
    expect(result.isDag).toBe(false);
    expect(result.cycleEdgeCount).toBe(size);
  });
});

describe('isDirectedAcyclic (DAG 판정)', () => {
  const graph = (nodes, rels) => ({
    nodes: nodes.map((id) => ({ id, label: 'T', properties: {} })),
    relationships: rels.map(([s, e], i) => ({
      id: 'r' + i, type: 'REL', start_node_id: s, end_node_id: e, properties: {},
    })),
  });

  it('비순환 그래프는 true', () => {
    expect(isDirectedAcyclic(graph(['A', 'B', 'C'], [['A', 'B'], ['B', 'C'], ['A', 'C']]))).toBe(true);
  });

  it('사이클이 있으면 false', () => {
    expect(isDirectedAcyclic(graph(['A', 'B', 'C'], [['A', 'B'], ['B', 'C'], ['C', 'A']]))).toBe(false);
  });

  it('셀프 관계는 사이클이다', () => {
    expect(isDirectedAcyclic(graph(['A'], [['A', 'A']]))).toBe(false);
  });

  it('다중 관계는 사이클 여부에 영향이 없다', () => {
    expect(isDirectedAcyclic(graph(['A', 'B'], [['A', 'B'], ['A', 'B']]))).toBe(true);
  });

  it('역방향 쌍은 사이클이다', () => {
    expect(isDirectedAcyclic(graph(['A', 'B'], [['A', 'B'], ['B', 'A']]))).toBe(false);
  });

  it('관계 없는 고립 노드 그래프는 true', () => {
    expect(isDirectedAcyclic(graph(['A', 'B'], []))).toBe(true);
  });

  it('null·빈 그래프는 false (DAG 스타일 비활성)', () => {
    expect(isDirectedAcyclic(null)).toBe(false);
    expect(isDirectedAcyclic(graph([], []))).toBe(false);
  });
});
