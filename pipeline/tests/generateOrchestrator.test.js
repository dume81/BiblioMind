// S3 오케스트레이터 e2e — **가짜 엔진으로만** 돌린다 (TECH-SPEC §1.12-2, 실구독 미소모).
// 격리된 KG_DATA_DIR에서 Input → Generated 원자 이동·스킵 판정·한도 전환·스키마 자동 등재를 검증한다.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-engine.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-orch-'));
process.env.KG_DATA_DIR = ROOT;

const { generateKg, pendingInputs, registerNewTypes } = await import('../src/generate/index.js');
const { dataPaths, ensureDataDirs } = await import('@bibliomind/shared/paths');

const SEED_SCHEMA = {
  schema_version: 1,
  updated_at: '2026-08-22',
  policy: 'reuse-first',
  node_labels: [{ label: 'Person', ko: '인물', origin: 'seed' }],
  node_label_name_rule: 'PascalCase',
  core_relationships: [{ type: 'OLDER_BROTHER_OF', ko: '형', origin: 'seed' }],
  extended_relationships: [],
  relationship_name_rule: 'UPPER_SNAKE_CASE',
  instructions_ko: [],
};

/** 가짜 엔진을 spawn하는 주입 함수. */
const fake = (scenario, extra = []) => () =>
  spawn(process.execPath, [FAKE, scenario, ...extra], { stdio: ['pipe', 'pipe', 'pipe'] });

/** 어댑터 자리에 끼울 가짜 구현 — 실제 어댑터의 계약만 흉내낸다. */
function fakeEngines(map) {
  const make = (name) => ({
    ENGINE_NAME: name,
    async run(req) {
      const mod = await import('../src/generate/engines/claude.js');
      return mod.run({ ...req, spawnImpl: fake(map[name], ['--envelope']) });
    },
  });
  return { codex: make('codex'), claude: make('claude') };
}

function seedInput(name, body = '탄지로는 네즈코의 오빠다.') {
  const p = dataPaths();
  ensureDataDirs();
  fs.writeFileSync(path.join(p.input, name), `---\nsource_type: web\ntitle: 시험\n---\n${body}\n`, 'utf8');
}

beforeEach(() => {
  const p = dataPaths();
  ensureDataDirs();
  for (const dir of [p.input, p.generated, p.reviewed]) {
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
  }
  fs.writeFileSync(p.schemaFile, JSON.stringify(SEED_SCHEMA, null, 2), 'utf8');
});

afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

describe('스킵 판정 — Generated ∪ Reviewed 기준, Rejected 제외 (§2.4.1)', () => {
  it('#1 아무것도 없으면 전부 대기', async () => {
    seedInput('a.md'); seedInput('b.md');
    expect((await pendingInputs(dataPaths())).sort()).toEqual(['a.md', 'b.md']);
  });

  it('#2 Generated에 있으면 제외', async () => {
    seedInput('a.md'); seedInput('b.md');
    fs.writeFileSync(path.join(dataPaths().generated, 'a.kg.json'), '{}', 'utf8');
    expect(await pendingInputs(dataPaths())).toEqual(['b.md']);
  });

  it('#3 Reviewed에 있어도 제외 — 승인분을 다시 만들지 않는다', async () => {
    seedInput('a.md');
    fs.writeFileSync(path.join(dataPaths().reviewed, 'a.kg.json'), '{}', 'utf8');
    expect(await pendingInputs(dataPaths())).toEqual([]);
  });

  it('#4 **Rejected는 판정에서 제외한다** — 반려분이 재생성 경로에서 영구 누락되면 안 된다', async () => {
    seedInput('a.md');
    fs.writeFileSync(path.join(dataPaths().rejected, 'a.kg.rej1.json'), '{}', 'utf8');
    expect(await pendingInputs(dataPaths())).toEqual(['a.md']);
  });
});

describe('생성 — 검증 통과분만 Generated로 (§2.5)', () => {
  it('#5 정상 생성 시 Generated에 파일이 놓이고 limit 기본 1이 지켜진다', async () => {
    seedInput('a.md'); seedInput('b.md');
    const r = await generateKg({ enginesImpl: fakeEngines({ codex: 'good', claude: 'good' }), timeoutMs: 20000 });
    expect(r.generated).toBe(1);
    expect(r.remaining).toBe(1);
    expect(fs.readdirSync(dataPaths().generated)).toHaveLength(1);
  });

  it('#6 limit을 올리면 그만큼 처리한다', async () => {
    seedInput('a.md'); seedInput('b.md');
    const r = await generateKg({ limit: 2, enginesImpl: fakeEngines({ codex: 'good', claude: 'good' }), timeoutMs: 20000 });
    expect(r.generated).toBe(2);
    expect(r.remaining).toBe(0);
  });

  it('#7 **files 명시가 limit을 이긴다** (§4.3-3 사용자 의도 우선)', async () => {
    seedInput('a.md'); seedInput('b.md'); seedInput('c.md');
    const r = await generateKg({ files: ['a.md', 'b.md', 'c.md'], limit: 1, enginesImpl: fakeEngines({ codex: 'good', claude: 'good' }), timeoutMs: 20000 });
    expect(r.generated).toBe(3);
  });

  it('#8 **검증 실패는 Generated에 진입하지 못한다** — 교정 재호출 1회 후 실패 보고', async () => {
    seedInput('a.md');
    const r = await generateKg({ enginesImpl: fakeEngines({ codex: 'bad', claude: 'bad' }), timeoutMs: 20000 });
    expect(r.generated).toBe(0);
    expect(r.results[0]).toMatchObject({ ok: false, kind: 'bad_output' });
    expect(r.results[0].summary).toContain('교정 재호출');
    expect(fs.readdirSync(dataPaths().generated)).toHaveLength(0);
  });

  it('#9 백틱 펜스가 붙어 와도 통과시킨다', async () => {
    seedInput('a.md');
    const r = await generateKg({ enginesImpl: fakeEngines({ codex: 'fenced', claude: 'fenced' }), timeoutMs: 20000 });
    expect(r.generated).toBe(1);
  });
});

