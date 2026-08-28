// 모든 데이터 소스(JSON 붙여넣기 / JSON 파일 / Neo4j)가 공유하는
// Canonical Graph 정규화·검증 계층.
//
// Canonical Graph 구조:
// {
//   nodes:         [{ id: string, label: string, properties: {} }],
//   relationships: [{ id: string, type: string, start_node_id: string, end_node_id: string, properties: {} }]
// }

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  const keys = Array.isArray(value) ? value.keys() : Object.keys(value);
  for (const key of keys) {
    deepFreeze(value[key]);
  }
  return value;
}

function normalizeId(rawId) {
  if (rawId === null || rawId === undefined) return null;
  if (typeof rawId !== 'string' && typeof rawId !== 'number') return null;
  const id = String(rawId).trim();
  return id === '' ? null : id;
}

function normalizeProperties(raw, errors, where) {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) {
    errors.push(`${where}의 properties가 객체가 아닙니다.`);
    return {};
  }
  // 빈 properties {}는 정상 데이터다. 값을 임의로 채우지 않고 그대로 복제한다.
  return structuredClone(raw);
}

/**
 * 임의의 입력을 Canonical Graph로 정규화·검증한다.
 * @returns {{ ok: true, graph: object, warnings: string[] } | { ok: false, errors: string[] }}
 */
export function normalizeCanonicalGraph(input) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(input)) {
    return { ok: false, errors: ['최상위 값이 객체가 아닙니다. { "nodes": [...], "relationships": [...] } 형태여야 합니다.'] };
  }
  if (!Array.isArray(input.nodes)) {
    errors.push('`nodes` 배열이 없습니다.');
  }
  if (!Array.isArray(input.relationships)) {
    errors.push('`relationships` 배열이 없습니다.');
  }
  if (errors.length) return { ok: false, errors };

  // --- 노드 정규화 ---
  const nodes = [];
  const nodeIds = new Set();
  input.nodes.forEach((rawNode, index) => {
    if (!isPlainObject(rawNode)) {
      errors.push(`nodes[${index}]가 객체가 아닙니다.`);
      return;
    }
    const id = normalizeId(rawNode.id);
    if (id === null) {
      errors.push(`nodes[${index}]의 id가 비어 있거나 문자열/숫자가 아닙니다.`);
      return;
    }
    if (nodeIds.has(id)) {
      errors.push(`중복된 노드 ID: "${id}"`);
      return;
    }
    nodeIds.add(id);

    let label = rawNode.label;
    if (typeof label !== 'string' || label.trim() === '') {
      // 기존 앱과 Neo4j 매퍼의 관례를 따라 기본 라벨 "Node"를 사용한다.
      warnings.push(`노드 "${id}"의 label이 비어 있어 "Node"로 처리했습니다.`);
      label = 'Node';
    }

    nodes.push({
      id,
      label,
      properties: normalizeProperties(rawNode.properties, errors, `nodes[${index}]`),
    });
  });

  // --- 관계 정규화 ---
  const relationships = [];
  const relationshipIds = new Set();
  // 관계 ID가 없을 때 start+type+end 조합의 발생 순서로 안정적인 ID를 만든다.
  const occurrenceCounter = new Map();

  input.relationships.forEach((rawRel, index) => {
    if (!isPlainObject(rawRel)) {
      errors.push(`relationships[${index}]가 객체가 아닙니다.`);
      return;
    }
    const type = typeof rawRel.type === 'string' ? rawRel.type.trim() : '';
    if (type === '') {
      errors.push(`relationships[${index}]의 type이 비어 있습니다.`);
      return;
    }
    const startId = normalizeId(rawRel.start_node_id);
    const endId = normalizeId(rawRel.end_node_id);
    if (startId === null || endId === null) {
      errors.push(`relationships[${index}] (${type})의 start_node_id 또는 end_node_id가 비어 있습니다.`);
      return;
    }
    if (!nodeIds.has(startId)) {
      errors.push(`relationships[${index}] (${type})가 존재하지 않는 노드 "${startId}"를 참조합니다.`);
      return;
    }
    if (!nodeIds.has(endId)) {
      errors.push(`relationships[${index}] (${type})가 존재하지 않는 노드 "${endId}"를 참조합니다.`);
      return;
    }

    let id = normalizeId(rawRel.id);
    if (id === null) {
      // ID·type에 공백/구분자 문자가 있어도 충돌하지 않도록 JSON 인코딩 키를 쓴다.
      const occurrenceKey = JSON.stringify([startId, type, endId]);
      const occurrence = occurrenceCounter.get(occurrenceKey) || 0;
      occurrenceCounter.set(occurrenceKey, occurrence + 1);
      id = JSON.stringify([startId, type, endId, occurrence]);
    }
    if (relationshipIds.has(id)) {
      errors.push(`중복된 관계 ID: "${id}"`);
      return;
    }
    relationshipIds.add(id);

    // 다중 관계·역방향 관계·셀프 관계는 모두 유효한 데이터다 (렌더링 계층에서 시각적으로 구분).
    relationships.push({
      id,
      type,
      start_node_id: startId,
      end_node_id: endId,
      properties: normalizeProperties(rawRel.properties, errors, `relationships[${index}]`),
    });
  });

  if (!errors.length && nodes.length === 0) {
    errors.push('빈 그래프입니다. 노드가 최소 1개 필요합니다.');
  }
  if (errors.length) return { ok: false, errors };

  // Canonical Graph는 동결해서 렌더링 계층(react-force-graph-3d)의 변형으로부터 보호한다.
  const graph = deepFreeze({ nodes, relationships });
  return { ok: true, graph, warnings };
}

/**
 * JSON 텍스트를 파싱한 뒤 Canonical Graph로 정규화한다.
 * JSON 구문 오류와 구조 오류를 구분해 보고한다.
 */
export function parseAndNormalizeJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, errors: [`JSON 구문 오류: ${err.message}`] };
  }
  return normalizeCanonicalGraph(parsed);
}
