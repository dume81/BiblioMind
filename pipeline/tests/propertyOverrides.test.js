// Q10 — 속성 충돌 가시화 + 속성 승자 사전 (TECH-SPEC §2.3.2 v2.10).
// inject.test.js와 같은 방식: Neo4j를 때리지 않고 가짜 세션·순수 함수로 검증한다.
// 설계 반박 패널(2026-08-26 4렌즈)이 요구한 경계를 시험으로 고정한다 —
// 값 동등성 정규화 · canonicalize 경유 중복 검사 · 미관측=보고(중단 아님) · 예약 속성 거부.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-propover-'));
process.env.KG_DATA_DIR = ROOT;

const {
  buildPropertyOverrideIndex, resolvePropertyOverrides,
} = await import('../src/inject/propertyOverrides.js');
const { mergeReviewed, rebuildGraph, formatRebuildSummary } = await import('../src/inject/index.js');
const { buildCanonicalIndex } = await import('../src/inject/canonicalize.js');
const { dataPaths, ensureDataDirs } = await import('@bibliomind/shared/paths');

const SEED_SCHEMA = {
  schema_version: 1,
  updated_at: '2026-08-26T00:00:00+09:00',
  node_labels: [{ label: 'Person', origin: 'seed' }, { label: 'Org', origin: 'seed' }],
  core_relationships: [{ type: 'MEMBER_OF', origin: 'seed' }],
  extended_relationships: [],
};

const org = (id, name, extra = {}) => ({ id, label: 'Org', properties: { name, ...extra } });
const person = (id, name, extra = {}) => ({ id, label: 'Person', properties: { name, ...extra } });

/** p04(과거 값 선착) vs p07(현행 값 후착) — Q10 실사고 재현용 최소 문서 쌍. */
function conflictDocs() {
  return [
    { file: 'a_p04.kg.json', doc: { nodes: [org('0', '회사', { hq: '삼봉로 57' })], relationships: [] } },
    { file: 'b_p07.kg.json', doc: { nodes: [org('0', '회사', { hq: '새문안로 89' })], relationships: [] } },
  ];
}

/** 사전 1항목을 가진 스키마. */
function schemaWith(overrides, canonical = []) {
  return { ...SEED_SCHEMA, canonical_entities: canonical, property_overrides: overrides };
}

function emptyCanon() {
  return buildCanonicalIndex(SEED_SCHEMA).index;
}

function seedReviewed(name, graph) {
  fs.writeFileSync(path.join(dataPaths().reviewed, name), JSON.stringify(graph, null, 2), 'utf8');
}

function fakeSession(counts = {}) {
  const queries = [];
  const answers = { foreign: 0, deleteTarget: 0, nodes: null, rels: null, ...counts };
  return {
    queries,
    session: {
      async run(cypher, params) {
        queries.push({ cypher: cypher.replace(/\s+/g, ' ').trim(), rows: params?.rows?.length ?? null });
        if (/WHERE NOT n:RKEntity/.test(cypher)) return recordCount(answers.foreign);
        if (/MATCH \(n:RKEntity\) WHERE n\.reviewed_files IS NOT NULL RETURN count/.test(cypher)) {
          return recordCount(answers.deleteTarget);
        }
        if (/MATCH \(n:RKEntity\) RETURN count/.test(cypher)) return recordCount(answers.nodes);
        if (/\[r\] .*RETURN count|\)-\[r\]->\(/.test(cypher) && /count/.test(cypher)) return recordCount(answers.rels);
        if (/SHOW INDEXES/.test(cypher)) return { records: [] };
        return { records: [] };
      },
      async close() {},
    },
  };
}

function recordCount(value) {
  return { records: [{ get: () => ({ toInt: () => value ?? 0 }) }] };
}

beforeEach(() => {
  ensureDataDirs();
  const p = dataPaths();
  for (const f of fs.readdirSync(p.reviewed)) fs.rmSync(path.join(p.reviewed, f), { force: true });
  fs.rmSync(p.lockFile, { force: true });
  fs.rmSync(p.ledgerFile, { force: true });
  fs.writeFileSync(p.schemaFile, JSON.stringify(SEED_SCHEMA, null, 2), 'utf8');
});

afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

describe('buildPropertyOverrideIndex — 사전 검증 (내부 모순만 중단 사유)', () => {
  it('#1 필수 필드가 빠진 항목은 조용히 넘기지 않고 보고한다', () => {
    const r = buildPropertyOverrideIndex(schemaWith([{ property: 'hq', value: 'x' }]), emptyCanon());
    expect(r.problems.length).toBeGreaterThan(0);
  });

  it('#2 같은 (노드,속성)의 중복 등재를 **canonicalize 경유 키**로 잡는다 — 변형·정본 이중 등재도 중복이다', () => {
    const canonical = [{
      canonical: { label: 'Org', name: '회사(주)' },
      variants: [{ label: 'Org', name: '회사' }],
    }];
    const schema = schemaWith([
      { node: { label: 'Org', name: '회사(주)' }, property: 'hq', value: 'A' },
      { node: { label: 'Org', name: '회사' }, property: 'hq', value: 'B' }, // 변형 표기 — 같은 병합 키
    ], canonical);
    const r = buildPropertyOverrideIndex(schema, buildCanonicalIndex(schema).index);
    expect(r.problems.join(' ')).toMatch(/중복/);
  });

  it('#3 시스템 예약 속성·name은 등재를 거부하고, name은 canonical_entities 소관임을 안내한다', () => {
    for (const prop of ['kgid', 'name_key', 'reviewed_files', 'input_files']) {
      const r = buildPropertyOverrideIndex(
        schemaWith([{ node: { label: 'Org', name: '회사' }, property: prop, value: 'x' }]), emptyCanon(),
      );
      expect(r.problems.length, prop).toBeGreaterThan(0);
    }
    const rName = buildPropertyOverrideIndex(
      schemaWith([{ node: { label: 'Org', name: '회사' }, property: 'name', value: 'x' }]), emptyCanon(),
    );
    expect(rName.problems.join(' ')).toMatch(/canonical_entities/);
  });

  it('#4 값 타입 화이트리스트 — 객체·이종 배열은 거부, 동종 원시 배열은 허용', () => {
    const bad1 = buildPropertyOverrideIndex(
      schemaWith([{ node: { label: 'Org', name: '회사' }, property: 'hq', value: { road: 'x' } }]), emptyCanon(),
    );
    expect(bad1.problems.length).toBeGreaterThan(0);
    const bad2 = buildPropertyOverrideIndex(
      schemaWith([{ node: { label: 'Org', name: '회사' }, property: 'tags', value: ['a', 1] }]), emptyCanon(),
    );
    expect(bad2.problems.length).toBeGreaterThan(0);
    const ok = buildPropertyOverrideIndex(
      schemaWith([{ node: { label: 'Org', name: '회사' }, property: 'tags', value: ['a', 'b'] }]), emptyCanon(),
    );
    expect(ok.problems).toEqual([]);
    expect(ok.index.size).toBe(1);
  });

  it('#5 사전이 없으면 빈 색인 — 교정 없이 동작한다', () => {
    const r = buildPropertyOverrideIndex(SEED_SCHEMA, emptyCanon());
    expect(r.problems).toEqual([]);
    expect(r.index.size).toBe(0);
  });
});

