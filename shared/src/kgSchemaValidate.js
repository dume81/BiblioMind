// KG JSON 2단계(스키마·주입 호환) 검증 (TECH-SPEC §2.2 검증 2단).
// 1단계 구조 검증은 canonicalGraph.js가 담당하고, 파이프라인이 두 단계를 순서대로 조합한다.
// v2 정책: 명명 규칙 위반만 실패다 — 미등재 유형은 통과 + 등재 대상(newTypes) 수집.

/** 노드 라벨 명명 규칙 — 영문 PascalCase 2~40자 (TECH-SPEC §2.1.2, 유일한 하드 게이트). */
export const NODE_LABEL_RULE = /^[A-Z][A-Za-z0-9]{1,39}$/;

/** 관계 유형 명명 규칙 — 영문 대문자 스네이크 2~40자 (TECH-SPEC §2.1.2). */
export const RELATIONSHIP_RULE = /^[A-Z][A-Z0-9_]{1,39}$/;

/** 시스템 예약 속성명 — 주입기만 기록한다. 산출물에 있으면 제거 + 경고 (검증 ⑥). */
export const RESERVED_PROPS = ['kgid', 'name_key', 'reviewed_files', 'input_files'];

/** meta 필수 필드 (검증 ④ — 파이프라인이 스탬프한 뒤 검증한다). */
export const REQUIRED_META_FIELDS = ['input_file', 'schema_version', 'engine', 'generated_at'];

/**
 * @param {unknown} v
 * @returns {boolean} 스칼라(string/number/boolean) 여부
 */
function isScalar(v) {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/**
 * 속성 값 규칙(검증 ⑤): 스칼라 또는 동종 스칼라 배열만.
 * 확정(패널 권고, DECISIONS 기록): null·중첩 객체·혼합 타입 배열 = 실패, 빈 배열 = 허용.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidPropertyValue(value) {
  if (isScalar(value)) return true;
  if (Array.isArray(value)) {
    if (value.length === 0) return true;
    if (!value.every(isScalar)) return false;
    return new Set(value.map((v) => typeof v)).size === 1;
  }
  return false;
}

/**
 * 스키마에 등재된 유형 집합을 만든다.
 * @param {{ node_labels?: {label: string}[], core_relationships?: {type: string}[], extended_relationships?: {type: string}[] }} schema
 */
function registeredTypes(schema) {
  return {
    labels: new Set((schema.node_labels ?? []).map((e) => e.label)),
    relationships: new Set([
      ...(schema.core_relationships ?? []).map((e) => e.type),
      ...(schema.extended_relationships ?? []).map((e) => e.type),
    ]),
  };
}

/**
 * KG JSON 2단계 검증 — 실패(errors)와 수집·경고(newTypes·warnings)를 구조적으로 분리한다.
 * 입력 문서는 수정하지 않는다 — 예약 속성 제거(⑥)는 반환값 doc(깊은 복제본)에만 적용.
 * @param {{ meta?: object, nodes: {id: string, label: string, properties?: Record<string, unknown>}[],
 *           relationships: {type: string, start_node_id: string, end_node_id: string, properties?: Record<string, unknown>}[] }} input
 *        canonicalGraph 1단계(구조)를 통과한 문서
 * @param {object} schema data/schema.json 내용 (전역 스키마)
 * @param {{ requireMeta?: boolean }} [options] requireMeta=false는 meta 스탬프 전 검증용
 * @returns {{ ok: boolean, errors: string[], warnings: string[],
 *             newTypes: { node_labels: string[], relationships: string[] }, doc: object }}
 */
export function validateKgSchema(input, schema, { requireMeta = true } = {}) {
  const errors = [];
  const warnings = [];
  const registered = registeredTypes(schema);
  const newLabels = new Set();
  const newRelTypes = new Set();
  const doc = structuredClone(input);

  // ④ meta 필수 필드
  if (requireMeta) {
    for (const field of REQUIRED_META_FIELDS) {
      if (doc.meta?.[field] === undefined || doc.meta?.[field] === null || doc.meta?.[field] === '') {
        errors.push(`meta.${field} 필드가 없습니다.`);
      }
    }
  }

  const checkProperties = (properties, where) => {
    if (!properties) return;
    for (const reserved of RESERVED_PROPS) {
      if (reserved in properties) {
        delete properties[reserved]; // ⑥ 자동 교정 — name은 예약이 아니라 필수(③)이므로 대상 아님
        warnings.push(`${where}의 예약 속성 "${reserved}"를 제거했습니다(주입기 전용 속성명).`);
      }
    }
    for (const [key, value] of Object.entries(properties)) {
      if (!isValidPropertyValue(value)) {
        errors.push(`${where}의 속성 "${key}" 값이 규칙 위반입니다(스칼라 또는 동종 스칼라 배열만 — 중첩 객체·null·혼합 배열 금지).`);
      }
    }
  };

  for (const [index, node] of (doc.nodes ?? []).entries()) {
    const where = `nodes[${index}]`;
    // ① 라벨 명명 규칙 — 미등재는 실패가 아니라 수집
    if (!NODE_LABEL_RULE.test(node.label)) {
      errors.push(`${where}의 label "${node.label}"이 명명 규칙(영문 PascalCase 2~40자) 위반입니다.`);
    } else if (!registered.labels.has(node.label)) {
      newLabels.add(node.label);
    }
    // ③ properties.name 필수
    const name = node.properties?.name;
    if (typeof name !== 'string' || name.trim() === '') {
      errors.push(`${where}의 properties.name이 없거나 비어 있습니다.`);
    }
    checkProperties(node.properties, where);
  }

  for (const [index, rel] of (doc.relationships ?? []).entries()) {
    const where = `relationships[${index}]`;
    // ② 관계 유형 명명 규칙 — 미등재는 수집
    if (!RELATIONSHIP_RULE.test(rel.type)) {
      errors.push(`${where}의 type "${rel.type}"이 명명 규칙(영문 대문자 스네이크 2~40자) 위반입니다.`);
    } else if (!registered.relationships.has(rel.type)) {
      newRelTypes.add(rel.type);
    }
    checkProperties(rel.properties, where);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    newTypes: {
      node_labels: [...newLabels].sort(),
      relationships: [...newRelTypes].sort(),
    },
    doc,
  };
}
