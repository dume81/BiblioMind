// 쿼리 하이라이트(3상태) 오버라이드 레이어 (TECH-SPEC §7.4~§7.6).
// 어떤 vizStyles 스타일 위에도 겹쳐지는 순수 계산 모듈 — kgid 색인, 3상태 집합 판정,
// N/M 계산, 패널 문구만 담당하고 레이아웃·물리·기존 스타일 코드는 건드리지 않는다.

/**
 * kgid → 렌더 객체 id 색인 (§7.4 — 소스 무관, properties.kgid 기준).
 * kgid가 없는 요소(주입 전 데이터)는 색인에서 빠져 매칭 불가로 남는다.
 * @param {{nodes: Array, links: Array} | null} renderData
 */
export function buildKgidIndex(renderData) {
  const nodes = new Map();
  const links = new Map();
  if (renderData) {
    renderData.nodes.forEach((node) => {
      const kgid = node.properties?.kgid;
      if (typeof kgid === 'string' && kgid) nodes.set(kgid, node.id);
    });
    renderData.links.forEach((link) => {
      const kgid = link.properties?.kgid;
      if (typeof kgid === 'string' && kgid) links.set(kgid, link.id);
    });
  }
  return { nodes, links };
}

function toKgidList(layer, key) {
  const list = layer?.[key];
  return Array.isArray(list) ? list : [];
}

function matchIds(kgids, index) {
  const ids = new Set();
  kgids.forEach((kgid) => {
    const id = index.get(kgid);
    if (id !== undefined) ids.add(id);
  });
  return ids;
}

/**
 * `highlight.set` 메시지를 현재 렌더 집합 기준의 3상태 집합으로 해석한다.
 * - N = 수신 layer1의 노드+관계 총수, M = 렌더 집합에서 kgid로 매칭된 수 (§5.4 —
 *   renderData에 필터 적용본을 넘기면 숨김 요소는 자연히 M에서 제외된다).
 * - 빈 layer1(시드 0건)은 { active: false, emptyResult: true } — 화면을 dim하지
 *   않고 "검색 결과 없음"만 안내하며 이전 하이라이트를 대체·소거한다 (§7.6).
 * @param {object} message §5.2 highlight.set 페이로드
 * @param {{nodes: Array, links: Array} | null} renderData 현재 렌더 집합
 */
export function resolveQueryHighlight(message, renderData) {
  const layer1 = message?.layer1;
  const layer2 = message?.layer2;
  const l1NodeKgids = toKgidList(layer1, 'nodeIds');
  const l1RelKgids = toKgidList(layer1, 'relIds');
  const total = l1NodeKgids.length + l1RelKgids.length;

  const base = {
    searchId: message?.searchId ?? null,
    question: message?.question ?? null,
    truncated: Boolean(message?.truncated),
    citation: message?.citation || { status: 'pending', submitted: 0, accepted: 0 },
    total,
    // 수신 kgid 원본 — 진단 스냅샷(§7.9)이 "푸시된 집합"을 그대로 내보내기 위해 보관한다.
    // 렌더 id 집합(layer1NodeIds 등)과 달리 현재 렌더 데이터에 없는 kgid도 그대로 남는다.
    received: {
      layer1: { nodeKgids: l1NodeKgids, relKgids: l1RelKgids },
      layer2: { nodeKgids: toKgidList(layer2, 'nodeIds'), relKgids: toKgidList(layer2, 'relIds') },
    },
  };

  if (total === 0) {
    return {
      ...base,
      active: false,
      emptyResult: true,
      matched: 0,
      layer1NodeIds: new Set(),
      layer1LinkIds: new Set(),
      layer2NodeIds: new Set(),
      layer2LinkIds: new Set(),
    };
  }

  const index = buildKgidIndex(renderData);
  const layer1NodeIds = matchIds(l1NodeKgids, index.nodes);
  const layer1LinkIds = matchIds(l1RelKgids, index.links);
  const matched = layer1NodeIds.size + layer1LinkIds.size;
  return {
    ...base,
    // 매칭 0건이면 시각 레이어를 걸지 않는다(전체 dim 방지 — kgid 없는 수동 로드 그래프 등).
    // 상태·N/M 안내는 유지되어 원인 힌트(그래프 새로고침)가 화면에 남는다.
    active: matched > 0,
    emptyResult: false,
    matched,
    layer1NodeIds,
    layer1LinkIds,
    layer2NodeIds: matchIds(toKgidList(layer2, 'nodeIds'), index.nodes),
    layer2LinkIds: matchIds(toKgidList(layer2, 'relIds'), index.links),
  };
}

/**
 * 노드의 3상태 판정 (§7.4) — 2층 > 1층 > 집합 밖. 비활성이면 null.
 * @returns {'layer2' | 'layer1' | 'out' | null}
 */
export function nodeHighlightState(resolved, nodeId) {
  if (!resolved?.active) return null;
  if (resolved.layer2NodeIds.has(nodeId)) return 'layer2';
  if (resolved.layer1NodeIds.has(nodeId)) return 'layer1';
  return 'out';
}