describe('mergeReviewed — 속성 충돌 관측 (노드 속성만·선착 유지 불변)', () => {
  it('#6 같은 병합 키·같은 속성 키에 다른 값 → 충돌 관측, 선착 값은 그대로다', () => {
    const m = mergeReviewed(conflictDocs());
    expect(m.nodes[0].props.hq).toBe('삼봉로 57'); // 선착 유지 — 기존 규칙 불변
    const r = resolvePropertyOverrides(m, new Map());
    expect(r.conflictTotal).toBe(1);
    expect(r.conflicts[0]).toMatchObject({ label: 'Org', property: 'hq' });
    expect(r.conflicts[0].values.map((v) => v.value).sort()).toEqual(['삼봉로 57', '새문안로 89'].sort());
    expect(r.conflicts[0].values.find((v) => v.value === '삼봉로 57').files).toEqual(['a_p04.kg.json']);
  });

  it('#7 같은 값은 충돌이 아니다 — 배열은 내용 동등, 문자열은 NFC·trim 후 비교한다', () => {
    const nfd = '정우빌딩'.normalize('NFD');
    const m = mergeReviewed([
      { file: 'a.kg.json', doc: { nodes: [org('0', '회사', { tags: ['a', 'b'], bld: '정우빌딩' })], relationships: [] } },
      { file: 'b.kg.json', doc: { nodes: [org('0', '회사', { tags: ['a', 'b'], bld: ` ${nfd} ` })], relationships: [] } },
    ]);
    const r = resolvePropertyOverrides(m, new Map());
    expect(r.conflictTotal).toBe(0);
  });

  it('#8 숫자와 문자열은 다른 값이다 — 타입 통합은 하지 않는다', () => {
    const m = mergeReviewed([
      { file: 'a.kg.json', doc: { nodes: [org('0', '회사', { year: 2016 })], relationships: [] } },
      { file: 'b.kg.json', doc: { nodes: [org('0', '회사', { year: '2016' })], relationships: [] } },
    ]);
    const r = resolvePropertyOverrides(m, new Map());
    expect(r.conflictTotal).toBe(1);
  });

  it('#9 관계 속성 충돌은 세지 않는다 — Q11로 명시 유보한 범위다', () => {
    const doc = (file, since) => ({
      file,
      doc: {
        nodes: [person('0', 'P'), org('1', 'O')],
        relationships: [{ type: 'MEMBER_OF', start_node_id: '0', end_node_id: '1', properties: { since } }],
      },
    });
    const m = mergeReviewed([doc('a.kg.json', '2001'), doc('b.kg.json', '2002')]);
    const r = resolvePropertyOverrides(m, new Map());
    expect(r.conflictTotal).toBe(0);
    expect(m.rels[0].props.since).toBe('2001'); // 관계 선착 유지도 불변
  });

  it('#10 변형 표기로 갈라진 노드도 canonicalize 뒤 하나의 충돌로 모인다', () => {
    const schema = schemaWith([], [{
      canonical: { label: 'Org', name: '회사(주)' },
      variants: [{ label: 'Org', name: '회사' }],
    }]);
    const canon = buildCanonicalIndex(schema).index;
    const m = mergeReviewed([
      { file: 'a.kg.json', doc: { nodes: [org('0', '회사', { hq: 'X' })], relationships: [] } },
      { file: 'b.kg.json', doc: { nodes: [org('0', '회사(주)', { hq: 'Y' })], relationships: [] } },
    ], canon);
    expect(m.nodes).toHaveLength(1);
    const r = resolvePropertyOverrides(m, new Map());
    expect(r.conflictTotal).toBe(1);
  });

  it('#11 충돌 목록은 (라벨, name_key, 속성) 결정적 정렬이다 — 파일 순서와 무관', () => {
    const docsA = [
      { file: 'a.kg.json', doc: { nodes: [org('0', 'B사', { hq: '1' }), org('1', 'A사', { hq: '1' })], relationships: [] } },
      { file: 'b.kg.json', doc: { nodes: [org('0', 'B사', { hq: '2' }), org('1', 'A사', { hq: '2' })], relationships: [] } },
    ];
    const r = resolvePropertyOverrides(mergeReviewed(docsA), new Map());
    expect(r.conflicts.map((c) => c.name)).toEqual(['A사', 'B사']);
  });
});

