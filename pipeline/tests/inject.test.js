// 슬라이스 7 — S5 주입기 (TECH-SPEC §2.3·§4.3-8).
// **Neo4j를 실제로 때리지 않는다**(§1.12) — 질의를 받아 적는 가짜 세션으로 순서·질의문·배치를 검증하고,
// 병합·유사쌍 산출은 순수 함수로 직접 시험한다. 실연동은 `npm run rebuild:e2e`가 맡는다.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-inject-'));
process.env.KG_DATA_DIR = ROOT;

const {
  mergeReviewed, similarNamePairs, makeBuildId, loadReviewed, rebuildGraph,
  formatRebuildSummary, INJECT_BATCH, DELETE_BATCH,
} = await import('../src/inject/index.js');
const { dataPaths, ensureDataDirs } = await import('@bibliomind/shared/paths');
const { nodeKgid } = await import('@bibliomind/shared/normalize');

const SEED_SCHEMA = {
  schema_version: 1,
  node_labels: [{ label: 'Person', origin: 'seed' }, { label: 'Org', origin: 'seed' }],
  core_relationships: [{ type: 'MEMBER_OF', origin: 'seed' }],
  extended_relationships: [],
};

/** Reviewed/에 KG 파일 1건을 놓는다. */
function seedReviewed(name, graph, meta) {
  fs.writeFileSync(
    path.join(dataPaths().reviewed, name),
    JSON.stringify(meta ? { meta, ...graph } : graph, null, 2),
    'utf8',
  );
}

const person = (id, name, extra = {}) => ({ id, label: 'Person', properties: { name, ...extra } });

/** 질의를 받아 적기만 하는 가짜 세션. count 질의에는 미리 정한 수를 돌려준다. */
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

describe('mergeReviewed — 병합 키와 속성 규칙 (§2.3.2)', () => {
  it('#1 같은 (라벨, name_key)는 하나로 합쳐진다', () => {
    const m = mergeReviewed([
      { file: 'a.kg.json', doc: { nodes: [person('0', '카마도 탄지로')], relationships: [] } },
      { file: 'b.kg.json', doc: { nodes: [person('0', '카마도  탄지로')], relationships: [] } }, // 공백만 다름
    ]);
    expect(m.nodes).toHaveLength(1);
    expect(m.nodes[0].reviewed_files).toEqual(['a.kg.json', 'b.kg.json']);
  });

  it('#2 **라벨이 다르면 합치지 않는다** — 병합 키는 (라벨, name_key) 쌍이다', () => {
    const m = mergeReviewed([
      { file: 'a.kg.json', doc: { nodes: [person('0', '귀살대')], relationships: [] } },
      { file: 'b.kg.json', doc: { nodes: [{ id: '0', label: 'Org', properties: { name: '귀살대' } }], relationships: [] } },
    ]);
    expect(m.nodes).toHaveLength(2);
  });

  it('#3 속성은 **선착 우선** — 뒤 파일이 덮어쓰지 않는다', () => {
    const m = mergeReviewed([
      { file: 'a.kg.json', doc: { nodes: [person('0', '탄지로', { role: '주인공' })], relationships: [] } },
      { file: 'b.kg.json', doc: { nodes: [person('0', '탄지로', { role: '검사', age: 15 })], relationships: [] } },
    ]);
    expect(m.nodes[0].props.role).toBe('주인공'); // 선착 유지
    expect(m.nodes[0].props.age).toBe(15); // 없던 키는 보강
  });

  it('#4 표시 이름은 **첫 등장 표기**를 유지한다 — 병합 키만 정규화한다', () => {
    const m = mergeReviewed([
      { file: 'a.kg.json', doc: { nodes: [person('0', 'Tanjiro')], relationships: [] } },
      { file: 'b.kg.json', doc: { nodes: [person('0', 'TANJIRO')], relationships: [] } },
    ]);
    expect(m.nodes[0].name).toBe('Tanjiro');
    expect(m.nodes[0].name_key).toBe('tanjiro');
  });

  it('#5 kgid는 내용이 같으면 재빌드와 무관하게 같다 (§3.5)', () => {
    const m = mergeReviewed([{ file: 'a.kg.json', doc: { nodes: [person('0', '탄지로')], relationships: [] } }]);
    expect(m.nodes[0].kgid).toBe(nodeKgid('Person', '탄지로'));
    expect(m.nodes[0].kgid.startsWith('n_')).toBe(true);
  });

  it('#6 관계 중복 제거 키는 (시작 kgid, type, 끝 kgid)', () => {
    const doc = {
      nodes: [person('0', '탄지로'), { id: '1', label: 'Org', properties: { name: '귀살대' } }],
      relationships: [
        { type: 'MEMBER_OF', start_node_id: '0', end_node_id: '1', properties: { since: 1 } },
        { type: 'MEMBER_OF', start_node_id: '0', end_node_id: '1', properties: { since: 2 } },
      ],
    };
    const m = mergeReviewed([{ file: 'a.kg.json', doc }]);
    expect(m.rels).toHaveLength(1);
    expect(m.rels[0].props.since).toBe(1); // 선착 유지
  });

  it('#7 출처 배열은 정렬·중복 제거되고 meta.input_file을 따른다', () => {
    const m = mergeReviewed([
      { file: 'b.kg.json', doc: { meta: { input_file: 'src_b.md' }, nodes: [person('0', 'X')], relationships: [] } },
      { file: 'a.kg.json', doc: { meta: { input_file: 'src_a.md' }, nodes: [person('0', 'X')], relationships: [] } },
    ]);
    expect(m.nodes[0].reviewed_files).toEqual(['a.kg.json', 'b.kg.json']);
    expect(m.nodes[0].input_files).toEqual(['src_a.md', 'src_b.md']);
  });

  it('#8 meta가 없으면 stem 연쇄로 Input 파일명을 유도한다', () => {
    const m = mergeReviewed([{ file: 'x_p01.kg.json', doc: { nodes: [person('0', 'X')], relationships: [] } }]);
    expect(m.nodes[0].input_files).toEqual(['x_p01.md']);
  });
});

