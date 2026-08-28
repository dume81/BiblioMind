import { propertiesToJsonSafe } from './neo4jValues.js';

// Neo4j 노드/관계 → Canonical Graph 매핑.
// - deprecated된 identity/start/end 대신 elementId 계열만 사용한다.
// - 다중 label은 시스템 라벨 RKEntity를 제외한 첫 번째 label을 단일 label 필드로
//   사용한다 (TECH-SPEC §2.3.1 — 시스템 라벨이 화면 라벨로 잡히는 왜곡 방지).
// - element ID로 중복 제거하고, 응답에 포함되지 않은 노드를 참조하는 관계는
//   제외해 dangling relationship을 만들지 않는다.

export function mapNode(node) {
  return {
    id: node.elementId,
    label: (Array.isArray(node.labels) && node.labels.find((l) => l !== 'RKEntity')) || 'Node',
    properties: propertiesToJsonSafe(node.properties),
  };
}

export function mapRelationship(relationship) {
  return {
    id: relationship.elementId,
    type: relationship.type,
    start_node_id: relationship.startNodeElementId,
    end_node_id: relationship.endNodeElementId,
    properties: propertiesToJsonSafe(relationship.properties),
  };
}

/**
 * @param {Array} rawNodes neo4j Node 객체 배열
 * @param {Array} rawRelationships neo4j Relationship 객체 배열
 * @param {{nodeLimit: number, relationshipLimit: number}} limits
 */
export function mapToCanonicalGraph(rawNodes, rawRelationships, limits) {
  const nodeMap = new Map();
  rawNodes.forEach((rawNode) => {
    const node = mapNode(rawNode);
    if (!nodeMap.has(node.id)) {
      nodeMap.set(node.id, node);
    }
  });

  const relationshipMap = new Map();
  let danglingExcluded = 0;
  rawRelationships.forEach((rawRel) => {
    const rel = mapRelationship(rawRel);
    if (relationshipMap.has(rel.id)) return;
    if (!nodeMap.has(rel.start_node_id) || !nodeMap.has(rel.end_node_id)) {
      danglingExcluded += 1;
      return;
    }
    relationshipMap.set(rel.id, rel);
  });

  const nodes = Array.from(nodeMap.values());
  const relationships = Array.from(relationshipMap.values());

  const truncated =
    rawNodes.length >= limits.nodeLimit ||
    rawRelationships.length >= limits.relationshipLimit ||
    danglingExcluded > 0;

  return {
    nodes,
    relationships,
    meta: {
      source: 'neo4j',
      truncated,
      nodeCount: nodes.length,
      relationshipCount: relationships.length,
    },
  };
}
