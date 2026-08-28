// schema_get / schema_update 도메인 (TECH-SPEC §4.3-10·11 v2.12 · §2.1.2).
//
// 연산 기반 수정만 허용한다(전체 교체 금지) — 챗 AI의 실수로 스키마가 통째로 증발하는 것을
// 막기 위한 §4.3-11의 채택 사유다. 같은 이유로 set_instructions는 빈 배열을 거부하고
// 교체 전 지시문 전문을 diff로 돌려준다(런타임 파일은 커밋 금지라 대화 로그가 사실상 백업).
//
// 버전 규약(§2.1.2 v2.12): **실변경이 1건 이상일 때만** schema_version +1 + updated_at 갱신.
// 대상은 런타임 data/schema.json만 — 씨앗(schema.default.json)은 반영되지 않음을 고지한다.

import fs from 'node:fs/promises';

import { dataPaths, ensureDataDirs } from '@bibliomind/shared/paths';
import { NODE_LABEL_RULE, RELATIONSHIP_RULE } from '@bibliomind/shared/kgSchemaValidate';
import { atomicWriteJson } from '@bibliomind/shared/atomicWrite';
import { isoKst } from '@bibliomind/shared/datetime';

async function readSchemaFile(schemaFile) {
  return JSON.parse(await fs.readFile(schemaFile, 'utf8'));
}

/**
 * `schema_get` — 전역 스키마 런타임 사본의 구조화 조회 (§4.3-10).
 * first_seen은 기록 코드가 없어 현재 전부 null이다(스펙-실물 괴리 — 개선 큐 Q14. 정직 보고).
 * @param {{ dirs?: ReturnType<typeof dataPaths> }} [options]
 * @returns {Promise<object>}
 */
export async function getSchema(options = {}) {
  const paths = options.dirs ?? (ensureDataDirs(), dataPaths());
  let schema;
  try {
    schema = await readSchemaFile(paths.schemaFile);
  } catch (err) {
    return { ok: false, summary: `스키마 파일을 읽지 못했습니다 — ${err.message}. npm run setup으로 시드를 복사하세요.` };
  }
  return {
    ok: true,
    schema_version: schema.schema_version ?? null,
    updated_at: schema.updated_at ?? null,
    policy: schema.policy ?? null,
    node_labels: (schema.node_labels ?? []).map((x) => ({
      label: x.label, ko: x.ko ?? null, desc: x.desc ?? null,
      origin: x.origin ?? null, first_seen: x.first_seen ?? null,
    })),
    relationships: [
      ...(schema.core_relationships ?? []).map((x) => ({ type: x.type, ko: x.ko ?? null, origin: x.origin ?? null, core: true })),
      ...(schema.extended_relationships ?? []).map((x) => ({ type: x.type, ko: x.ko ?? null, origin: x.origin ?? null, core: false })),
    ],
    rules: {
      node_label: schema.node_label_name_rule ?? null,
      relationship: schema.relationship_name_rule ?? null,
    },
    instructions_ko: schema.instructions_ko ?? [],
    dictionaries: {
      canonical_entities: schema.canonical_entities?.length ?? 0,
      property_overrides: schema.property_overrides?.length ?? 0,
    },
  };
}

/**
 * `schema_update` — 연산 기반 수동 조정 (§4.3-11 v2.12).
 * @param {object} ops
 * @param {string[]} [ops.add_node_types]
 * @param {string[]} [ops.remove_node_types]
 * @param {string[]} [ops.add_rel_types]
 * @param {string[]} [ops.remove_rel_types]
 * @param {string[]} [ops.set_instructions]
 * @param {{ dirs?: ReturnType<typeof dataPaths>, now?: Date }} [options]
 * @returns {Promise<object>}
 */