describe('한도 전환 (failover) — §1.4', () => {
  it('#10 시작 엔진이 한도면 **같은 파일부터 타 엔진으로 전환**해 계속한다', async () => {
    seedInput('a.md');
    const r = await generateKg({
      engine: 'codex',
      enginesImpl: fakeEngines({ codex: 'ratelimit', claude: 'good' }),
      timeoutMs: 20000,
    });
    expect(r.generated).toBe(1);
    expect(r.switches[0]).toMatchObject({ from: 'codex', to: 'claude' });
    expect(r.byEngine).toMatchObject({ codex: 0, claude: 1 });
  });

  it('#11 **양쪽 소진이면 중단하고 보고한다** — 자동 대기·폴링 없음', async () => {
    seedInput('a.md'); seedInput('b.md');
    const r = await generateKg({
      limit: 2, enginesImpl: fakeEngines({ codex: 'ratelimit', claude: 'ratelimit' }), timeoutMs: 20000,
    });
    expect(r.generated).toBe(0);
    expect(r.exhausted).toBe(true);
    expect(r.results).toHaveLength(1); // 첫 파일에서 중단 — 두 번째는 시도하지 않는다
  });

  it('#12 **failover=false면 전환하지 않는다** — 엔진별 준수율 측정용', async () => {
    seedInput('a.md');
    const r = await generateKg({
      engine: 'codex', failover: false,
      enginesImpl: fakeEngines({ codex: 'ratelimit', claude: 'good' }),
      timeoutMs: 20000,
    });
    expect(r.generated).toBe(0);
    expect(r.switches).toHaveLength(0);
  });
});

describe('신규 유형 자동 등재 (§2.1)', () => {
  it('#13 미등재 유형이 나오면 등재하고 schema_version이 +1 된다', async () => {
    const before = JSON.parse(fs.readFileSync(dataPaths().schemaFile, 'utf8'));
    const r = await registerNewTypes(before, { node_labels: ['Ritual'], relationships: ['INVENTED_BY'] }, dataPaths().schemaFile);
    expect(r).toMatchObject({ registered: true, from: 1, to: 2, nodes: ['Ritual'], rels: ['INVENTED_BY'] });
    const after = JSON.parse(fs.readFileSync(dataPaths().schemaFile, 'utf8'));
    expect(after.schema_version).toBe(2);
    expect(after.node_labels.map((x) => x.label)).toContain('Ritual');
    expect(after.extended_relationships.map((x) => x.type)).toContain('INVENTED_BY');
  });

  it('#14 이미 등록된 유형은 다시 넣지 않고 버전도 올리지 않는다', async () => {
    const before = JSON.parse(fs.readFileSync(dataPaths().schemaFile, 'utf8'));
    const r = await registerNewTypes(before, { node_labels: ['Person'], relationships: ['OLDER_BROTHER_OF'] }, dataPaths().schemaFile);
    expect(r).toMatchObject({ registered: false, from: 1, to: 1 });
    expect(JSON.parse(fs.readFileSync(dataPaths().schemaFile, 'utf8')).schema_version).toBe(1);
  });

  it('#15 생성 실행이 끝나면 실행 단위로 1회 등재된다 — 파일마다 올리지 않는다', async () => {
    seedInput('a.md'); seedInput('b.md');
    const r = await generateKg({ limit: 2, enginesImpl: fakeEngines({ codex: 'good', claude: 'good' }), timeoutMs: 20000 });
    expect(r.generated).toBe(2);
    // 가짜 엔진 출력에 Ritual·INVENTED_BY가 있다 → 1 → 2 (2가 아니라 3이 되면 파일마다 올린 것)
    expect(r.schemaUpdate).toMatchObject({ registered: true, from: 1, to: 2 });
    expect(JSON.parse(fs.readFileSync(dataPaths().schemaFile, 'utf8')).schema_version).toBe(2);
  });
});