describe('similarNamePairs — 병합 누락 가시화 (§2.3.2)', () => {
  it('#9 같은 라벨에서 포함 관계인 쌍을 찾는다', () => {
    const pairs = similarNamePairs([
      { label: 'Person', name: '탄지로', name_key: '탄지로' },
      { label: 'Person', name: '카마도 탄지로', name_key: '카마도 탄지로' },
      { label: 'Person', name: '네즈코', name_key: '네즈코' },
    ]);
    expect(pairs).toEqual([{ label: 'Person', shorter: '탄지로', longer: '카마도 탄지로' }]);
  });

  it('#10 **라벨이 다르면 쌍이 아니다** — 병합 후보가 아니기 때문', () => {
    expect(similarNamePairs([
      { label: 'Person', name: '탄지로', name_key: '탄지로' },
      { label: 'Org', name: '카마도 탄지로', name_key: '카마도 탄지로' },
    ])).toEqual([]);
  });

  it('#11 자동으로 합치지는 않는다 — 과병합 방지(보고만 한다)', () => {
    const m = mergeReviewed([{
      file: 'a.kg.json',
      doc: { nodes: [person('0', '탄지로'), person('1', '카마도 탄지로')], relationships: [] },
    }]);
    expect(m.nodes).toHaveLength(2); // 합쳐지지 않았다
    expect(similarNamePairs(m.nodes)).toHaveLength(1); // 보고만 된다
  });
});

describe('loadReviewed — DB에 손대기 전 전량 검증', () => {
  it('#12 정상 파일은 파일명 오름차순으로 실린다', async () => {
    seedReviewed('b.kg.json', { nodes: [person('0', 'B')], relationships: [] });
    seedReviewed('a.kg.json', { nodes: [person('0', 'A')], relationships: [] });
    const r = await loadReviewed(dataPaths().reviewed);
    expect(r.ok).toBe(true);
    expect(r.docs.map((d) => d.file)).toEqual(['a.kg.json', 'b.kg.json']);
  });

  it('#13 깨진 파일이 하나라도 있으면 **전체를 중단**한다', async () => {
    seedReviewed('ok.kg.json', { nodes: [person('0', 'A')], relationships: [] });
    fs.writeFileSync(path.join(dataPaths().reviewed, 'bad.kg.json'), '{ 깨짐', 'utf8');
    const r = await loadReviewed(dataPaths().reviewed);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('bad.kg.json');
  });

  it('#14 **라벨 보간 게이트** — 명명 규칙 위반은 Cypher에 들어가기 전에 막는다', async () => {
    seedReviewed('x.kg.json', {
      nodes: [{ id: '0', label: 'Bad`Label', properties: { name: 'X' } }], relationships: [],
    });
    const r = await loadReviewed(dataPaths().reviewed);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/명명 규칙/);
  });

  it('#15 폴더가 없으면 빈 목록(첫 실행 — 오류가 아니다)', async () => {
    const r = await loadReviewed(path.join(ROOT, '없는폴더'));
    expect(r).toEqual({ ok: true, docs: [] });
  });
});

