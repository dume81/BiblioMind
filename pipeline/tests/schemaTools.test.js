// 슬라이스 8 — schema_get/schema_update 도메인 (TECH-SPEC §4.3-10·11 v2.12 · §2.1.2).
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-schema-'));
process.env.KG_DATA_DIR = ROOT;

const { getSchema, updateSchema } = await import('../src/schema/index.js');
const { dataPaths, ensureDataDirs } = await import('@bibliomind/shared/paths');

const BASE = {
  schema_version: 3,
  updated_at: '2026-08-26T00:00:00+09:00',
  policy: 'reuse_first_auto_extend',
  node_labels: [
    { label: 'Person', ko: '인물', desc: '실존·가상 인물', origin: 'seed' },
    { label: 'AutoThing', ko: null, desc: null, origin: 'auto' },
  ],
  node_label_name_rule: '^[A-Z][A-Za-z0-9]{1,39}$',
  core_relationships: [{ type: 'MEMBER_OF', ko: '소속', origin: 'seed' }],
  extended_relationships: [{ type: 'POSTED_TO', origin: 'auto' }],
  relationship_name_rule: '^[A-Z][A-Z0-9_]{1,39}$',
  instructions_ko: ['규칙 하나'],
  canonical_entities: [{ canonical: { label: 'Person', name: '갑' }, variants: [{ label: 'Person', name: '갑씨' }] }],
  property_overrides: [],
};

beforeEach(() => {
  ensureDataDirs();
  fs.writeFileSync(dataPaths().schemaFile, JSON.stringify(BASE, null, 2), 'utf8');
});

afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

const readSchema = () => JSON.parse(fs.readFileSync(dataPaths().schemaFile, 'utf8'));

describe('getSchema — §4.3-10', () => {
  it('#1 유형 목록(origin·first_seen null 정직)·규칙·지시문·버전·사전 계수를 반환한다', async () => {
    const r = await getSchema();
    expect(r.ok).toBe(true);
    expect(r.schema_version).toBe(3);
    expect(r.updated_at).toBe('2026-08-26T00:00:00+09:00');
    expect(r.node_labels.find((x) => x.label === 'AutoThing').first_seen).toBeNull(); // 기록 코드 부재(Q14) — null 정직
    expect(r.relationships.map((x) => x.type)).toEqual(['MEMBER_OF', 'POSTED_TO']);
    expect(r.instructions_ko).toEqual(['규칙 하나']);
    expect(r.dictionaries).toEqual({ canonical_entities: 1, property_overrides: 0 });
  });
});

describe('updateSchema — 연산 기반 · 버전 규약 (§4.3-11 v2.12)', () => {
  it('#2 add_node_types — origin manual로 추가, 실변경이므로 version +1 + updated_at 갱신', async () => {
    const r = await updateSchema({ add_node_types: ['Account'] });
    expect(r.ok).toBe(true);
    expect(r.added.node_types).toEqual(['Account']);
    const s = readSchema();
    expect(s.node_labels.find((x) => x.label === 'Account').origin).toBe('manual');
    expect(s.schema_version).toBe(4);
    expect(s.updated_at).not.toBe(BASE.updated_at);
  });

  it('#3 명명 규칙 위반은 거부 보고 — 적용 0건이면 버전 불변', async () => {
    const r = await updateSchema({ add_node_types: ['bad name'] });
    expect(r.rejected.join(' ')).toContain('bad name');
    expect(readSchema().schema_version).toBe(3);
  });

  it('#4 중복 추가는 스킵 보고 — 스킵뿐이면 실변경 0 = 버전 불변("변경 없음")', async () => {
    const r = await updateSchema({ add_node_types: ['Person'] });
    expect(r.ok).toBe(true);
    expect(r.skipped.join(' ')).toContain('Person');
    expect(r.changed).toBe(false);
    expect(readSchema().schema_version).toBe(3);
  });

  it('#5 remove_node_types — 원본 레코드 전량을 diff로 반환하고(복원 재료) 재등재 경고를 동봉한다', async () => {
    const r = await updateSchema({ remove_node_types: ['AutoThing'] });
    expect(r.ok).toBe(true);
    expect(r.removed.node_types[0]).toMatchObject({ label: 'AutoThing', origin: 'auto' });
    expect(r.warnings.join(' ')).toMatch(/재등재/);
    expect(readSchema().node_labels.map((x) => x.label)).toEqual(['Person']);
  });

  it('#6 remove 라벨을 사전이 참조하면 침묵 무효화 경고를 동봉한다', async () => {
    const r = await updateSchema({ remove_node_types: ['Person'] });
    expect(r.warnings.join(' ')).toMatch(/사전|canonical/);
  });

  it('#7 remove_rel_types — core에서도 제거된다(경고 동반)', async () => {
    const r = await updateSchema({ remove_rel_types: ['MEMBER_OF'] });
    expect(r.removed.rel_types[0]).toMatchObject({ type: 'MEMBER_OF', origin: 'seed' });
    expect(readSchema().core_relationships).toEqual([]);
  });

  it('#8 set_instructions — 교체하되 diff에 교체 전 지시문 전문을 동봉한다(되돌리기 재료)', async () => {
    const r = await updateSchema({ set_instructions: ['새 규칙'] });
    expect(r.ok).toBe(true);
    expect(r.previousInstructions).toEqual(['규칙 하나']);
    expect(readSchema().instructions_ko).toEqual(['새 규칙']);
  });

  it('#9 set_instructions 빈 배열·빈 요소는 거부한다 — "통째 증발" 재도입 차단', async () => {
    for (const bad of [[], ['']]) {
      const r = await updateSchema({ set_instructions: bad });
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
    expect(readSchema().instructions_ko).toEqual(['규칙 하나']); // 불변
  });

  it('#10 미실재 remove는 스킵 보고 — 실변경 0이면 버전 불변', async () => {
    const r = await updateSchema({ remove_node_types: ['NoSuch'] });
    expect(r.skipped.join(' ')).toContain('NoSuch');
    expect(r.changed).toBe(false);
    expect(readSchema().schema_version).toBe(3);
  });

  it('#11 인자 없음 = 변경 없음 정상 반환(버전 불변)', async () => {
    const r = await updateSchema({});
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(false);
    expect(readSchema().schema_version).toBe(3);
  });
});