/**
 * 관계(링크)의 3상태 판정 (§7.4) — 2층 > 1층 > 집합 밖. 비활성이면 null.
 * @returns {'layer2' | 'layer1' | 'out' | null}
 */
export function linkHighlightState(resolved, linkId) {
  if (!resolved?.active) return null;
  if (resolved.layer2LinkIds.has(linkId)) return 'layer2';
  if (resolved.layer1LinkIds.has(linkId)) return 'layer1';
  return 'out';
}

/**
 * 1층 "원색 유지 + 밝기 소폭 상향" (§7.4) — #rrggbb를 흰색 방향으로 amount만큼 올린다.
 * 형식이 다르면 원색을 그대로 돌려준다 (안전 폴백).
 */
export function brightenColor(hex, amount = 0.35) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!match) return hex;
  const value = parseInt(match[1], 16);
  const lift = (shift) => {
    const channel = (value >> shift) & 0xff;
    return Math.round(channel + (255 - channel) * amount);
  };
  return `rgb(${lift(16)}, ${lift(8)}, ${lift(0)})`;
}

/** citation 상태 문구 (§7.6 — v2.2 문구 정직화: 검증의 실체는 존재성 검사) */
export function citationPhrase(citation) {
  const status = citation?.status;
  if (status === 'verified') return '인용 전건이 검색 결과에 존재 — 의미 일치는 화면에서 직접 확인';
  if (status === 'partial') {
    return `인용 ${citation.submitted}건 중 ${citation.accepted}건이 검색 결과에 존재 (일부 탈락)`;
  }
  if (status === 'none') return '1층만 표시 중 (인용 없음)';
  return '1층만 표시 중 (인용 검증 대기)';
}

/** M < N일 때의 표시 문구 + 원인별 힌트 (§5.4·§7.6). 전부 표시 중·빈 결과면 null. */
export function coverageNotice(resolved, filterActive) {
  if (!resolved || resolved.emptyResult || resolved.matched >= resolved.total) return null;
  const hint = filterActive ? '필터 해제' : '그래프 새로고침';
  return `검색 결과 ${resolved.total}개 중 ${resolved.matched}개 표시 중 — ${hint} 권장`;
}

/**
 * 하이라이트 상태 진단 스냅샷 (§7.9) — 판정 항목 ④를 육안이 아니라 기계로 대조하기 위한
 * 읽기 전용 계약. **렌더링에는 일절 관여하지 않는다** — 화면은 이 값을 읽지 않으며,
 * 이 함수를 지워도 3상태 표시는 그대로 동작해야 한다.
 *
 * `layer1`(수신)과 `rendered.layer1`(실제로 그렇게 그려지는 것)이 다른 것은 정상이다 —
 * 현재 렌더 데이터에 없는 kgid(필터로 숨김·낡은 그래프)가 차집합으로 남으며, 그것이
 * 곧 N/M 격차의 내역이다.
 *
 * @param {object | null} resolved resolveQueryHighlight의 반환값
 * @param {{nodes: Array, links: Array} | null} renderData 현재 렌더 집합
 * @returns {object | null} 평범한 JSON(전역 대입용) 또는 null
 */
export function buildHighlightSnapshot(resolved, renderData) {
  if (!resolved) return null;
  const index = buildKgidIndex(renderData);
  const received = resolved.received ?? {
    layer1: { nodeKgids: [], relKgids: [] },
    layer2: { nodeKgids: [], relKgids: [] },
  };
  // 2층 우선(§7.4)을 반영해 1층에서 2층 원소를 뺀다 — 화면의 실제 3상태와 같은 규칙.
  const drawn = (kgids, map, exclude) =>
    resolved.active ? kgids.filter((kgid) => map.has(kgid) && !exclude.has(kgid)) : [];
  const l2Nodes = new Set(received.layer2.nodeKgids);
  const l2Rels = new Set(received.layer2.relKgids);
  const empty = new Set();

  return {
    schemaVersion: 1,
    searchId: resolved.searchId,
    question: resolved.question,
    active: resolved.active,
    emptyResult: Boolean(resolved.emptyResult),
    truncated: resolved.truncated,
    citation: resolved.citation,
    total: resolved.total,
    matched: resolved.matched,
    layer1: { nodeKgids: [...received.layer1.nodeKgids], relKgids: [...received.layer1.relKgids] },
    layer2: { nodeKgids: [...received.layer2.nodeKgids], relKgids: [...received.layer2.relKgids] },
    rendered: {
      layer1: {
        nodeKgids: drawn(received.layer1.nodeKgids, index.nodes, l2Nodes),
        relKgids: drawn(received.layer1.relKgids, index.links, l2Rels),
      },
      layer2: {
        nodeKgids: drawn(received.layer2.nodeKgids, index.nodes, empty),
        relKgids: drawn(received.layer2.relKgids, index.links, empty),
      },
    },
  };
}
