import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import SpriteText from 'three-spritetext';
import {
  Mesh, MeshLambertMaterial, SphereGeometry, BoxGeometry, ConeGeometry, TorusGeometry,
  OctahedronGeometry, TetrahedronGeometry, CylinderGeometry, DodecahedronGeometry,
} from 'three';
import { makeNodeTooltip, makeLinkTooltip } from '../lib/renderData.js';
import { getColorForNodeType } from '../lib/colors.js';
import { resolveStyleProps } from '../lib/vizStyles.js';
import { nodeHighlightState, linkHighlightState, brightenColor } from '../lib/queryHighlight.js';
import { createPinTracker } from '../lib/pinTracker.js';
import { computeDagDepths, computeExpandedSubset, findHighestDegreeNodeId } from '../lib/graphShape.js';
import { forceCollide } from 'd3-force-3d';

// 물리 엔진 정지 기준은 벽시계가 아니라 tick 수여야 한다: 기본값(cooldownTime 15s)은
// 백그라운드 탭에서 rAF가 멈춘 동안에도 수명이 소진되어, 탭 복귀 첫 프레임에 tick 0회로
// 엔진이 즉시 종료된다(밀집 동결 + 밀착 zoomToFit → 라벨 과대). d3AlphaDecay 기본값은
// 정확히 300 tick에 d3 표준 수렴(alpha 0.001)에 도달하므로 300이면 전경 동작이 동일하다.
export const SIMULATION_COOLDOWN_TICKS = 300;

// 라벨 LOD 기준: 소규모 그래프는 이름·관계 type을 기본 표시하고,
// 대규모 그래프는 선택·검색·강조된 항목 중심으로만 라벨을 표시한다.
export const NODE_LABEL_LOD_THRESHOLD = 120;
export const LINK_LABEL_LOD_THRESHOLD = 80;

// 렌더링 품질 상수.
export const MAX_PIXEL_RATIO = 2;
export const SPRITE_TEXT_FONT_SIZE = 180;
export const NODE_SPHERE_RESOLUTION = 16;

const DIMMED_NODE_COLOR = 'rgba(71, 85, 105, 0.25)';
const DEFAULT_LINK_COLOR = 'rgba(148, 163, 184, 0.55)';
const DIMMED_LINK_COLOR = 'rgba(71, 85, 105, 0.15)';
const HIGHLIGHT_COLOR = '#facc15';
// 이웃 하이라이트 스타일에서 호버 인접 관계에 쓰는 색 (선택 강조 노랑과 구분)
const HOVER_LINK_COLOR = '#fb923c';
// 쿼리 하이라이트 1층 관계 색 (§7.4 "은은한 강조" — 기본 회색보다 밝게)
const QUERY_L1_LINK_COLOR = 'rgba(226, 232, 240, 0.85)';

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function toTooltipHtml(text) {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

function linkEndpointId(endpoint) {
  return typeof endpoint === 'object' && endpoint !== null ? endpoint.id : endpoint;
}

// 유형별 도형 스타일: label 해시로 도형을 결정적으로 배정한다 (참조: example/custom-node-shape의 3D 각색).
const SHAPE_GEOMETRIES = [
  () => new SphereGeometry(5, 16, 16),
  () => new BoxGeometry(8, 8, 8),
  () => new ConeGeometry(5, 10, 12),
  () => new TorusGeometry(5, 2, 10, 20),
  () => new OctahedronGeometry(6),
  () => new TetrahedronGeometry(7),
  () => new CylinderGeometry(4, 4, 9, 12),
  () => new DodecahedronGeometry(6),
];
const shapeGeometryCache = new Map();

function getShapeGeometryForLabel(label) {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = ((hash << 5) - hash) + label.charCodeAt(i);
    hash = hash & hash;
  }
  const index = Math.abs(hash) % SHAPE_GEOMETRIES.length;
  if (!shapeGeometryCache.has(index)) {
    shapeGeometryCache.set(index, SHAPE_GEOMETRIES[index]());
  }
  return shapeGeometryCache.get(index);
}