export async function updateSchema(ops = {}, options = {}) {
  const paths = options.dirs ?? (ensureDataDirs(), dataPaths());

  // "통째 증발" 가드 — 빈 지시문 교체는 파일을 건드리기 전에 거부한다.
  if (ops.set_instructions !== undefined) {
    const list = ops.set_instructions;
    if (!Array.isArray(list) || list.length === 0 || list.some((x) => !String(x ?? '').trim())) {
      return { ok: false, changed: false, summary: 'set_instructions는 비어 있지 않은 지시문 배열이어야 합니다 — 지시문 전멸을 막기 위해 거부했습니다. 현재 지시문은 schema_get으로 확인하세요.' };
    }
  }

  let schema;
  try {
    schema = await readSchemaFile(paths.schemaFile);
  } catch (err) {
    return { ok: false, changed: false, summary: `스키마 파일을 읽지 못했습니다 — ${err.message}` };
  }

  const added = { node_types: [], rel_types: [] };
  const removed = { node_types: [], rel_types: [] };
  const skipped = [];
  const rejected = [];
  const warnings = [];
  let previousInstructions = null;

  const knownLabels = new Set((schema.node_labels ?? []).map((x) => x.label));
  for (const label of ops.add_node_types ?? []) {
    if (!NODE_LABEL_RULE.test(label)) { rejected.push(`노드 라벨 "${label}" — 명명 규칙(${schema.node_label_name_rule}) 위반`); continue; }
    if (knownLabels.has(label)) { skipped.push(`노드 라벨 "${label}" — 이미 존재`); continue; }
    schema.node_labels.push({ label, ko: null, desc: null, origin: 'manual' });
    knownLabels.add(label);
    added.node_types.push(label);
  }

  const knownRels = new Set([
    ...(schema.core_relationships ?? []).map((x) => x.type),
    ...(schema.extended_relationships ?? []).map((x) => x.type),
  ]);
  for (const type of ops.add_rel_types ?? []) {
    if (!RELATIONSHIP_RULE.test(type)) { rejected.push(`관계 유형 "${type}" — 명명 규칙(${schema.relationship_name_rule}) 위반`); continue; }
    if (knownRels.has(type)) { skipped.push(`관계 유형 "${type}" — 이미 존재`); continue; }
    schema.extended_relationships.push({ type, ko: null, origin: 'manual' });
    knownRels.add(type);
    added.rel_types.push(type);
  }

  // 사전이 참조하는 라벨 집합 — remove 시 침묵 무효화 경고의 재료(§4.3-11 경고 ②).
  const dictLabels = new Set();
  for (const e of schema.canonical_entities ?? []) {
    if (e?.canonical?.label) dictLabels.add(e.canonical.label);
    for (const v of e?.variants ?? []) if (v?.label) dictLabels.add(v.label);
  }
  for (const e of schema.property_overrides ?? []) if (e?.node?.label) dictLabels.add(e.node.label);

  for (const label of ops.remove_node_types ?? []) {
    const idx = (schema.node_labels ?? []).findIndex((x) => x.label === label);
    if (idx < 0) { skipped.push(`노드 라벨 "${label}" — 존재하지 않음`); continue; }
    removed.node_types.push(schema.node_labels[idx]); // 원본 레코드 전량 = 복원 재료
    schema.node_labels.splice(idx, 1);
    if (dictLabels.has(label)) {
      warnings.push(`"${label}"은 스키마 사전(canonical_entities·property_overrides)이 참조 중 — 정규화가 미등재 라벨 노드를 계속 만들어 제거 의도가 조용히 무효화됩니다. 사전 항목도 함께 정리하세요.`);
    }
  }
  for (const type of ops.remove_rel_types ?? []) {
    let record = null;
    for (const listName of ['core_relationships', 'extended_relationships']) {
      const idx = (schema[listName] ?? []).findIndex((x) => x.type === type);
      if (idx >= 0) { record = schema[listName][idx]; schema[listName].splice(idx, 1); break; }
    }
    if (!record) { skipped.push(`관계 유형 "${type}" — 존재하지 않음`); continue; }
    removed.rel_types.push(record);
  }
  if (removed.node_types.length > 0 || removed.rel_types.length > 0) {
    warnings.push('제거된 유형을 엔진이 다시 산출하면 origin:auto(한국어명·설명 소실)로 자동 재등재됩니다 — 영구 배제가 아니라 목록 정리입니다. Reviewed/ 기존 파일의 잔존 유형은 재빌드에서 그대로 통과합니다(소급 없음).');
  }

  if (ops.set_instructions !== undefined) {
    previousInstructions = schema.instructions_ko ?? [];
    schema.instructions_ko = ops.set_instructions.map((x) => String(x));
  }

  const changed = added.node_types.length > 0 || added.rel_types.length > 0
    || removed.node_types.length > 0 || removed.rel_types.length > 0
    || previousInstructions !== null;

  if (changed) {
    // 실변경 시만 +1(§2.1.2 v2.12) — 버전 = "생성에 영향을 주는 변경"의 추적 근거.
    schema.schema_version = Number(schema.schema_version ?? 1) + 1;
    schema.updated_at = isoKst(options.now);
    await atomicWriteJson(paths.schemaFile, schema);
  }

  return {
    ok: true, changed,
    added, removed, skipped, rejected, warnings, previousInstructions,
    schema_version: schema.schema_version,
    summary: changed
      ? `스키마를 조정했습니다(schema_version ${schema.schema_version}) — 새 생성분부터 적용되며 기존 그래프는 소급되지 않습니다. 씨앗(schema.default.json)에는 반영되지 않습니다 — 클론 초기화 시 재적용이 필요합니다.`
      : '실변경이 없어 스키마 파일을 건드리지 않았습니다(버전 불변).',
  };
}
