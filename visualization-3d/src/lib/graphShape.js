// 그래프 형태 판정 유틸리티.

// 강연결요소(SCC) 계산 — 재귀 없는 Tarjan (대규모 그래프에서 스택 오버플로 방지).
function computeSccIds(nodeIds, outgoing) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const sccId = new Map();
  let counter = 0;
  let sccCounter = 0;

  for (const start of nodeIds) {
    if (index.has(start)) continue;
    index.set(start, counter);
    low.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);
    const frames = [{ node: start, childIndex: 0 }];

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const neighbors = outgoing.get(frame.node) || [];
      if (frame.childIndex < neighbors.length) {
        const next = neighbors[frame.childIndex];
        frame.childIndex += 1;
        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          frames.push({ node: next, childIndex: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node), index.get(next)));
        }
      } else {
        frames.pop();
        if (frames.length > 0) {
          const parent = frames[frames.length - 1].node;
          low.set(parent, Math.min(low.get(parent), low.get(frame.node)));
        }
        if (low.get(frame.node) === index.get(frame.node)) {
          let member;
          do {
            member = stack.pop();
            onStack.delete(member);
            sccId.set(member, sccCounter);
          } while (member !== frame.node);
          sccCounter += 1;
        }
      }
    }
  }
  return sccId;
}

/**
 * DAG 분석 (SCC 기반 — 정확한 사이클 간선 집계).
 * @returns {{ isDag: boolean, cycleEdgeCount: number }}
 *   cycleEdgeCount: 사이클에 참여해 계층 계산에서 제외되는 관계 수
 *   (셀프 관계 + 같은 강연결요소(크기>1) 안의 관계).
 */
export function analyzeDag(graph) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.relationships) || graph.nodes.length === 0) {
    return { isDag: false, cycleEdgeCount: 0 };
  }

  const outgoing = new Map(graph.nodes.map((n) => [n.id, []]));
  let selfLoops = 0;
  for (const rel of graph.relationships) {
    if (rel.start_node_id === rel.end_node_id) {
      selfLoops += 1;
      continue;
    }
    outgoing.get(rel.start_node_id)?.push(rel.end_node_id);
  }

  const sccId = computeSccIds(graph.nodes.map((n) => n.id), outgoing);
  const sccSizes = new Map();
  sccId.forEach((id) => sccSizes.set(id, (sccSizes.get(id) || 0) + 1));

  let cyclicEdges = 0;
  for (const rel of graph.relationships) {
    if (rel.start_node_id === rel.end_node_id) continue;
    const s = sccId.get(rel.start_node_id);
    if (s !== undefined && s === sccId.get(rel.end_node_id) && sccSizes.get(s) > 1) {
      cyclicEdges += 1;
    }
  }

  return { isDag: selfLoops === 0 && cyclicEdges === 0, cycleEdgeCount: selfLoops + cyclicEdges };
}

export function isDirectedAcyclic(graph) {
  return analyzeDag(graph).isDag;
}

// DAG 스타일의 계층 깊이 계산 — 렌더 데이터({nodes, links}) 기준.
// three-forcegraph가 실제 층 배치에 쓰는 getDagDepths와 같은 규칙을 따른다:
// 모든 노드에서 DFS로 최장 경로 깊이(뿌리=0)를 배정하되, 현재 진행 경로를 되짚는
// 간선(사이클을 닫는 간선)만 무시한다 — 사이클 노드들도 진입 순서대로 서로 다른
// 층에 놓이므로, 노드 크기가 화면의 실제 계층과 일치한다. 재귀 없는 구현.
// 노드 크기(뿌리일수록 큼)·충돌 반경 계산에 쓰인다.
export function computeDagDepths(data) {
  const depths = new Map();
  if (!data || !Array.isArray(data.nodes) || data.nodes.length === 0) return depths;

  const endpointId = (endpoint) => (typeof endpoint === 'object' && endpoint !== null ? endpoint.id : endpoint);
  const nodeIds = data.nodes.map((n) => n.id);
  const outgoing = new Map(nodeIds.map((id) => [id, []]));
  (data.links || []).forEach((link) => {
    const s = endpointId(link.source);
    const t = endpointId(link.target);
    if (s === t || !outgoing.has(s) || !outgoing.has(t)) return;
    outgoing.get(s).push(t);
  });

  nodeIds.forEach((id) => depths.set(id, -1));
  const onStack = new Set();

  for (const startId of nodeIds) {
    if (depths.get(startId) >= 0) continue;
    depths.set(startId, 0);
    onStack.add(startId);
    const frames = [{ id: startId, childIndex: 0 }];

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const children = outgoing.get(frame.id);
      if (frame.childIndex < children.length) {
        const childId = children[frame.childIndex];
        frame.childIndex += 1;
        if (onStack.has(childId)) continue; // 진행 경로를 되짚는 간선(사이클)만 무시
        const childDepth = depths.get(frame.id) + 1;
        if (childDepth > depths.get(childId)) {
          depths.set(childId, childDepth); // 더 긴 경로 발견 → 갱신 후 재하강
          onStack.add(childId);
          frames.push({ id: childId, childIndex: 0 });
        }
      } else {
        frames.pop();
        onStack.delete(frame.id);
      }
    }
  }
  return depths;
}

// 탐색(확장/접기) 스타일: 확장된 노드 집합에서 보이는 부분 그래프를 계산한다.
// 보이는 노드 = 확장된 노드 + 그 직접 이웃. 보이는 관계 = 양 끝이 모두 보이는 관계.
// 사이클이 있는 임의의 지식 그래프에서도 잘 정의된다.
export function computeExpandedSubset(data, expandedIds) {
  if (!expandedIds || expandedIds.size === 0) return { nodes: [], links: [] };

  const visibleIds = new Set(expandedIds);
  data.links.forEach((link) => {
    const sourceId = typeof link.source === 'object' && link.source !== null ? link.source.id : link.source;
    const targetId = typeof link.target === 'object' && link.target !== null ? link.target.id : link.target;
    if (expandedIds.has(sourceId)) visibleIds.add(targetId);
    if (expandedIds.has(targetId)) visibleIds.add(sourceId);
  });

  const nodes = data.nodes.filter((node) => visibleIds.has(node.id));
  const links = data.links.filter((link) => {
    const sourceId = typeof link.source === 'object' && link.source !== null ? link.source.id : link.source;
    const targetId = typeof link.target === 'object' && link.target !== null ? link.target.id : link.target;
    return visibleIds.has(sourceId) && visibleIds.has(targetId);
  });

  return { nodes, links };
}

// 탐색 스타일의 시작 노드: 연결(차수)이 가장 많은 노드.
export function findHighestDegreeNodeId(data) {
  if (!data || data.nodes.length === 0) return null;
  const degree = new Map(data.nodes.map((n) => [n.id, 0]));
  data.links.forEach((link) => {
    const sourceId = typeof link.source === 'object' && link.source !== null ? link.source.id : link.source;
    const targetId = typeof link.target === 'object' && link.target !== null ? link.target.id : link.target;
    degree.set(sourceId, (degree.get(sourceId) || 0) + 1);
    degree.set(targetId, (degree.get(targetId) || 0) + 1);
  });
  let best = data.nodes[0].id;
  let bestDegree = -1;
  degree.forEach((d, id) => {
    if (d > bestDegree) {
      bestDegree = d;
      best = id;
    }
  });
  return best;
}