export const Graph3D = forwardRef(function Graph3D(
  {
    data, graphKey, width, height,
    selectedNodeType, propertyHighlight, selection, onSelectionChange, queryHighlight, searchTerm,
    vizStyle, reducedMotion = false, dagOrientation,
    orbitPlaying = true, onOrbitInterrupted,
    multiSelectedIds, onMultiSelectedChange,
  },
  ref,
) {
  const fgRef = useRef(null);
  // 새 그래프가 성공적으로 교체된 경우에만 안정화 후 카메라 맞춤을 1회 수행한다.
  const pendingFitRef = useRef(false);
  // 카메라 맞춤(zoomToFit) tween이 진행되는 동안 자동 궤도 회전을 일시 중단한다 —
  // 궤도 tick의 cameraPosition 호출이 진행 중인 tween을 종료시키기 때문.
  const orbitSuspendUntilRef = useRef(0);

  // 진행 중인 카메라 tween을 현재 위치 기준 0ms 호출로 중화한다 — three-render-objects는
  // 새 cameraPosition 호출 시 이전 tween을 .end()(최종 위치로 스냅)시키므로, 같은 동기 호출
  // 안에서 현재 위치로 되돌려 써 화면 점프 없이 취소하는 효과를 낸다.
  const neutralizeCameraTween = useCallback(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const p = fg.cameraPosition();
    const t = fg.controls?.()?.target;
    fg.cameraPosition({ x: p.x, y: p.y, z: p.z }, t ? { x: t.x, y: t.y, z: t.z } : undefined, 0);
  }, []);

  const runZoomToFit = useCallback(() => {
    pendingFitRef.current = false; // 수동·자동 맞춤 모두 예약된 맞춤을 소진한다 (중복 fit 방지)
    neutralizeCameraTween(); // 진행 중 tween이 있으면 스냅 점프 없이 현재 위치에서 맞춤을 시작한다
    orbitSuspendUntilRef.current = Date.now() + 700; // tween 400ms + 여유
    fgRef.current?.zoomToFit(400);
  }, [neutralizeCameraTween]);

  useEffect(() => {
    pendingFitRef.current = true;
  }, [graphKey]);

  // 디스플레이 배율(devicePixelRatio)을 렌더러·포스트프로세싱 composer에 반영해
  // 드로잉 버퍼를 실제 화면 해상도에 맞춘다 (상한 MAX_PIXEL_RATIO).
  const applyPixelRatio = useCallback(() => {
    const fg = fgRef.current;
    const renderer = fg?.renderer?.();
    if (!renderer) return;
    const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    if (renderer.getPixelRatio() !== ratio) {
      renderer.setPixelRatio(ratio); // 내부적으로 현재 크기 기준 드로잉 버퍼를 재생성한다
      try {
        // 블룸 등 포스트프로세싱 composer도 같은 배율로 맞춘다.
        const composer = fg.postProcessingComposer?.();
        composer?.setPixelRatio?.(ratio);
        composer?.setSize?.(width, height);
      } catch {
        // composer가 없는 환경은 무시
      }
    }
  }, [width, height]);

  // 마운트·크기 변경(전체 화면 진입·종료 포함) 시 반영.
  useEffect(() => {
    applyPixelRatio();
  }, [applyPixelRatio]);

  // 브라우저 줌·모니터 이동으로 devicePixelRatio가 바뀌면 재적용한다.
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    let mq = null;
    const onChange = () => {
      applyPixelRatio();
      arm();
    };
    const arm = () => {
      mq?.removeEventListener?.('change', onChange);
      mq = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)');
      mq.addEventListener?.('change', onChange);
    };
    arm();
    return () => mq?.removeEventListener?.('change', onChange);
  }, [applyPixelRatio]);

  // 시각화 스타일 — `기본`(flags 없음)이면 모든 분기가 꺼져 기존 렌더 경로와 동일하다.
  const flags = vizStyle?.flags || {};
  const nodeCount = data.nodes.length;
  const linkCount = data.links.length;

  const styleProps = useMemo(
    () => resolveStyleProps(vizStyle, { reducedMotion, nodeCount, linkCount, dagOrientation }),
    [vizStyle, reducedMotion, nodeCount, linkCount, dagOrientation],
  );

  // 쿼리 하이라이트 파티클 (§7.4): 2층 관계에만 방향 이동 파티클 — per-link accessor.
  // styleProps 뒤에 전개해 어떤 스타일 위에도 오버라이드된다. 사용 키 3종은 모두
  // base JSX에 기본값이 있어 하이라이트 해제 시 원복된다 (파일 말미 주석 참조).
  const queryParticleProps = useMemo(() => {
    if (!queryHighlight?.active) return {};
    return {
      linkDirectionalParticles: (link) => (linkHighlightState(queryHighlight, link.id) === 'layer2' ? 2 : 0),
      linkDirectionalParticleWidth: 1.6,
      linkDirectionalParticleSpeed: reducedMotion ? 0.002 : 0.006,
    };
  }, [queryHighlight, reducedMotion]);

  // setup에 넘길 최신 컨텍스트. 부수효과 재실행 조건과 분리하기 위해 ref로 전달한다.
  const styleCtxRef = useRef({ reducedMotion, nodeCount, linkCount });
  styleCtxRef.current = { reducedMotion, nodeCount, linkCount };

  // 부수효과 스타일(블룸·충돌 포스 등): setup은 반드시 대칭적인 cleanup을 반환한다.
  // graphKey(새 데이터 교체)에는 재설정하지만 필터로 개수만 바뀌는 경우에는 재실행하지 않는다.
  useEffect(() => {
    if (!vizStyle?.setup) return undefined;
    const cleanup = vizStyle.setup(fgRef.current, styleCtxRef.current);
    return () => {
      cleanup?.();
    };
  }, [vizStyle, reducedMotion, graphKey]);

  // --- 드래그 고정 (이슈 1 수정: 추적기에 pin() 등록 누락 버그 해결) ---
  const pinTrackerRef = useRef(createPinTracker());

  useEffect(() => {
    // 새 그래프로 교체되면 렌더 객체가 새로 만들어지므로 추적을 초기화한다.
    pinTrackerRef.current.clear();
  }, [graphKey]);

  const releaseAllPins = useCallback(() => {
    const released = pinTrackerRef.current.releaseAll();
    if (released > 0) fgRef.current?.d3ReheatSimulation();
  }, []);

  // 드래그 고정 스타일을 떠나면 고정을 전체 해제한다 (대칭 원복).
  useEffect(() => {
    if (!flags.fixOnDrag) releaseAllPins();
  }, [flags.fixOnDrag, releaseAllPins]);

  useImperativeHandle(ref, () => ({
    zoomToFit: runZoomToFit,
    releaseFixedNodes: releaseAllPins,
  }), [runZoomToFit, releaseAllPins]);

  // --- 자동 궤도 회전 (이슈 5 재설계: 매 tick 현재 카메라 기준으로 회전해
  //     zoomToFit 이후에도 자연스럽고, 사용자 조작 시 일시정지 → [재생]으로 재개) ---
  useEffect(() => {
    if (!flags.autoOrbit || !orbitPlaying) return undefined;
    const fg = fgRef.current;
    if (!fg) return undefined;
    const step = reducedMotion ? Math.PI / 1500 : Math.PI / 300;
    const interval = setInterval(() => {
      // 카메라 맞춤 tween 진행 중에는 회전을 멈춰 tween을 방해하지 않는다.
      if (Date.now() < orbitSuspendUntilRef.current) return;
      const p = fg.cameraPosition();
      const radius = Math.hypot(p.x, p.z) || 300;
      const angle = Math.atan2(p.x, p.z) + step;
      const target = fg.controls()?.target;
      fg.cameraPosition(
        { x: radius * Math.sin(angle), y: p.y, z: radius * Math.cos(angle) },
        target ? { x: target.x, y: target.y, z: target.z } : undefined,
      );
    }, 10);
    const controls = fg.controls();
    const onUserInteraction = () => onOrbitInterrupted?.();
    controls?.addEventListener?.('start', onUserInteraction);
    return () => {
      clearInterval(interval);
      controls?.removeEventListener?.('start', onUserInteraction);
    };
  }, [flags.autoOrbit, orbitPlaying, reducedMotion, onOrbitInterrupted]);

  // --- 탐색 (확장/접기) 스타일 ---
  // 하나의 effect에서 검증·재시드까지 처리한다:
  // - 새 데이터 로드: 이전 그래프의 id는 새 data.nodes에 없으므로 모두 걸러져 자동 재시드
  // - 필터로 확장 노드가 제거된 경우: 유효 id만 남기고, 전부 사라지면 현재 데이터 기준 재시드
  //   (빈 화면에 갇히는 상황 방지)
  const [expandedIds, setExpandedIds] = useState(null);

  useEffect(() => {
    if (!flags.expandable) {
      setExpandedIds(null);
      return;
    }
    setExpandedIds((prev) => {
      const nodeIds = new Set(data.nodes.map((n) => n.id));
      const valid = new Set([...(prev || [])].filter((id) => nodeIds.has(id)));
      if (valid.size > 0) {
        return valid.size === (prev?.size || 0) ? prev : valid;
      }
      const seed = findHighestDegreeNodeId(data);
      return seed ? new Set([seed]) : null;
    });
  }, [flags.expandable, data]);

  const displayData = useMemo(() => {
    if (flags.expandable && expandedIds) {
      return computeExpandedSubset(data, expandedIds);
    }
    return data;
  }, [flags.expandable, expandedIds, data]);

  // --- DAG 트리 배치 스타일: 참조 예제(tree)의 인상 재현 ---
  // 계층 깊이(뿌리=0)를 계산해 뿌리일수록 노드를 크게 그린다.
  const dagDepths = useMemo(
    () => (flags.dagDepthSizing ? computeDagDepths(displayData) : null),
    [flags.dagDepthSizing, displayData],
  );

  // 커진 상위 계층 노드들이 겹치지 않도록 크기 기반 충돌 포스를 함께 적용한다
  // (참조 예제 tree의 레벨 기반 충돌 포스의 3D 각색). 스타일 이탈 시 대칭 제거.
  useEffect(() => {
    const fg = fgRef.current;
    if (!flags.dagDepthSizing || !dagDepths || !fg?.d3Force) return undefined;
    fg.d3Force('collide', forceCollide(
      (node) => 4 * Math.cbrt(Math.max(1.5, 24 / ((dagDepths.get(node.id) ?? 0) + 1))) + 3,
    ));
    fg.d3ReheatSimulation?.();
    return () => {
      fg.d3Force('collide', null);
      fg.d3ReheatSimulation?.();
    };
  }, [flags.dagDepthSizing, dagDepths]);

  // DAG 진입·방향 변경·새 데이터 로드 시 계층이 읽히는 정면으로 카메라를 정렬하고,
  // 시뮬레이션이 안정되면 화면 맞춤 1회(onEngineStop → pendingFitRef 경로 재사용).
  // 사용자가 카메라를 잡으면 정렬 tween과 예약된 맞춤을 모두 취소해 시점을 빼앗지 않고,
  // 스타일 이탈 시에도 tween·예약 맞춤이 다음 스타일로 새지 않도록 cleanup에서 원복한다.
  // reducedMotion은 tween 지속시간에만 쓰이므로 styleCtxRef로 읽어 재실행을 막는다
  // (의존성에 넣으면 OS 토글마다 카메라 점프 + 소진 불가능한 예약 맞춤이 생긴다).
  useEffect(() => {
    if (!styleProps.dagMode) return undefined;
    const fg = fgRef.current;
    if (!fg) return undefined;
    pendingFitRef.current = true;
    let tweenStarted = false;
    const timer = setTimeout(() => {
      tweenStarted = true;
      const p = fg.cameraPosition();
      const dist = Math.hypot(p.x, p.y, p.z) || 600;
      fg.cameraPosition(
        { x: 0, y: 0, z: dist },
        { x: 0, y: 0, z: 0 },
        styleCtxRef.current.reducedMotion ? 0 : 1200,
      );
    }, 400);
    const controls = fg.controls?.();
    const cancelOnUserInteraction = () => {
      clearTimeout(timer);
      pendingFitRef.current = false;
      if (tweenStarted) neutralizeCameraTween();
    };
    controls?.addEventListener?.('start', cancelOnUserInteraction);
    return () => {
      clearTimeout(timer);
      controls?.removeEventListener?.('start', cancelOnUserInteraction);
      pendingFitRef.current = false;
      if (tweenStarted) neutralizeCameraTween();
    };
  }, [styleProps.dagMode, graphKey, neutralizeCameraTween]);

  const smallNodeGraph = displayData.nodes.length <= NODE_LABEL_LOD_THRESHOLD;
  const smallLinkGraph = displayData.links.length <= LINK_LABEL_LOD_THRESHOLD;

  const nodeById = useMemo(() => {
    const map = new Map();
    data.nodes.forEach((node) => map.set(node.id, node));
    return map;
  }, [data]);

  const normalizedSearch = (searchTerm || '').trim().toLowerCase();
  const searchMatchIds = useMemo(() => {
    if (!normalizedSearch) return null;
    const ids = new Set();
    data.nodes.forEach((node) => {
      const haystack = (node.name + ' ' + node.label + ' ' + node.id).toLowerCase();
      if (haystack.includes(normalizedSearch)) ids.add(node.id);
    });
    return ids;
  }, [data, normalizedSearch]);

  // --- 이웃 하이라이트 스타일 ---
  const [hoveredNodeId, setHoveredNodeId] = useState(null);

  useEffect(() => {
    if (!flags.hoverNeighborHighlight) setHoveredNodeId(null);
  }, [flags.hoverNeighborHighlight]);

  const neighborsById = useMemo(() => {
    if (!flags.hoverNeighborHighlight) return null;
    const map = new Map();
    data.nodes.forEach((node) => map.set(node.id, { nodes: new Set(), links: new Set() }));
    data.links.forEach((link) => {
      const sourceId = linkEndpointId(link.source);
      const targetId = linkEndpointId(link.target);
      map.get(sourceId)?.nodes.add(targetId);
      map.get(sourceId)?.links.add(link.id);
      map.get(targetId)?.nodes.add(sourceId);
      map.get(targetId)?.links.add(link.id);
    });
    return map;
  }, [flags.hoverNeighborHighlight, data]);

  const hoverInfo = flags.hoverNeighborHighlight && hoveredNodeId
    ? neighborsById?.get(hoveredNodeId) || null
    : null;

  const isHoverAdjacentNode = useCallback((nodeId) => {
    if (!hoverInfo) return false;
    return nodeId === hoveredNodeId || hoverInfo.nodes.has(nodeId);
  }, [hoverInfo, hoveredNodeId]);

  // 쿼리 하이라이트(3상태 오버라이드 — §7.4·§7.5): 활성이면 호버·유형/속성·검색보다
  // 우선하고, 클릭 선택·다중 선택만 그 위에서 동작한다.
  const queryActive = Boolean(queryHighlight?.active);

  // Property/Value 하이라이트: 값까지 선택된 경우에만 활성으로 취급한다.
  const propertyHighlightActive = Boolean(propertyHighlight?.property && propertyHighlight?.value);

  const matchesPropertyHighlight = useCallback((node) => {
    if (!propertyHighlightActive) return false;
    const raw = node.properties?.[propertyHighlight.property];
    return raw !== null && raw !== undefined && String(raw) === propertyHighlight.value;
  }, [propertyHighlightActive, propertyHighlight]);

  // 기존 강조 판정 (선택 > 다중 선택 > 유형·속성 하이라이트 > 검색) — 라벨 스프라이트는 이 기준만 사용
  // (호버까지 반영하면 호버마다 3D 오브젝트가 재생성되어 성능이 나빠진다).
  const isNodeEmphasizedBase = useCallback((node) => {
    if (selection?.kind === 'node' && selection.id === node.id) return true;
    if (multiSelectedIds?.has(node.id)) return true;
    if (selectedNodeType && node.label === selectedNodeType) return true;
    if (matchesPropertyHighlight(node)) return true;
    if (searchMatchIds?.has(node.id)) return true;
    return false;
  }, [selection, multiSelectedIds, selectedNodeType, matchesPropertyHighlight, searchMatchIds]);

  const isNodeEmphasized = useCallback((node) => {
    if (isNodeEmphasizedBase(node)) return true;
    if (isHoverAdjacentNode(node.id)) return true;
    return false;
  }, [isNodeEmphasizedBase, isHoverAdjacentNode]);

  const isNodeDimmed = useCallback((node) => {
    if (selectedNodeType && node.label !== selectedNodeType) return true;
    if (propertyHighlightActive && !matchesPropertyHighlight(node)) return true;
    if (searchMatchIds && !searchMatchIds.has(node.id)) return true;
    if (hoverInfo && !isHoverAdjacentNode(node.id)) return true;
    return false;
  }, [selectedNodeType, propertyHighlightActive, matchesPropertyHighlight, searchMatchIds, hoverInfo, isHoverAdjacentNode]);

  // 쿼리 하이라이트의 노드 강조색 (§7.4 — 2층 하이라이트 색 / 1층 원색+밝기 상향).
  // 'out'·비활성은 null — 각 렌더 스타일의 dim 문법에 맡긴다 (겹침 레이어 공용).
  const queryEmphasisColor = useCallback((node) => {
    if (!queryActive) return null;
    const state = nodeHighlightState(queryHighlight, node.id);
    if (state === 'layer2') return HIGHLIGHT_COLOR;
    if (state === 'layer1') return brightenColor(node.color);
    return null;
  }, [queryActive, queryHighlight]);

  const nodeColor = useCallback((node) => {
    if (multiSelectedIds?.has(node.id)) return HIGHLIGHT_COLOR;
    if (queryActive) return queryEmphasisColor(node) || DIMMED_NODE_COLOR;
    return isNodeDimmed(node) && !isNodeEmphasized(node) ? DIMMED_NODE_COLOR : node.color;
  }, [multiSelectedIds, queryActive, queryEmphasisColor, isNodeDimmed, isNodeEmphasized]);

  const nodeVal = useCallback((node) => {
    const selected = selection?.kind === 'node' && selection.id === node.id;
    if (dagDepths) {
      // 뿌리(상위 계층)일수록 큰 노드 — 참조 예제 tree의 nodeVal=100/(level+1) 각색.
      const base = Math.max(1.5, 24 / ((dagDepths.get(node.id) ?? 0) + 1));
      return selected ? base * 1.6 : base;
    }
    return selected ? 4 : 1.5;
  }, [selection, dagDepths]);

  // 겹침 레이어(§7.1)가 텍스트·도형 노드 스타일에도 적용되도록 dim 판정을 공유한다.
  const isNodeDimmedForObject = useCallback((node) => {
    if (queryActive) return nodeHighlightState(queryHighlight, node.id) === 'out';
    return isNodeDimmed(node) && !isNodeEmphasized(node);
  }, [queryActive, queryHighlight, isNodeDimmed, isNodeEmphasized]);

  // 텍스트 노드 스타일 (참조: example/text-nodes)
  const textNodeThreeObject = useCallback((node) => {
    const sprite = new SpriteText(node.name);
    sprite.material.depthWrite = false;
    sprite.fontSize = SPRITE_TEXT_FONT_SIZE;
    sprite.color = queryEmphasisColor(node)
      || (isNodeDimmedForObject(node) ? 'rgba(100, 116, 139, 0.4)' : node.color);
    sprite.textHeight = 6;
    return sprite;
  }, [queryEmphasisColor, isNodeDimmedForObject]);

  // 유형별 도형 스타일
  const shapeNodeThreeObject = useCallback((node) => {
    const material = new MeshLambertMaterial({
      color: multiSelectedIds?.has(node.id)
        ? HIGHLIGHT_COLOR
        : queryEmphasisColor(node) || node.color,
      transparent: true,
      opacity: isNodeDimmedForObject(node) ? 0.2 : 0.9,
    });
    return new Mesh(getShapeGeometryForLabel(node.label), material);
  }, [multiSelectedIds, queryEmphasisColor, isNodeDimmedForObject]);

  // 기본 라벨 스프라이트: 호버 상태에 의존하지 않는다 (호버마다 오브젝트 재생성 방지).
  const labelNodeThreeObject = useCallback((node) => {
    if (flags.suppressLabels) return undefined;
    const showLabel = smallNodeGraph || isNodeEmphasizedBase(node);
    if (!showLabel) return undefined;
    const sprite = new SpriteText(node.name);
    sprite.material.depthWrite = false;
    sprite.fontSize = SPRITE_TEXT_FONT_SIZE;
    sprite.color = isNodeEmphasizedBase(node) && (selection?.kind === 'node' && selection.id === node.id)
      ? HIGHLIGHT_COLOR
      : '#f8fafc';
    sprite.textHeight = 3.5;
    sprite.position.y = 7;
    return sprite;
  }, [flags.suppressLabels, smallNodeGraph, isNodeEmphasizedBase, selection]);

  const nodeThreeObject = flags.textAsNode
    ? textNodeThreeObject
    : flags.shapeByType
      ? shapeNodeThreeObject
      : labelNodeThreeObject;

  const linkColor = useCallback((link) => {
    if (selection?.kind === 'link' && selection.id === link.id) return HIGHLIGHT_COLOR;
    if (queryActive) {
      const state = linkHighlightState(queryHighlight, link.id);
      if (state === 'layer2') return HIGHLIGHT_COLOR;
      if (state === 'layer1') {
        return flags.linkColorByType ? brightenColor(getColorForNodeType(link.type)) : QUERY_L1_LINK_COLOR;
      }
      return DIMMED_LINK_COLOR;
    }
    if (hoverInfo?.links.has(link.id)) return HOVER_LINK_COLOR;
    const anyEmphasisActive = hoverInfo || selectedNodeType || propertyHighlightActive || searchMatchIds;
    if (flags.linkColorByType) {
      if (anyEmphasisActive) {
        const sourceNode = nodeById.get(linkEndpointId(link.source));
        const targetNode = nodeById.get(linkEndpointId(link.target));
        const emphasized = (sourceNode && isNodeEmphasized(sourceNode)) || (targetNode && isNodeEmphasized(targetNode));
        if (!emphasized) return DIMMED_LINK_COLOR;
      }
      return getColorForNodeType(link.type);
    }
    if (anyEmphasisActive) {
      const sourceNode = nodeById.get(linkEndpointId(link.source));
      const targetNode = nodeById.get(linkEndpointId(link.target));
      const emphasized = (sourceNode && isNodeEmphasized(sourceNode)) || (targetNode && isNodeEmphasized(targetNode));
      return emphasized ? DEFAULT_LINK_COLOR : DIMMED_LINK_COLOR;
    }
    return DEFAULT_LINK_COLOR;
  }, [selection, queryActive, queryHighlight, hoverInfo, flags.linkColorByType, selectedNodeType, propertyHighlightActive, searchMatchIds, nodeById, isNodeEmphasized]);

  const linkWidth = useCallback((link) => {
    if (selection?.kind === 'link' && selection.id === link.id) return 3;
    // §7.5: 쿼리 하이라이트 활성 중 호버 이웃 강조는 그 아래 — 굵기도 차단한다.
    if (!queryActive && hoverInfo?.links.has(link.id)) return 2.5;
    return 1;
  }, [selection, queryActive, hoverInfo]);

  const linkThreeObject = useCallback((link) => {
    if (flags.suppressLabels) return undefined;
    const isSelected = selection?.kind === 'link' && selection.id === link.id;
    if (!flags.alwaysLinkLabels && !smallLinkGraph && !isSelected) return undefined;
    const sprite = new SpriteText(link.type);
    sprite.material.depthWrite = false;
    sprite.fontSize = SPRITE_TEXT_FONT_SIZE;
    sprite.color = isSelected ? HIGHLIGHT_COLOR : '#94a3b8';
    sprite.textHeight = 2.2;
    return sprite;
  }, [flags.suppressLabels, flags.alwaysLinkLabels, smallLinkGraph, selection]);

  const linkPositionUpdate = useCallback((sprite, { start, end }) => {
    if (!sprite) return false;
    sprite.position.set(
      start.x + (end.x - start.x) / 2,
      start.y + (end.y - start.y) / 2,
      start.z + (end.z - start.z) / 2,
    );
    return true;
  }, []);

  const handleNodeClick = useCallback((node, event) => {
    // 다중 선택 스타일 (참조: example/multi-selection)
    if (flags.multiSelect && onMultiSelectedChange) {
      const next = new Set(multiSelectedIds || []);
      if (event && (event.ctrlKey || event.shiftKey || event.altKey)) {
        if (next.has(node.id)) next.delete(node.id);
        else next.add(node.id);
      } else {
        next.clear();
        next.add(node.id);
      }
      onMultiSelectedChange(next);
    }

    // 탐색 스타일: 클릭으로 이웃 확장/접기
    if (flags.expandable) {
      setExpandedIds((prev) => {
        const next = new Set(prev || []);
        if (next.has(node.id)) next.delete(node.id);
        else next.add(node.id);
        if (next.size === 0) {
          const seed = findHighestDegreeNodeId(data);
          if (seed) next.add(seed);
        }
        return next;
      });
    }

    onSelectionChange({ kind: 'node', id: node.id });

    // 클릭 포커스 스타일 (참조: example/click-to-focus)
    if (flags.clickFocus && fgRef.current) {
      const distance = 60;
      const len = Math.hypot(node.x || 0, node.y || 0, node.z || 0);
      const ratio = len > 0 ? 1 + distance / len : 1;
      const position = len > 0
        ? { x: node.x * ratio, y: node.y * ratio, z: node.z * ratio }
        : { x: 0, y: 0, z: distance };
      fgRef.current.cameraPosition(position, node, reducedMotion ? 0 : 1500);
    }
  }, [flags.multiSelect, flags.expandable, flags.clickFocus, multiSelectedIds, onMultiSelectedChange, onSelectionChange, reducedMotion, data]);

  const handleLinkClick = useCallback((link) => {
    onSelectionChange({ kind: 'link', id: link.id });
    // 클릭 파티클 방출 스타일 (참조: example/emit-particles)
    if (flags.emitOnLinkClick) {
      fgRef.current?.emitParticle(link);
    }
  }, [onSelectionChange, flags.emitOnLinkClick]);

  // 드래그 고정 스타일 (참조: example/fix-dragged-nodes) — 추적기에 등록해 전체 해제를 보장한다.
  const handleNodeDragEnd = useCallback((node) => {
    if (flags.fixOnDrag) {
      pinTrackerRef.current.pin(node);
      return;
    }
    // 다중 선택 스타일의 그룹 드래그 종료: 함께 이동한 노드들의 임시 고정을 해제한다.
    if (flags.multiSelect && multiSelectedIds?.has(node.id)) {
      data.nodes.forEach((n) => {
        if (n !== node && multiSelectedIds.has(n.id)) {
          n.fx = undefined;
          n.fy = undefined;
          n.fz = undefined;
        }
      });
    }
  }, [flags.fixOnDrag, flags.multiSelect, multiSelectedIds, data]);

  // 다중 선택 스타일: 선택된 노드를 함께 이동 (참조: example/multi-selection)
  const handleNodeDrag = useCallback((node, translate) => {
    if (!flags.multiSelect || !multiSelectedIds?.has(node.id)) return;
    data.nodes.forEach((n) => {
      if (n !== node && multiSelectedIds.has(n.id)) {
        n.fx = (n.x || 0) + (translate.x || 0);
        n.fy = (n.y || 0) + (translate.y || 0);
        n.fz = (n.z || 0) + (translate.z || 0);
      }
    });
  }, [flags.multiSelect, multiSelectedIds, data]);

  const handleNodeHover = useCallback((node) => {
    setHoveredNodeId(node ? node.id : null);
  }, []);

  const needsDragHandlers = flags.fixOnDrag || flags.multiSelect;

  return (
    <ForceGraph3D
      ref={fgRef}
      graphData={displayData}
      width={width}
      height={height}
      backgroundColor="rgba(0,0,0,0)"
      showNavInfo={false}
      nodeId="id"
      nodeLabel={(node) => toTooltipHtml(makeNodeTooltip(node.label, node.properties))}
      nodeColor={nodeColor}
      nodeVal={nodeVal}
      nodeOpacity={0.9}
      nodeResolution={NODE_SPHERE_RESOLUTION}
      nodeThreeObject={nodeThreeObject}
      nodeThreeObjectExtend={!flags.textAsNode && !flags.shapeByType}
      linkLabel={(link) => toTooltipHtml(makeLinkTooltip(link.type, link.properties))}
      linkColor={linkColor}
      linkWidth={linkWidth}
      linkOpacity={0.5}
      linkCurvature="curvature"
      linkCurveRotation="curveRotation"
      linkDirectionalArrowLength={3.5}
      linkDirectionalArrowRelPos={1}
      linkDirectionalParticles={0}
      linkDirectionalParticleWidth={0.5}
      linkDirectionalParticleSpeed={0.01}
      linkDirectionalParticleColor={undefined}
      linkHoverPrecision={undefined}
      dagMode={undefined}
      dagLevelDistance={undefined}
      onDagError={undefined}
      d3VelocityDecay={0.4}
      cooldownTicks={SIMULATION_COOLDOWN_TICKS}
      cooldownTime={Infinity}
      linkThreeObject={linkThreeObject}
      linkThreeObjectExtend={true}
      linkPositionUpdate={linkPositionUpdate}
      onNodeClick={handleNodeClick}
      onNodeHover={flags.hoverNeighborHighlight ? handleNodeHover : undefined}
      onNodeDrag={flags.multiSelect ? handleNodeDrag : undefined}
      onNodeDragEnd={needsDragHandlers ? handleNodeDragEnd : undefined}
      onLinkClick={handleLinkClick}
      onBackgroundClick={() => onSelectionChange(null)}
      onEngineStop={() => {
        if (pendingFitRef.current) {
          pendingFitRef.current = false;
          runZoomToFit();
        }
      }}
      {...styleProps}
      {...queryParticleProps}
    />
  );
});

// 주의: 위 JSX에는 스타일이 설정할 수 있는 모든 prop 키의 base 기본값이 명시되어 있다.
// react-kapsule은 "사라진 키"를 원복하지 않으므로, 스타일 이탈이 키 제거가 아니라
// 값 변경이 되도록 base 값이 항상 존재해야 한다. 새 스타일 prop 키를 추가할 때는
// 반드시 base 기본값도 함께 추가할 것 (tests/vizStyles.test.js가 이를 검사한다).
