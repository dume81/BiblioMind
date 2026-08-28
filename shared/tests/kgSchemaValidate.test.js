import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateKgSchema, isValidPropertyValue } from '../src/kgSchemaValidate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'schema', 'schema.default.json'), 'utf8'));

/** 유효 문서 골격을 만든다 — 각 테스트가 필요한 부분만 덮어쓴다. */
function doc(overrides = {}) {
  return {
    meta: {
      input_file: '20260821143012_bibliomind_p01.md',
      schema_version: 1,
      engine: 'codex',
      generated_at: '2026-08-21T14:35:00+09:00',
    },
    nodes: [{ id: '0', label: 'Person', properties: { name: '카마도 탄지로' } }],
    relationships: [],
    ...overrides,
  };
}

describe('validateKgSchema — v2 정책: 명명 규칙 위반만 실패 (§2.2)', () => {
  it('시드 라벨 + 유효 name → 통과, newTypes 없음', () => {
    const r = validateKgSchema(doc(), schema);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.newTypes.node_labels).toEqual([]);
    expect(r.newTypes.relationships).toEqual([]);
  });

  it('미등재 라벨(규칙 통과)은 실패가 아니라 수집 (§2.1.1)', () => {
    const r = validateKgSchema(doc({ nodes: [{ id: '0', label: 'Account', properties: { name: '외상매출금' } }] }), schema);
    expect(r.ok).toBe(true);
    expect(r.newTypes.node_labels).toEqual(['Account']);
  });

  it('미등재 관계 유형도 수집', () => {
    const r = validateKgSchema(doc({
      nodes: [
        { id: '0', label: 'Person', properties: { name: 'a' } },
        { id: '1', label: 'Account', properties: { name: 'b' } },
      ],
      relationships: [{ type: 'POSTED_TO', start_node_id: '0', end_node_id: '1', properties: {} }],
    }), schema);
    expect(r.ok).toBe(true);
    expect(r.newTypes.relationships).toEqual(['POSTED_TO']);
  });

  it('라벨 명명 규칙 위반은 실패 — 소문자 시작·밑줄·1자·41자', () => {
    for (const label of ['account', 'IS_A', 'A', 'X'.repeat(41)]) {
      const r = validateKgSchema(doc({ nodes: [{ id: '0', label, properties: { name: 'x' } }] }), schema);
      expect(r.ok, `label=${label}`).toBe(false);
    }
  });

  it('관계 명명 규칙 위반은 실패 — 소문자·1자', () => {
    for (const type of ['posted_to', 'P']) {
      const r = validateKgSchema(doc({
        nodes: [
          { id: '0', label: 'Person', properties: { name: 'a' } },
          { id: '1', label: 'Person', properties: { name: 'b' } },
        ],
        relationships: [{ type, start_node_id: '0', end_node_id: '1', properties: {} }],
      }), schema);
      expect(r.ok, `type=${type}`).toBe(false);
    }
  });

  it('정규식이 유일한 하드 게이트 — "PERSON" 라벨·"MEMBER_" 관계는 통과한다(과잉 검증 금지)', () => {
    const r = validateKgSchema(doc({
      nodes: [
        { id: '0', label: 'PERSON', properties: { name: 'a' } },
        { id: '1', label: 'Person', properties: { name: 'b' } },
      ],
      relationships: [{ type: 'MEMBER_', start_node_id: '0', end_node_id: '1', properties: {} }],
    }), schema);
    expect(r.ok).toBe(true);
    expect(r.newTypes.node_labels).toContain('PERSON');
    expect(r.newTypes.relationships).toContain('MEMBER_');
  });

  it('properties.name 누락·빈 문자열·공백만 → 실패 (③)', () => {
    for (const properties of [{}, { name: '' }, { name: '   ' }]) {
      const r = validateKgSchema(doc({ nodes: [{ id: '0', label: 'Person', properties }] }), schema);
      expect(r.ok).toBe(false);
    }
  });

  it('meta 필수 필드 누락 → 실패 (④), requireMeta=false면 통과', () => {
    const d = doc();
    delete d.meta.engine;
    expect(validateKgSchema(d, schema).ok).toBe(false);
    expect(validateKgSchema(d, schema, { requireMeta: false }).ok).toBe(true);
  });

  it('속성 값 규칙 (⑤): 중첩 객체·혼합 배열·null 실패, 동종 배열·빈 배열 허용', () => {
    expect(isValidPropertyValue({ a: 1 })).toBe(false);
    expect(isValidPropertyValue(['a', 1])).toBe(false);
    expect(isValidPropertyValue(null)).toBe(false);
    expect(isValidPropertyValue(['a', 'b'])).toBe(true);
    expect(isValidPropertyValue([])).toBe(true);
    expect(isValidPropertyValue('x')).toBe(true);
    expect(isValidPropertyValue(3)).toBe(true);
    expect(isValidPropertyValue(true)).toBe(true);
  });

  it('예약 속성명 (⑥): 자동 제거 + 경고 + ok 유지, name은 보존', () => {
    const r = validateKgSchema(doc({
      nodes: [{ id: '0', label: 'Person', properties: { name: '탄지로', kgid: 'x', name_key: 'y', reviewed_files: ['z'], input_files: ['w'] } }],
    }), schema);
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBe(4);
    expect(r.doc.nodes[0].properties).toEqual({ name: '탄지로' });
  });

  it('입력 문서는 변형하지 않는다 (doc는 복제본)', () => {
    const input = doc({ nodes: [{ id: '0', label: 'Person', properties: { name: '탄지로', kgid: 'x' } }] });
    validateKgSchema(input, schema);
    expect(input.nodes[0].properties.kgid).toBe('x');
  });

  it('회귀: 예시 데이터 전체 통과 — 29노드·라벨 시드 일치·관계 40종 신규 수집', () => {
    const examplePath = path.join(HERE, '..', '..', 'examples', 'KG_Demon Slayer_Draft_01.json');
    const example = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
    const r = validateKgSchema(example, schema, { requireMeta: false });
    expect(r.ok).toBe(true);
    expect(example.nodes.length).toBe(29);
    expect(r.newTypes.node_labels).toEqual([]); // 시드 16종이 예시 14종을 포함
    expect(r.newTypes.relationships.length).toBe(40); // 48유형 중 핵심 15종 겹침 8종 제외
    expect(r.newTypes.relationships).toContain('ATTEMPTED_TO_TAKE_FOR_TREATMENT');
  });
});
