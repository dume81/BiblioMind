import { forceCollide } from 'd3-force-3d';
import { Vector2 } from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

// 시각화 스타일 선언적 레지스트리.
//
// 각 스타일은 동일한 하나의 <ForceGraph3D> 인스턴스에 적용되는 구성이다:
// - props:  정적 또는 ctx 함수형 prop 오버라이드.
//           중요: react-kapsule은 "사라진 키"를 원복하지 않으므로, 여기서 쓰는 모든 키는
//           Graph3D의 base JSX에 기본값이 명시되어 있어야 스타일 이탈 시 원복된다
//           (tests/vizStyles.test.js가 키 목록 일치를 검사한다).
// - flags:  Graph3D의 기존 접근자·이벤트에 통합되는 동작 스위치
// - setup:  부수효과가 필요한 스타일용. 반드시 대칭적인 cleanup 함수를 반환한다.
// - cameraStyle: 카메라 조작이 기능의 본질인 스타일
//
// ctx = { reducedMotion, nodeCount, linkCount, dagOrientation, isDag, cycleEdgeCount }

// 성능 임계값 (초과 시 자동 감쇠)
export const PARTICLE_LINK_THRESHOLD = 500;
export const BLOOM_NODE_THRESHOLD = 500;

export const DEFAULT_VIZ_STYLE_ID = 'default';

// DAG 배치 방향 선택지 (참조: example/tree)
export const DAG_ORIENTATIONS = [
  { id: 'td', label: '위 → 아래' },
  { id: 'bu', label: '아래 → 위' },
  { id: 'lr', label: '왼쪽 → 오른쪽' },
  { id: 'rl', label: '오른쪽 → 왼쪽' },
  { id: 'radialout', label: '중심 → 바깥' },
  { id: 'radialin', label: '바깥 → 중심' },
];

// 참조: example/bloom-effect — UnrealBloomPass 포스트프로세싱.
function setupBloom(fg, ctx) {
  if (!fg) return undefined;
  let composer;
  try {
    composer = fg.postProcessingComposer();
  } catch {
    return undefined;
  }
  if (!composer) return undefined;
  const pass = new UnrealBloomPass(
    new Vector2(1024, 1024),
    ctx.nodeCount > BLOOM_NODE_THRESHOLD ? 1.5 : 3,
    1,
    0,
  );
  composer.addPass(pass);
  return () => {
    composer.removePass(pass);
    pass.dispose?.();
  };
}

// 참조: example/collision-detection — 3D용 각색: 기존 center/charge 포스는 유지하고
// 노드 크기 기반 충돌 포스만 추가한다. 이탈 시 포스를 제거하고 재안정화한다.
function setupCollision(fg) {
  if (!fg?.d3Force) return undefined;
  fg.d3Force('collide', forceCollide((node) => 4 * Math.cbrt(node.val || 1.5) + 2));
  fg.d3ReheatSimulation?.();
  return () => {
    fg.d3Force('collide', null);
    fg.d3ReheatSimulation?.();
  };
}