describe('resolvePropertyOverrides — 사전 적용 (선택 장치, 발명 금지)', () => {
  it('#12 Q10 재현 — 선착으로 과거 값이 이기는 상태에서 등재된 현행 값이 살아남는다', () => {
    const schema = schemaWith([{ node: { label: 'Org', name: '회사' }, property: 'hq', value: '새문안로 89' }]);
    const over = buildPropertyOverrideIndex(schema, emptyCanon());
    expect(over.problems).toEqual([]);
    const m = mergeReviewed(conflictDocs());
    const r = resolvePropertyOverrides(m, over.index);
    expect(m.nodes[0].props.hq).toBe('새문안로 89'); // 사전 승자
    expect(r.applied).toHaveLength(1);
    expect(r.unapplied).toEqual([]);
  });

  it('#13 사전이 해결한 충돌은 미해결 목록에서 빠진다 — 등재가 목록을 줄여야 품질 루프가 닫힌다', () => {
    const schema = schemaWith([{ node: { label: 'Org', name: '회사' }, property: 'hq', value: '새문안로 89' }]);
    const over = buildPropertyOverrideIndex(schema, emptyCanon());
    const r = resolvePropertyOverrides(mergeReviewed(conflictDocs()), over.index);
    expect(r.conflictTotal).toBe(0);
  });

  it('#14 node ref가 변형 표기여도 canonicalize를 거쳐 적용된다', () => {
    const canonical = [{
      canonical: { label: 'Org', name: '회사(주)' },
      variants: [{ label: 'Org', name: '회사' }],
    }];
    const schema = schemaWith(
      [{ node: { label: 'Org', name: '회사' }, property: 'hq', value: '새문안로 89' }], canonical,
    );
    const canon = buildCanonicalIndex(schema).index;
    const over = buildPropertyOverrideIndex(schema, canon);
    const m = mergeReviewed([
      { file: 'a.kg.json', doc: { nodes: [org('0', '회사(주)', { hq: '삼봉로 57' })], relationships: [] } },
      { file: 'b.kg.json', doc: { nodes: [org('0', '회사(주)', { hq: '새문안로 89' })], relationships: [] } },
    ], canon);
    const r = resolvePropertyOverrides(m, over.index);
    expect(r.applied).toHaveLength(1);
    expect(m.nodes[0].props.hq).toBe('새문안로 89');
  });

  it('#15 지정 값이 관측값에 없으면 적용하지 않고 사유·관측값과 함께 보고한다 — 재빌드는 계속된다', () => {
    const schema = schemaWith([{ node: { label: 'Org', name: '회사' }, property: 'hq', value: '없는 주소' }]);
    const over = buildPropertyOverrideIndex(schema, emptyCanon());
    const m = mergeReviewed(conflictDocs());
    const r = resolvePropertyOverrides(m, over.index);
    expect(r.applied).toEqual([]);
    expect(r.unapplied).toHaveLength(1);
    expect(r.unapplied[0].reason).toMatch(/관측/);
    expect(r.unapplied[0].observed.map((o) => o.value).sort()).toEqual(['삼봉로 57', '새문안로 89'].sort());
    expect(m.nodes[0].props.hq).toBe('삼봉로 57'); // 발명하지 않는다 — 선착 폴백 유지
    expect(r.conflictTotal).toBe(1); // 해결 안 됐으므로 충돌은 남는다
  });

  it('#16 대상 노드·속성이 없으면 적용하지 않고 보고한다 — 오타의 조용한 no-op 방지', () => {
    const schema = schemaWith([
      { node: { label: 'Org', name: '없는회사' }, property: 'hq', value: 'x' },
      { node: { label: 'Org', name: '회사' }, property: '없는속성', value: 'x' },
    ]);
    const over = buildPropertyOverrideIndex(schema, emptyCanon());
    const r = resolvePropertyOverrides(mergeReviewed(conflictDocs()), over.index);
    expect(r.unapplied).toHaveLength(2);
    expect(r.unapplied.map((u) => u.reason).join(' ')).toMatch(/노드/);
    expect(r.unapplied.map((u) => u.reason).join(' ')).toMatch(/속성/);
  });

  it('#17 멱등 — 같은 (schema, docs)면 두 번 돌려도 같은 결과다', () => {
    const schema = schemaWith([{ node: { label: 'Org', name: '회사' }, property: 'hq', value: '새문안로 89' }]);
    const run = () => {
      const over = buildPropertyOverrideIndex(schema, emptyCanon());
      const m = mergeReviewed(conflictDocs());
      const r = resolvePropertyOverrides(m, over.index);
      return JSON.stringify({ node: m.nodes[0].props, applied: r.applied, conflicts: r.conflicts });
    };
    expect(run()).toBe(run());
  });
});

