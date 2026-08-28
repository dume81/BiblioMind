// 서버에 고정된 매개변수화된 읽기 전용 query preset.
// 클라이언트는 presetId만 보낼 수 있고 임의 Cypher는 절대 실행되지 않는다.
// 쓰기·관리 구문(CREATE/MERGE/SET/DELETE/REMOVE/DROP/CALL 등)은 포함하지 않는다.

export const DEFAULT_NODE_LIMIT = 300;
export const MAX_NODE_LIMIT = 1000;
export const DEFAULT_RELATIONSHIP_LIMIT = 600;
export const MAX_RELATIONSHIP_LIMIT = 2000;

export const TRANSACTION_TIMEOUT_MS = 15000;

export const PRESETS = {
  // 고립 노드를 포함한 전체 개요: 노드와 관계를 별도로 조회한다.
  overview: {
    id: 'overview',
    label: '전체 개요 (고립 노드 포함)',
    nodeQuery: 'MATCH (n) RETURN n LIMIT $nodeLimit',
    relationshipQuery: 'MATCH ()-[r]->() RETURN r LIMIT $relationshipLimit',
  },
  // 관계가 있는 노드만.
  connected: {
    id: 'connected',
    label: '연결된 노드만',
    nodeQuery: 'MATCH (n) WHERE COUNT { (n)--() } > 0 RETURN n LIMIT $nodeLimit',
    relationshipQuery: 'MATCH ()-[r]->() RETURN r LIMIT $relationshipLimit',
  },
};

export function getPresetList() {
  return Object.values(PRESETS).map(({ id, label }) => ({ id, label }));
}

export function clampLimit(value, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(1, Math.min(Math.trunc(num), max));
}
