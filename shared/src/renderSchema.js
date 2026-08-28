// 전역 스키마 → 프롬프트 텍스트 렌더러 (TECH-SPEC §2.1.5 — 유일한 변환 지점).
// data/schema.json(자동 등재분 포함 전체 유형)을 kg-generation.md의 {schema} 자리에
// 넣을 마크다운 텍스트로 바꾼다.

/** 템플릿의 플레이스홀더 — 정확 문자열 1회 리터럴 치환만 허용. */
export const SCHEMA_PLACEHOLDER = '{schema}';

/**
 * @param {{ label: string, ko?: string, desc?: string }} entry
 * @returns {string} 예: "- Person(인물): 실존·가상 인물"
 */
function renderLabelLine(entry) {
  const ko = entry.ko ? `(${entry.ko})` : '';
  const desc = entry.desc ? `: ${entry.desc}` : '';
  return `- ${entry.label}${ko}${desc}`;
}

/**
 * @param {{ type: string, ko?: string }} entry
 * @returns {string} 예: "- MEMBER_OF(소속)"
 */
function renderRelLine(entry) {
  const ko = entry.ko ? `(${entry.ko})` : '';
  return `- ${entry.type}${ko}`;
}

/**
 * 전역 스키마를 3단계 절차 + 유형 목록 + 명명·언어 규칙 텍스트로 렌더한다.
 * @param {{ node_labels?: object[], core_relationships?: object[],
 *           extended_relationships?: object[], instructions_ko?: string[] }} schema
 * @returns {string}
 */
export function renderSchema(schema) {
  const lines = [];
  lines.push('[작업 절차 — 반드시 이 순서로]');
  lines.push('1) 자료의 핵심 내용과 도메인(분야·소재)을 먼저 분석하라.');
  lines.push('2) 아래 전역 스키마의 기존 유형을 우선 재사용하고, 자료 표현에 부족한 유형만');
  lines.push('   명명 규칙에 맞게 최소한으로 새로 도출하라.');
  lines.push('3) 그렇게 확정한 유형 체계로 노드·관계를 추출하라.');
  lines.push('');
  lines.push('[노드 유형 — 기존 유형 우선 재사용. 부족할 때만 영문 PascalCase(예: Account)로 신규]');
  for (const entry of schema.node_labels ?? []) lines.push(renderLabelLine(entry));
  lines.push('');
  lines.push('[관계 유형 — 아래 목록에서 우선 선택. 없을 때만 대문자 스네이크(영문)로 새로 명명]');
  for (const entry of schema.core_relationships ?? []) lines.push(renderRelLine(entry));
  for (const entry of schema.extended_relationships ?? []) lines.push(renderRelLine(entry));
  lines.push('');
  lines.push('[명명·언어 규칙]');
  for (const instruction of schema.instructions_ko ?? []) lines.push(`- ${instruction}`);
  return lines.join('\n');
}

/**
 * 템플릿의 {schema} 플레이스홀더를 렌더 결과로 치환한다.
 * 정확 문자열 1회 리터럴 replace만 쓴다 — 템플릿 엔진·정규식 치환은
 * 출력 예시 JSON의 중괄호를 오인하므로 금지 (전문가 패널 지적).
 * @param {string} template kg-generation.md 원문
 * @param {string} schemaText renderSchema() 출력
 * @returns {string}
 */
export function injectSchema(template, schemaText) {
  const count = template.split(SCHEMA_PLACEHOLDER).length - 1;
  if (count !== 1) {
    throw new Error(`템플릿의 ${SCHEMA_PLACEHOLDER} 플레이스홀더가 정확히 1회 있어야 합니다 (현재 ${count}회).`);
  }
  return template.replace(SCHEMA_PLACEHOLDER, schemaText);
}