describe('rebuildGraph 통합 — 주입 전 중단·요약 표면 (§4.3-8 v2.10)', () => {
  it('#18 사전 내부 모순이면 invalid_property_overrides로 중단하고 DB를 건드리지 않는다(질의 0건)', async () => {
    seedReviewed('a.kg.json', { nodes: [person('0', 'A')], relationships: [] });
    fs.writeFileSync(dataPaths().schemaFile, JSON.stringify(
      schemaWith([{ node: { label: 'Org', name: '회사' }, property: 'kgid', value: 'x' }]), null, 2,
    ), 'utf8');
    const fake = fakeSession();
    const r = await rebuildGraph({ sessionFactory: () => fake.session });
    expect(r).toMatchObject({ ok: false, reason: 'invalid_property_overrides' });
    expect(typeof r.summary).toBe('string'); // 도구 표면 계약 — 없으면 .split 크래시
    expect(formatRebuildSummary(r)).toContain('DB는 건드리지 않았습니다');
    expect(fake.queries).toHaveLength(0);
  });

  it('#19 미해결 충돌은 상위 10+총계로, 사전 적용·미적용은 건수·전량으로 요약에 실린다', async () => {
    seedReviewed('a_p04.kg.json', { nodes: [org('0', '회사', { hq: '삼봉로 57' })], relationships: [] });
    seedReviewed('b_p07.kg.json', { nodes: [org('0', '회사', { hq: '새문안로 89' })], relationships: [] });
    fs.writeFileSync(dataPaths().schemaFile, JSON.stringify(
      schemaWith([{ node: { label: 'Org', name: '회사' }, property: '없는속성', value: 'x' }]), null, 2,
    ), 'utf8');
    const fake = fakeSession({ nodes: 1, rels: 0 });
    const r = await rebuildGraph({ sessionFactory: () => fake.session });
    expect(r.ok).toBe(true);
    expect(r.propertyConflictTotal).toBe(1);
    expect(r.propertyConflicts).toHaveLength(1);
    expect(r.overridesUnapplied).toHaveLength(1);
    const text = formatRebuildSummary(r);
    expect(text).toContain('미해결 속성 충돌 1건');
    expect(text).toContain('사전 미적용');
  });

  it('#20 충돌 0건·사전 0건이면 요약에 관련 라인이 없다 — 조건부 라인 관례', async () => {
    seedReviewed('a.kg.json', { nodes: [person('0', 'A')], relationships: [] });
    const fake = fakeSession({ nodes: 1, rels: 0 });
    const r = await rebuildGraph({ sessionFactory: () => fake.session });
    const text = formatRebuildSummary(r);
    expect(text).not.toContain('속성 충돌');
    expect(text).not.toContain('사전 미적용');
  });

  it('#21 승인분 0건 + 사전 항목 존재 → 중단 없이 성공하고 미적용 전량을 보고한다', async () => {
    fs.writeFileSync(dataPaths().schemaFile, JSON.stringify(
      schemaWith([{ node: { label: 'Org', name: '회사' }, property: 'hq', value: 'x' }]), null, 2,
    ), 'utf8');
    const fake = fakeSession();
    const r = await rebuildGraph({ sessionFactory: () => fake.session });
    expect(r.ok).toBe(true);
    expect(r.nodes).toBe(0);
    expect(r.overridesUnapplied).toHaveLength(1);
  });

  it('#22 원장 build 항목에 사전 상태 식별자(schemaUpdatedAt)를 기록한다 — 재현성 근거', async () => {
    seedReviewed('a.kg.json', { nodes: [person('0', 'A')], relationships: [] });
    const fake = fakeSession({ nodes: 1, rels: 0 });
    await rebuildGraph({ sessionFactory: () => fake.session });
    const ledger = JSON.parse(fs.readFileSync(dataPaths().ledgerFile, 'utf8'));
    expect(ledger.build.schemaUpdatedAt).toBe('2026-08-26T00:00:00+09:00');
  });
});
