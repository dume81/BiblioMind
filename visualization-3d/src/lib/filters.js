// 기존 시각화도구/index.html의 필터 유틸리티를 그대로 이식.

export function getNestedProperty(obj, path) {
  return path.split('.').reduce((current, key) => {
    return current && current[key] !== undefined ? current[key] : undefined;
  }, obj);
}

export function filterRelationships(relationships, conditions) {
  return relationships.filter((relationship) => {
    return Object.entries(conditions).every(([key, value]) => {
      const propValue = getNestedProperty(relationship, key);

      if (Array.isArray(value)) {
        return value.includes(propValue);
      } else if (typeof value === 'function') {
        return value(propValue);
      } else {
        return propValue === value;
      }
    });
  });
}

// 필터가 적용되면 기존 동작대로 "필터된 관계에 연결된 노드만" 남긴다.
export function createFilteredGraph(knowledgeGraph, relationshipOptions = {}) {
  let filteredRelationships = knowledgeGraph.relationships;

  if (relationshipOptions.customFilter && typeof relationshipOptions.customFilter === 'function') {
    filteredRelationships = filteredRelationships.filter(relationshipOptions.customFilter);
  }

  const usedNodeIds = new Set();
  filteredRelationships.forEach((rel) => {
    usedNodeIds.add(rel.start_node_id);
    usedNodeIds.add(rel.end_node_id);
  });

  const filteredNodes = knowledgeGraph.nodes.filter((node) => usedNodeIds.has(node.id));

  return {
    nodes: filteredNodes,
    relationships: filteredRelationships,
  };
}

const RESERVED_RELATIONSHIP_KEYS = ['id', 'start_node_id', 'end_node_id', 'properties'];

// 필터 이름 → 관계에서 실제로 비교할 값. 수집과 필터링이 반드시 같은 해석을 쓰도록
// 하나의 함수로 통일한다 — properties에 최상위 키와 같은 이름(type 등)이 있어도
// UI에 매칭 불가능한 값이 노출되지 않는다.
export function resolveRelationshipFilterValue(rel, property) {
  if (RESERVED_RELATIONSHIP_KEYS.includes(property)) {
    // 예약된 구조 키는 필터 대상이 아니므로 properties 쪽 값만 본다.
    return rel.properties?.[property];
  }
  return rel[property] !== undefined ? rel[property] : rel.properties?.[property];
}

// 현재 그래프의 관계에서 필터 후보 속성(최상위 키 + properties.* 키)과 값 목록을 수집한다.
// 하드코딩 없이 그래프가 바뀔 때마다 다시 계산된다.
export function collectRelationshipProperties(relationships) {
  const properties = {};

  relationships.forEach((rel) => {
    const candidateKeys = new Set();
    Object.keys(rel).forEach((key) => {
      if (!RESERVED_RELATIONSHIP_KEYS.includes(key)) candidateKeys.add(key);
    });
    if (rel.properties) {
      Object.keys(rel.properties).forEach((key) => candidateKeys.add(key));
    }

    candidateKeys.forEach((key) => {
      const value = resolveRelationshipFilterValue(rel, key);
      if (value != null) {
        if (!properties[key]) properties[key] = new Set();
        properties[key].add(String(value));
      }
    });
  });

  const result = {};
  Object.keys(properties).forEach((key) => {
    result[key] = Array.from(properties[key]).sort();
  });

  return result;
}

// 하이라이트 카드의 Property/Value 선택 후보: 노드 properties의 키와 값 목록을
// 현재 그래프에서 동적으로 수집한다 (label도 유형 하이라이트와 별개로 속성처럼 선택 가능).
export function collectNodePropertyOptions(nodes) {
  const options = {};
  nodes.forEach((node) => {
    Object.keys(node.properties || {}).forEach((key) => {
      const value = node.properties[key];
      if (value === null || value === undefined) return;
      if (typeof value === 'object') return; // 중첩 객체·배열은 선택 후보에서 제외
      if (!options[key]) options[key] = new Set();
      options[key].add(String(value));
    });
  });
  const result = {};
  Object.keys(options).sort().forEach((key) => {
    result[key] = Array.from(options[key]).sort();
  });
  return result;
}