export const VIZ_STYLES = [
  {
    id: 'default',
    label: '기본',
    description: '기존 기본 렌더링. 오버라이드 없음.',
  },
  {
    id: 'particles',
    label: '이동 파티클',
    description: '관계 방향을 따라 파티클이 이동합니다.',
    referenceExample: 'directional-links-particles',
    props: (ctx) => ({
      linkDirectionalParticles: ctx.linkCount > PARTICLE_LINK_THRESHOLD ? 1 : 2,
      linkDirectionalParticleWidth: 1.6,
      linkDirectionalParticleSpeed: ctx.reducedMotion ? 0.002 : 0.006,
    }),
    notice: (ctx) => {
      if (ctx.linkCount > PARTICLE_LINK_THRESHOLD) {
        return '관계가 ' + PARTICLE_LINK_THRESHOLD + '개를 넘어 파티클 수를 줄였습니다.';
      }
      return ctx.reducedMotion ? '모션 감소 설정에 맞춰 파티클 속도를 낮췄습니다.' : null;
    },
  },
  {
    id: 'autoColor',
    label: '관계 자동 색상',
    description: '관계 유형별로 색을 자동 배정합니다.',
    referenceExample: 'auto-colored',
    flags: { linkColorByType: true },
    props: () => ({ linkOpacity: 0.8 }),
  },
  {
    id: 'textNodes',
    label: '노드 이름 표시',
    description: '구체 대신 노드 이름 텍스트가 노드가 됩니다.',
    referenceExample: 'text-nodes',
    flags: { textAsNode: true },
  },
  {
    id: 'linkLabels',
    label: '관계 라벨 표시',
    description: '그래프 크기와 무관하게 모든 관계 라벨을 표시합니다.',
    referenceExample: 'text-links',
    flags: { alwaysLinkLabels: true },
  },
  {
    id: 'customShapes',
    label: '유형별 도형',
    description: '노드 유형(label)마다 다른 3D 도형을 배정합니다.',
    referenceExample: 'custom-node-shape',
    flags: { shapeByType: true },
  },
  {
    id: 'neighborHighlight',
    label: '이웃 하이라이트',
    description: '호버한 노드와 인접 노드·관계를 강조합니다.',
    referenceExample: 'highlight',
    flags: { hoverNeighborHighlight: true },
  },
  {
    id: 'multiSelection',
    label: '다중 선택',
    description: 'Ctrl/Shift+클릭으로 여러 노드를 선택하고 함께 이동합니다.',
    referenceExample: 'multi-selection',
    flags: { multiSelect: true },
    notice: () => 'Ctrl 또는 Shift를 누른 채 노드를 클릭하면 다중 선택됩니다. 선택된 노드는 함께 드래그됩니다.',
  },
  {
    id: 'expandCollapse',
    label: '탐색 (확장/접기)',
    description: '연결 많은 노드부터 시작해 클릭으로 이웃을 펼치고 접습니다.',
    referenceExample: 'expandable-nodes',
    flags: { expandable: true },
    notice: () => '노드를 클릭하면 그 이웃이 펼쳐지거나 접힙니다. 시작점은 연결이 가장 많은 노드입니다.',
  },
  {
    id: 'clickFocus',
    label: '클릭 포커스',
    description: '노드를 클릭하면 카메라가 해당 노드로 이동합니다.',
    referenceExample: 'click-to-focus',
    flags: { clickFocus: true },
    cameraStyle: true,
  },
  {
    id: 'autoOrbit',
    label: '자동 궤도 회전',
    description: '카메라가 그래프 주위를 자동으로 돕니다. 정지/재생 버튼 제공.',
    referenceExample: 'camera-auto-orbit',
    cameraStyle: true,
    flags: { autoOrbit: true },
    notice: (ctx) => (ctx.reducedMotion
      ? '모션 감소 설정에 맞춰 느리게 회전합니다. 카메라 조작 시 일시정지되며 [재생]으로 재개합니다.'
      : '카메라를 조작하면 회전이 일시정지됩니다. [재생] 버튼으로 재개하세요.'),
  },
  {
    id: 'dragFix',
    label: '드래그 고정',
    description: '드래그한 노드를 그 위치에 고정합니다.',
    referenceExample: 'fix-dragged-nodes',
    flags: { fixOnDrag: true },
    notice: () => '노드를 드래그하면 그 위치에 고정됩니다. [고정 해제]로 전체 해제할 수 있습니다.',
  },
  {
    id: 'collision',
    label: '충돌 감지',
    description: '노드들이 서로 겹치지 않게 밀어냅니다.',
    referenceExample: 'collision-detection',
    setup: setupCollision,
  },
  {
    id: 'emitParticles',
    label: '클릭 파티클 방출',
    description: '관계를 클릭하면 파티클이 방출됩니다.',
    referenceExample: 'emit-particles',
    flags: { emitOnLinkClick: true },
    props: () => ({
      linkDirectionalParticleColor: () => '#fb923c',
      linkDirectionalParticleWidth: 3,
      linkHoverPrecision: 6,
    }),
    notice: () => '관계(선)를 클릭하면 방향을 따라 파티클이 방출됩니다.',
  },
  {
    id: 'bloom',
    label: '블룸 효과',
    description: '네온처럼 빛나는 포스트프로세싱 효과.',
    referenceExample: 'bloom-effect',
    setup: setupBloom,
    notice: (ctx) => (ctx.nodeCount > BLOOM_NODE_THRESHOLD
      ? '노드가 ' + BLOOM_NODE_THRESHOLD + '개를 넘어 블룸 강도를 낮췄습니다.'
      : null),
  },
  {
    id: 'largeGraph',
    label: '대규모 성능 모드',
    description: '라벨·지오메트리를 줄여 대규모 그래프 성능을 확보합니다.',
    referenceExample: 'large-graph',
    flags: { suppressLabels: true },
    props: () => ({ nodeResolution: 8, linkOpacity: 0.35 }),
    notice: () => '성능을 위해 라벨을 숨기고 렌더링 품질을 낮춘 모드입니다. tooltip은 유지됩니다.',
  },
  {
    id: 'arrowEmphasis',
    label: '화살표 강조',
    description: '관계 방향 화살표를 크게 표시합니다.',
    referenceExample: 'directional-links-arrows',
    props: () => ({
      linkDirectionalArrowLength: 6.5,
      linkDirectionalArrowRelPos: 1,
    }),
  },
  {
    id: 'dagMode',
    label: 'DAG 트리 배치',
    description: '계층형 배치 — 뿌리일수록 큰 노드, 정면 카메라 정렬, 흐름 파티클. 순환을 닫는 간선은 계층에서 무시됩니다.',
    referenceExample: 'tree',
    // 참조 예제(example/tree)의 인상 재현: 넓은 계층 간격 + 계층 깊이 기반 노드 크기
    // (dagDepthSizing → Graph3D에서 nodeVal·충돌 포스 처리) + 낮은 감쇠 + 방향 파티클.
    cameraStyle: true, // 진입·방향 변경 시 계층이 읽히는 정면으로 카메라를 정렬한다
    flags: { dagDepthSizing: true },
    props: (ctx) => ({
      dagMode: ctx.dagOrientation || 'td',
      dagLevelDistance: 120,
      onDagError: () => {}, // 사이클을 만나도 예외 없이 계속 진행 (해당 간선은 계층에서 제외)
      d3VelocityDecay: 0.3,
      linkOpacity: 0.4,
      linkDirectionalParticles: ctx.linkCount > PARTICLE_LINK_THRESHOLD ? 0 : 2,
      linkDirectionalParticleWidth: 1.2,
      linkDirectionalParticleSpeed: ctx.reducedMotion ? 0.002 : 0.006,
    }),
    notice: (ctx) => {
      const parts = [];
      if (!ctx.isDag) {
        parts.push('사이클 관계 ' + (ctx.cycleEdgeCount ?? 0) + '개 감지 — 순환을 닫는 간선은 계층 계산에서 무시됩니다.');
      }
      if (ctx.linkCount > PARTICLE_LINK_THRESHOLD) {
        parts.push('관계가 ' + PARTICLE_LINK_THRESHOLD + '개를 넘어 파티클은 표시하지 않습니다.');
      }
      return parts.length > 0 ? parts.join(' ') : null;
    },
  },
];

export function getVizStyle(id) {
  return VIZ_STYLES.find((style) => style.id === id) || VIZ_STYLES[0];
}

export function resolveStyleProps(style, ctx) {
  if (!style || !style.props) return {};
  return typeof style.props === 'function' ? style.props(ctx) : style.props;
}

export function resolveStyleNotice(style, ctx) {
  if (!style || !style.notice) return null;
  return typeof style.notice === 'function' ? style.notice(ctx) : style.notice;
}
