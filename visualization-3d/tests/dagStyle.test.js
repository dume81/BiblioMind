import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeDagDepths } from '../src/lib/graphShape.js';
import { getVizStyle, resolveStyleProps, resolveStyleNotice, PARTICLE_LINK_THRESHOLD } from '../src/lib/vizStyles.js';

// DAG 트리 배치 스타일 — 참조 예제(example/tree) 인상 재현 회귀 테스트.

const ctx = (overrides = {}) => ({ reducedMotion: false, nodeCount: 30, linkCount: 50, ...overrides });

const data = (nodeIds, links) => ({
  nodes: nodeIds.map((id) => ({ id })),
  links: links.map(([s, t], i) => ({ id: 'l' + i, source: s, target: t })),
});

describe('computeDagDepths (계층 깊이 계산)', () => {
  it('체인 A→B→C는 깊이 0,1,2', () => {
    const depths = computeDagDepths(data(['A', 'B', 'C'], [['A', 'B'], ['B', 'C']]));
    expect(depths.get('A')).toBe(0);
    expect(depths.get('B')).toBe(1);
    expect(depths.get('C')).toBe(2);
  });

  it('다이아몬드에서는 최장 경로 깊이를 쓴다 (A→B→D와 A→D면 D는 2)', () => {
    const depths = computeDagDepths(data(['A', 'B', 'D'], [['A', 'B'], ['B', 'D'], ['A', 'D']]));
    expect(depths.get('D')).toBe(2);
  });

  // 라이브러리(three-forcegraph getDagDepths)와 같은 규칙: 순환을 닫는 간선만 무시하므로
  // 사이클 노드들도 진입 순서대로 서로 다른 층에 놓인다 — 크기가 화면 배치와 일치해야 한다.
  it('사이클 노드는 진입 순서대로 층이 갈린다 (A↔B → C이면 A=0, B=1, C=2)', () => {
    const depths = computeDagDepths(data(['A', 'B', 'C'], [['A', 'B'], ['B', 'A'], ['B', 'C']]));
    expect(depths.get('A')).toBe(0);
    expect(depths.get('B')).toBe(1);
    expect(depths.get('C')).toBe(2);
  });

  it('순환 고리(5-링)는 한 층에 뭉치지 않고 0~4층으로 퍼진다 (라이브러리 배치와 동일)', () => {
    const ids = ['A', 'B', 'C', 'D', 'E'];
    const links = ids.map((id, i) => [id, ids[(i + 1) % ids.length]]);
    const depths = computeDagDepths(data(ids, links));
    expect(ids.map((id) => depths.get(id))).toEqual([0, 1, 2, 3, 4]);
  });

  it('셀프 관계는 깊이에 영향이 없다', () => {
    const depths = computeDagDepths(data(['A', 'B'], [['A', 'A'], ['A', 'B']]));
    expect(depths.get('A')).toBe(0);
    expect(depths.get('B')).toBe(1);
  });

  it('source/target이 객체로 치환된 후에도 동작한다 (force-graph 렌더 후 상태)', () => {
    const mutated = {
      nodes: [{ id: 'A' }, { id: 'B' }],
      links: [{ id: 'l0', source: { id: 'A' }, target: { id: 'B' } }],
    };
    const depths = computeDagDepths(mutated);
    expect(depths.get('A')).toBe(0);
    expect(depths.get('B')).toBe(1);
  });

  it('빈·null 데이터는 빈 Map', () => {
    expect(computeDagDepths(null).size).toBe(0);
    expect(computeDagDepths({ nodes: [], links: [] }).size).toBe(0);
  });

  it('고립 노드는 깊이 0', () => {
    const depths = computeDagDepths(data(['A', 'B', 'C'], [['A', 'B']]));
    expect(depths.get('C')).toBe(0);
  });
});

describe('DAG 스타일 — 예제 인상 파라미터', () => {
  const dag = getVizStyle('dagMode');

  it('계층 간격을 넓게 쓰고(≥100) 감쇠를 낮춘다(0.3)', () => {
    const props = resolveStyleProps(dag, ctx());
    expect(props.dagLevelDistance).toBeGreaterThanOrEqual(100);
    expect(props.d3VelocityDecay).toBe(0.3);
  });

  it('깊이 기반 노드 크기 플래그와 카메라 정렬 표시가 있다', () => {
    expect(dag.flags?.dagDepthSizing).toBe(true);
    expect(dag.cameraStyle).toBe(true);
  });

  it('방향 파티클은 관계 임계값을 넘으면 끈다', () => {
    expect(resolveStyleProps(dag, ctx()).linkDirectionalParticles).toBe(2);
    const big = ctx({ linkCount: PARTICLE_LINK_THRESHOLD + 1 });
    expect(resolveStyleProps(dag, big).linkDirectionalParticles).toBe(0);
    expect(resolveStyleNotice(dag, { ...big, isDag: true })).toContain('파티클');
  });

  it('안내문은 사이클·파티클 안내를 조합한다', () => {
    expect(resolveStyleNotice(dag, ctx({ isDag: true }))).toBeNull();
    const both = resolveStyleNotice(dag, ctx({
      isDag: false, cycleEdgeCount: 3, linkCount: PARTICLE_LINK_THRESHOLD + 1,
    }));
    expect(both).toContain('사이클 관계 3개');
    expect(both).toContain('파티클');
  });
});

describe('Graph3D 배선 (소스 수준)', () => {
  const graph3dSource = readFileSync(
    fileURLToPath(new URL('../src/components/Graph3D.jsx', import.meta.url)),
    'utf8',
  );

  it('d3VelocityDecay의 base 기본값(0.4)이 명시되어 있다 (kapsule 원복 보장)', () => {
    expect(graph3dSource).toContain('d3VelocityDecay={0.4}');
  });

  it('깊이 계산·노드 크기·충돌 포스·정면 카메라가 배선되어 있다', () => {
    expect(graph3dSource).toContain('computeDagDepths(displayData)');
    expect(graph3dSource).toContain("fg.d3Force('collide', null);"); // 대칭 cleanup
    expect(graph3dSource).toContain('styleProps.dagMode');
  });

  // 리뷰 확정 결함 회귀 방지: 예약 맞춤(pendingFit)·정렬 tween이 스타일 이탈·사용자
  // 조작·수동 맞춤 뒤에 잔존하면 안 된다.
  it('카메라 취소 경로가 배선되어 있다 (사용자 조작·이탈 시 tween·예약 맞춤 원복)', () => {
    expect(graph3dSource).toContain('cancelOnUserInteraction');
    expect(graph3dSource).toContain('neutralizeCameraTween');
    // runZoomToFit은 예약된 맞춤을 소진해 수동 맞춤 후 중복 fit을 막는다
    expect(graph3dSource).toContain('pendingFitRef.current = false; // 수동·자동 맞춤 모두 예약된 맞춤을 소진한다');
    // reducedMotion은 의존성이 아니라 styleCtxRef로 읽는다 (OS 토글 시 카메라 점프 방지)
    expect(graph3dSource).toContain('styleCtxRef.current.reducedMotion ? 0 : 1200');
  });
});