describe('rebuildGraph — 순서·질의문·잠금 (§2.3.4·§2.5-6)', () => {
  it('#16 **검증 실패 시 DB를 건드리지 않는다** — 지운 뒤 발견하면 복구할 것이 없다', async () => {
    fs.writeFileSync(path.join(dataPaths().reviewed, 'bad.kg.json'), '{ 깨짐', 'utf8');
    const fake = fakeSession();
    const r = await rebuildGraph({ sessionFactory: () => fake.session });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_input');
    expect(fake.queries).toHaveLength(0); // 질의 0건
    expect(formatRebuildSummary(r)).toContain('DB는 건드리지 않았습니다');
  });

  it('#17 삭제는 **이중 방벽**이고 전체 삭제 질의를 쓰지 않는다 (§2.3.4)', async () => {
    seedReviewed('a.kg.json', { nodes: [person('0', 'A')], relationships: [] });
    const fake = fakeSession();
    await rebuildGraph({ sessionFactory: () => fake.session });
    const del = fake.queries.find((q) => /DETACH DELETE/.test(q.cypher));
    expect(del.cypher).toContain('MATCH (n:RKEntity)');
    expect(del.cypher).toContain('n.reviewed_files IS NOT NULL');
    expect(del.cypher).toContain(`IN TRANSACTIONS OF ${DELETE_BATCH} ROWS`);
    // 무조건 전체 삭제는 어디에도 없어야 한다
    expect(fake.queries.some((q) => /MATCH \(n\) DETACH DELETE/.test(q.cypher))).toBe(false);
  });

  it('#18 순서 고정: 보호 확인 → 삭제 → 제약 → 노드 → 관계 → 인덱스', async () => {
    seedReviewed('a.kg.json', {
      nodes: [person('0', 'A'), { id: '1', label: 'Org', properties: { name: 'O' } }],
      relationships: [{ type: 'MEMBER_OF', start_node_id: '0', end_node_id: '1', properties: {} }],
    });
    const fake = fakeSession();
    await rebuildGraph({ sessionFactory: () => fake.session });
    const at = (re) => fake.queries.findIndex((q) => re.test(q.cypher));
    const foreign = at(/WHERE NOT n:RKEntity/);
    const del = at(/DETACH DELETE/);
    const constraint = at(/CREATE CONSTRAINT/);
    const node = at(/CREATE \(n:RKEntity/);
    const rel = at(/CREATE \(a\)-\[r:/);
    const index = at(/CREATE RANGE INDEX/);
    expect(foreign).toBeLessThan(del);
    expect(del).toBeLessThan(constraint);
    expect(constraint).toBeLessThan(node);
    expect(node).toBeLessThan(rel);
    expect(rel).toBeLessThan(index);
  });

  it('#19 제약은 **전역 스키마의 라벨마다** 만든다(자동 등재분 추종)', async () => {
    seedReviewed('a.kg.json', { nodes: [person('0', 'A')], relationships: [] });
    const fake = fakeSession();
    const r = await rebuildGraph({ sessionFactory: () => fake.session });
    expect(r.constraints).toBe(2); // Person·Org
    expect(fake.queries.some((q) => /kg_uniq_Person/.test(q.cypher))).toBe(true);
    expect(fake.queries.some((q) => /kg_uniq_Org/.test(q.cypher))).toBe(true);
  });

  it('#20 노드는 배치로 나눠 넣는다', async () => {
    const nodes = Array.from({ length: INJECT_BATCH + 7 }, (_, i) => person(String(i), `P${i}`));
    seedReviewed('a.kg.json', { nodes, relationships: [] });
    const fake = fakeSession();
    const r = await rebuildGraph({ sessionFactory: () => fake.session });
    const inserts = fake.queries.filter((q) => /CREATE \(n:RKEntity/.test(q.cypher));
    expect(inserts.map((q) => q.rows)).toEqual([INJECT_BATCH, 7]);
    expect(r.nodes).toBe(INJECT_BATCH + 7);
  });

  it('#21 자기검증 — DB 실측이 다르면 불일치를 보고한다(넣었다고 믿지 않는다)', async () => {
    seedReviewed('a.kg.json', { nodes: [person('0', 'A')], relationships: [] });
    const fake = fakeSession({ nodes: 999, rels: 0 });
    const r = await rebuildGraph({ sessionFactory: () => fake.session });
    expect(r.verified).toMatchObject({ nodes: 999, match: false });
    expect(formatRebuildSummary(r)).toContain('자기검증 불일치');
  });

  it('#22 도구 외 데이터가 있으면 건드리지 않았음을 수치로 보고한다', async () => {
    seedReviewed('a.kg.json', { nodes: [person('0', 'A')], relationships: [] });
    const fake = fakeSession({ foreign: 3, nodes: 1, rels: 0 });
    const r = await rebuildGraph({ sessionFactory: () => fake.session });
    expect(r.foreignNodes).toBe(3);
    expect(formatRebuildSummary(r)).toContain('건드리지 않음');
  });

  it('#23 buildId를 원장에 기록한다 (§3.5-5) — sources는 보존한다', async () => {
    fs.writeFileSync(dataPaths().ledgerFile,
      JSON.stringify({ version: 1, sources: { k1: { file: 'x.md' } } }, null, 2), 'utf8');
    seedReviewed('a.kg.json', { nodes: [person('0', 'A')], relationships: [] });
    const fake = fakeSession({ nodes: 1, rels: 0 });
    const r = await rebuildGraph({ sessionFactory: () => fake.session, now: new Date('2026-08-23T14:25:30') });
    const ledger = JSON.parse(fs.readFileSync(dataPaths().ledgerFile, 'utf8'));
    expect(r.buildId).toBe('20260823T142530');
    expect(ledger.build.buildId).toBe('20260823T142530');
    expect(ledger.sources.k1.file).toBe('x.md'); // 원장의 수집 기록은 그대로
  });

  it('#24 **다른 재빌드가 잡고 있으면 기다리지 않고 거절한다**', async () => {
    fs.writeFileSync(dataPaths().lockFile,
      JSON.stringify({ pid: process.pid, holder: 'other', at: 'now' }), 'utf8');
    const fake = fakeSession();
    const r = await rebuildGraph({ sessionFactory: () => fake.session });
    expect(r).toMatchObject({ ok: false, reason: 'locked' });
    expect(fake.queries).toHaveLength(0);
  });

  it('#25 잠금은 성공·실패와 무관하게 반드시 풀린다', async () => {
    seedReviewed('a.kg.json', { nodes: [person('0', 'A')], relationships: [] });
    await rebuildGraph({ sessionFactory: () => fakeSession().session });
    expect(fs.existsSync(dataPaths().lockFile)).toBe(false);

    await rebuildGraph({
      sessionFactory: () => ({ async run() { throw new Error('DB 폭발'); }, async close() {} }),
    }).catch(() => {});
    expect(fs.existsSync(dataPaths().lockFile)).toBe(false);
  });

  it('#26 승인분이 0건이면 빈 그래프임을 알리고 다음 행동을 안내한다', async () => {
    const fake = fakeSession();
    const r = await rebuildGraph({ sessionFactory: () => fake.session });
    expect(r.ok).toBe(true);
    expect(r.nodes).toBe(0);
    expect(formatRebuildSummary(r)).toContain('review_approve');
  });

  it('#27 병합 건수를 보고한다', async () => {
    seedReviewed('a.kg.json', { nodes: [person('0', 'X')], relationships: [] });
    seedReviewed('b.kg.json', { nodes: [person('0', 'X')], relationships: [] });
    const fake = fakeSession({ nodes: 1, rels: 0 });
    const r = await rebuildGraph({ sessionFactory: () => fake.session });
    expect(r).toMatchObject({ files: 2, nodes: 1, mergedNodes: 1 });
    expect(formatRebuildSummary(r)).toContain('병합 1건');
  });
});

describe('makeBuildId', () => {
  it('#28 로컬 시각 기준 타임스탬프', () => {
    expect(makeBuildId(new Date('2026-01-02T03:04:05'))).toBe('20260102T030405');
  });
});
