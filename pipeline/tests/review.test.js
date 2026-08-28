// 슬라이스 6 — S4 검수 워크플로 (TECH-SPEC §4.3-4~7 · §2.4.1·2·4).
// 격리된 KG_DATA_DIR에서 폴더 이동·원장 카운터·보류 판정·재생성 호출을 검증한다.
// 실엔진은 부르지 않는다 — 재생성은 주입한 가짜 구현이 호출 여부만 기록한다.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-review-'));
process.env.KG_DATA_DIR = ROOT;

const {
  assertSafeKgFileName, stemOf, inputFileOf, findLedgerByInput, describeStructure,
  listReviewQueue, prepareShow, approveKg, rejectKg,
  formatReviewList, formatShow, formatApprove, formatReject,
  HELD_THRESHOLD,
} = await import('../src/review/index.js');
const { dataPaths, ensureDataDirs } = await import('@bibliomind/shared/paths');

const GRAPH = {
  nodes: [
    { id: '0', label: 'Person', properties: { name: '카마도 탄지로' } },
    { id: '1', label: 'Person', properties: { name: '카마도 네즈코' } },
    { id: '2', label: 'Org', properties: { name: '귀살대' } },
  ],
  relationships: [
    { type: 'OLDER_BROTHER_OF', start_node_id: '0', end_node_id: '1', properties: {} },
    { type: 'MEMBER_OF', start_node_id: '0', end_node_id: '2', properties: {} },
  ],
};

/** Generated/·Reviewed/에 KG 파일 1건을 놓는다. */
function seedKg(dir, stem, { meta, graph = GRAPH } = {}) {
  const p = dataPaths();
  fs.writeFileSync(
    path.join(p[dir], `${stem}.kg.json`),
    JSON.stringify(meta ? { meta, ...graph } : graph, null, 2),
    'utf8',
  );
  return `${stem}.kg.json`;
}

function seedInputMd(stem) {
  fs.writeFileSync(path.join(dataPaths().input, `${stem}.md`), '---\ntitle: 시험\n---\n본문\n', 'utf8');
}

function seedLedger(entries) {
  fs.writeFileSync(dataPaths().ledgerFile, JSON.stringify({ version: 1, sources: entries }, null, 2), 'utf8');
}

function readLedger() {
  return JSON.parse(fs.readFileSync(dataPaths().ledgerFile, 'utf8'));
}

beforeEach(() => {
  ensureDataDirs();
  const p = dataPaths();
  for (const dir of [p.input, p.generated, p.reviewed, p.rejected]) {
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
  }
  fs.rmSync(p.ledgerFile, { force: true });
});

afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

describe('파일명 방어 — 인자는 LLM이 만들어 온다', () => {
  it('#1 정상 파일명은 통과한다', () => {
    expect(assertSafeKgFileName('20260822_a_p01.kg.json')).toBe('20260822_a_p01.kg.json');
  });

  it('#2 **상위 폴더 탈출을 거부한다** — data/ 밖을 건드릴 수 있다', () => {
    expect(() => assertSafeKgFileName('../../etc/passwd.kg.json')).toThrow(/파일명이어야/);
    expect(() => assertSafeKgFileName('sub/dir/x.kg.json')).toThrow(/파일명이어야/);
    expect(() => assertSafeKgFileName('C:\\Windows\\x.kg.json')).toThrow(/파일명이어야/);
  });

  it('#3 확장자가 다르면 거부한다 — 검수 대상은 .kg.json뿐', () => {
    expect(() => assertSafeKgFileName('a.md')).toThrow(/\.kg\.json/);
    expect(() => assertSafeKgFileName('')).toThrow(/비어/);
  });

  it('#4 stem 연쇄 — .kg.json ↔ .md (§2.4.2)', () => {
    expect(stemOf('20260822_a_p01.kg.json')).toBe('20260822_a_p01');
    expect(inputFileOf('20260822_a_p01')).toBe('20260822_a_p01.md');
  });
});

describe('원장 연결 — file 필드가 stem 연쇄의 유일한 고리 (§2.4.4)', () => {
  it('#5 Input 파일명으로 엔트리를 찾는다', () => {
    const ledger = { sources: { k1: { file: 'a.md', reject_count: 2 }, k2: { file: 'b.md' } } };
    expect(findLedgerByInput(ledger, 'a.md')).toEqual({ key: 'k1', entry: { file: 'a.md', reject_count: 2 } });
    expect(findLedgerByInput(ledger, 'z.md')).toBeNull();
  });
});

describe('review_list — 검수 대기 조회 (§4.3-4)', () => {
  it('#6 파일별 노드·관계 수와 엔진·신규 유형을 meta에서 읽는다', async () => {
    seedKg('generated', 'a_p01', {
      meta: { input_file: 'a_p01.md', schema_version: 3, engine: 'codex', generated_at: '2026-08-23T10:00:00+09:00', new_types: { node_labels: ['Org'], relationships: [] } },
    });
    const r = await listReviewQueue();
    expect(r.pendingCount).toBe(1);
    expect(r.items[0]).toMatchObject({
      file: 'a_p01.kg.json', sourceInput: 'a_p01.md', engine: 'codex',
      nodeCount: 3, relCount: 2, rejectCount: 0, held: false,
    });
    expect(r.items[0].newTypes.node_labels).toEqual(['Org']);
  });

  it('#7 **meta가 없으면 engine을 추측하지 않고 null로 보고한다**', async () => {
    seedKg('generated', 'a_p01');
    const r = await listReviewQueue();
    expect(r.items[0].engine).toBeNull();
    expect(r.metaMissingCount).toBe(1);
    expect(formatReviewList(r)).toContain('엔진 미기록 1건');
  });

  it('#8 rejectCount는 원장에서 오고 held는 그 파생 값이다 — 저장 상태가 아니다 (§2.4.4)', async () => {
    seedKg('generated', 'a_p01');
    seedKg('generated', 'b_p01');
    seedLedger({ k1: { file: 'a_p01.md', reject_count: HELD_THRESHOLD }, k2: { file: 'b_p01.md', reject_count: 1 } });
    const r = await listReviewQueue();
    const byFile = Object.fromEntries(r.items.map((i) => [i.file, i]));
    expect(byFile['a_p01.kg.json']).toMatchObject({ rejectCount: 3, held: true });
    expect(byFile['b_p01.kg.json']).toMatchObject({ rejectCount: 1, held: false });
    expect(r.heldCount).toBe(1);
  });

  it('#9 Reviewed·Rejected 총수를 함께 센다', async () => {
    seedKg('generated', 'a_p01');
    seedKg('reviewed', 'b_p01');
    fs.writeFileSync(path.join(dataPaths().rejected, 'c_p01.kg.rej1.json'), '{}', 'utf8');
    const r = await listReviewQueue();
    expect(r).toMatchObject({ pendingCount: 1, reviewedCount: 1, rejectedCount: 1 });
  });

  it('#10 손상된 JSON은 조용히 빼지 않고 그 파일만 오류로 표시한다', async () => {
    fs.writeFileSync(path.join(dataPaths().generated, 'bad_p01.kg.json'), '{ 깨짐', 'utf8');
    const r = await listReviewQueue();
    expect(r.items[0].readError).toBeTruthy();
    expect(r.items[0].nodeCount).toBeNull();
    expect(formatReviewList(r)).toContain('읽기 실패');
  });

  it('#11 요약에 다음 도구 사용법이 들어간다 (§4.3-4 규약)', async () => {
    const text = formatReviewList(await listReviewQueue());
    expect(text).toContain('review_show');
    expect(text).toContain('review_approve');
    expect(text).toContain('review_reject');
  });
});

describe('review_show — 검증 통과분만 화면에 (§4.3-5)', () => {
  it('#12 정상 파일은 정규화 그래프와 구조 요약을 돌려준다', async () => {
    seedKg('generated', 'a_p01', { meta: { input_file: 'a_p01.md', engine: 'claude' } });
    const r = await prepareShow({ file: 'a_p01.kg.json' });
    expect(r.ok).toBe(true);
    expect(r.from).toBe('Generated');
    expect(r.sourceInput).toBe('a_p01.md');
    expect(r.graph.nodes).toHaveLength(3);
    expect(r.structure.byLabel).toEqual({ Person: 2, Org: 1 });
    expect(r.structure.byRelType).toEqual({ OLDER_BROTHER_OF: 1, MEMBER_OF: 1 });
  });

  it('#13 Reviewed/의 승인분도 표시 대상이다 (의미 검수)', async () => {
    seedKg('reviewed', 'a_p01');
    const r = await prepareShow({ file: 'a_p01.kg.json' });
    expect(r).toMatchObject({ ok: true, from: 'Reviewed' });
  });

  it('#14 **구조가 깨지면 그래프를 돌려주지 않는다** — 화면에 올리지 않기 위해', async () => {
    fs.writeFileSync(path.join(dataPaths().generated, 'bad_p01.kg.json'), JSON.stringify({ nodes: [] }), 'utf8');
    const r = await prepareShow({ file: 'bad_p01.kg.json' });
    expect(r.ok).toBe(false);
    expect(r.graph).toBeUndefined();
    expect(formatShow(r)).toContain('표시하지 않았습니다');
  });

  it('#15 없는 파일은 실패로 환원한다 — throw하지 않는다', async () => {
    const r = await prepareShow({ file: 'nope_p01.kg.json' });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('찾지 못했습니다');
  });

  it('#16 describeStructure는 라벨·유형별로 센다', () => {
    expect(describeStructure(GRAPH)).toMatchObject({ nodeCount: 3, relCount: 2 });
  });
});

describe('review_approve — Reviewed/ 이동 + 카운터 리셋 (§4.3-6 · §2.4.4)', () => {
  it('#17 Generated → Reviewed 이동이 끝나면 원본은 남지 않는다', async () => {
    seedKg('generated', 'a_p01');
    const r = await approveKg({ file: 'a_p01.kg.json' });
    const p = dataPaths();
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(p.generated, 'a_p01.kg.json'))).toBe(false);
    expect(fs.existsSync(path.join(p.reviewed, 'a_p01.kg.json'))).toBe(true);
    expect(r.remaining).toBe(0);
  });

  it('#18 **승인은 반려 카운터를 0으로 리셋한다** — 실패 사슬의 종결 (§2.4.4 v2)', async () => {
    seedKg('generated', 'a_p01');
    seedLedger({ k1: { file: 'a_p01.md', reject_count: 2 } });
    const r = await approveKg({ file: 'a_p01.kg.json' });
    expect(r.resetFrom).toBe(2);
    expect(readLedger().sources.k1.reject_count).toBe(0);
    expect(formatApprove(r)).toContain('2 → 0');
  });

  it('#19 기존 승인분이 있으면 덮어쓰고 재주입 필요를 보고한다', async () => {
    seedKg('reviewed', 'a_p01');
    seedKg('generated', 'a_p01', { graph: { nodes: [{ id: '0', label: 'Person', properties: { name: '새 버전' } }], relationships: [] } });
    const r = await approveKg({ file: 'a_p01.kg.json' });
    expect(r.replaced).toBe(true);
    expect(formatApprove(r)).toContain('재주입');
    const kept = JSON.parse(fs.readFileSync(path.join(dataPaths().reviewed, 'a_p01.kg.json'), 'utf8'));
    expect(kept.nodes[0].properties.name).toBe('새 버전');
  });

  it('#20 이미 승인된 파일은 그 사실을 말해 준다', async () => {
    seedKg('reviewed', 'a_p01');
    const r = await approveKg({ file: 'a_p01.kg.json' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('이미 승인된');
  });

  it('#21 원장에 항목이 없어도 이동은 성공하고 그 사실을 보고한다', async () => {
    seedKg('generated', 'a_p01');
    const r = await approveKg({ file: 'a_p01.kg.json' });
    expect(r).toMatchObject({ ok: true, ledgerFound: false });
    expect(formatApprove(r)).toContain('찾지 못해');
  });
});

describe('review_reject — 이력 보존 + 카운터 + 자동 재생성 (§4.3-7 · §2.4.2)', () => {
  /** 재생성 호출을 기록만 하는 가짜 — 실엔진을 부르지 않는다. */
  function spyGenerate() {
    const calls = [];
    const impl = async (opts) => {
      calls.push(opts);
      return { generated: 1, failed: 0, results: [{ file: opts.files[0], ok: true }] };
    };
    return { calls, impl };
  }

  it('#22 **삭제가 아니라 이동이다** — Rejected/<stem>.kg.rej1.json', async () => {
    seedKg('generated', 'a_p01');
    seedInputMd('a_p01');
    const spy = spyGenerate();
    const r = await rejectKg({ file: 'a_p01.kg.json', reason: '관계가 원문과 다름', generateImpl: spy.impl });
    const p = dataPaths();
    expect(r.movedTo).toBe('a_p01.kg.rej1.json');
    expect(fs.existsSync(path.join(p.rejected, 'a_p01.kg.rej1.json'))).toBe(true);
    expect(fs.existsSync(path.join(p.generated, 'a_p01.kg.json'))).toBe(false);
  });

  it('#23 원장 카운터 +1과 사유가 기록된다', async () => {
    seedKg('generated', 'a_p01');
    seedInputMd('a_p01');
    seedLedger({ k1: { file: 'a_p01.md', reject_count: 1 } });
    const spy = spyGenerate();
    const r = await rejectKg({ file: 'a_p01.kg.json', reason: '오류', generateImpl: spy.impl });
    expect(r.rejectCount).toBe(2);
    const entry = readLedger().sources.k1;
    expect(entry.reject_count).toBe(2);
    expect(entry.last_reject_reason).toBe('오류');
  });

  it('#24 회차 접미사가 누적된다 — 같은 stem 3회 반려 시 파일 3개 공존 (§2.4.2)', async () => {
    seedInputMd('a_p01');
    const spy = spyGenerate();
    for (let i = 1; i <= 3; i += 1) {
      seedKg('generated', 'a_p01');
      await rejectKg({ file: 'a_p01.kg.json', generateImpl: spy.impl });
    }
    expect(fs.readdirSync(dataPaths().rejected).sort())
      .toEqual(['a_p01.kg.rej1.json', 'a_p01.kg.rej2.json', 'a_p01.kg.rej3.json']);
  });

  it('#25 자동 재생성은 **원본 Input을 지정해 1회만** 부른다', async () => {
    seedKg('generated', 'a_p01');
    seedInputMd('a_p01');
    const spy = spyGenerate();
    const r = await rejectKg({ file: 'a_p01.kg.json', generateImpl: spy.impl });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].files).toEqual(['a_p01.md']);
    expect(r.regenerate.ran).toBe(true);
    expect(formatReject(r)).toContain('자동 재생성 1회 실행');
  });

  it('#26 regenerate=false면 부르지 않는다 — 실수 반려 시 구독 소모 방지 (v2 신설)', async () => {
    seedKg('generated', 'a_p01');
    seedInputMd('a_p01');
    const spy = spyGenerate();
    const r = await rejectKg({ file: 'a_p01.kg.json', regenerate: false, generateImpl: spy.impl });
    expect(spy.calls).toHaveLength(0);
    expect(r.regenerate.skipReason).toContain('regenerate=false');
  });

  it('#27 **누적 3회면 재생성을 멈추고 보류한다** (§2.4.4 · PRD S4)', async () => {
    seedKg('generated', 'a_p01');
    seedInputMd('a_p01');
    seedLedger({ k1: { file: 'a_p01.md', reject_count: HELD_THRESHOLD - 1 } });
    const spy = spyGenerate();
    const r = await rejectKg({ file: 'a_p01.kg.json', generateImpl: spy.impl });
    expect(r.rejectCount).toBe(HELD_THRESHOLD);
    expect(r.held).toBe(true);
    expect(spy.calls).toHaveLength(0);
    expect(formatReject(r)).toContain('kg_generate');
  });

  it('#28 원본 Input이 없으면 재생성을 건너뛰고 이유를 말한다', async () => {
    seedKg('generated', 'a_p01');
    const spy = spyGenerate();
    const r = await rejectKg({ file: 'a_p01.kg.json', generateImpl: spy.impl });
    expect(spy.calls).toHaveLength(0);
    expect(r.regenerate.skipReason).toContain('a_p01.md');
  });

  it('#29 **승인분 반려는 제외 재빌드를 실행한다** (§4.3-7 ② — 슬라이스 7에서 연결)', async () => {
    seedKg('reviewed', 'a_p01');
    seedInputMd('a_p01');
    const spy = spyGenerate();
    const calls = [];
    const rebuildImpl = async () => {
      calls.push('rebuild');
      // 재빌드는 Reviewed/를 읽는다 — **이 시점에 파일이 이미 빠져 있어야** 반려가 반영된다.
      expect(fs.existsSync(path.join(dataPaths().reviewed, 'a_p01.kg.json'))).toBe(false);
      return { ok: true, nodes: 11, relationships: 18, buildId: '20260823T101112' };
    };
    const r = await rejectKg({ file: 'a_p01.kg.json', generateImpl: spy.impl, rebuildImpl });
    expect(r.from).toBe('Reviewed');
    expect(calls).toEqual(['rebuild']);
    expect(r.rebuild).toMatchObject({ required: true, done: true });
    expect(formatReject(r)).toContain('제외 재빌드 완료');
  });

  it('#29-a **재빌드가 실패해도 반려 자체는 성립한다** — 파일은 이미 옮겨졌다', async () => {
    seedKg('reviewed', 'a_p01');
    seedInputMd('a_p01');
    const spy = spyGenerate();
    const rebuildImpl = async () => { throw new Error('Neo4j 접속 불가'); };
    const r = await rejectKg({ file: 'a_p01.kg.json', generateImpl: spy.impl, rebuildImpl });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(dataPaths().rejected, 'a_p01.kg.rej1.json'))).toBe(true);
    expect(r.rebuild).toMatchObject({ required: true, done: false });
    expect(formatReject(r)).toContain('kg_rebuild를 실행하세요');
  });

  it('#29-b 구조 검수(Generated) 반려는 재빌드를 부르지 않는다 — DB에 들어간 적이 없다', async () => {
    seedKg('generated', 'a_p01');
    seedInputMd('a_p01');
    const spy = spyGenerate();
    const calls = [];
    await rejectKg({
      file: 'a_p01.kg.json', generateImpl: spy.impl,
      rebuildImpl: async () => { calls.push('rebuild'); return { ok: true }; },
    });
    expect(calls).toEqual([]);
  });

  it('#30 없는 파일은 실패로 환원한다', async () => {
    const r = await rejectKg({ file: 'nope_p01.kg.json' });
    expect(r.ok).toBe(false);
    expect(formatReject(r)).toContain('반려하지 못했습니다');
  });

  it('#31 원장이 어긋나 있어도 기존 반려 파일을 덮어쓰지 않는다', async () => {
    seedInputMd('a_p01');
    fs.writeFileSync(path.join(dataPaths().rejected, 'a_p01.kg.rej1.json'), '{"기존":true}', 'utf8');
    seedKg('generated', 'a_p01');
    seedLedger({ k1: { file: 'a_p01.md', reject_count: 0 } }); // 원장은 0이라고 주장한다
    const spy = spyGenerate();
    const r = await rejectKg({ file: 'a_p01.kg.json', generateImpl: spy.impl });
    expect(r.movedTo).toBe('a_p01.kg.rej2.json');
    expect(JSON.parse(fs.readFileSync(path.join(dataPaths().rejected, 'a_p01.kg.rej1.json'), 'utf8')))
      .toEqual({ 기존: true });
  });
});

describe('승인 → 반려 왕복 (슬라이스 6 완료 조건)', () => {
  it('#32 승인한 파일을 의미 검수에서 반려하면 Rejected로 가고 카운터가 다시 선다', async () => {
    seedKg('generated', 'a_p01');
    seedInputMd('a_p01');
    seedLedger({ k1: { file: 'a_p01.md', reject_count: 2 } });

    const approved = await approveKg({ file: 'a_p01.kg.json' });
    expect(approved.ok).toBe(true);
    expect(readLedger().sources.k1.reject_count).toBe(0); // 리셋

    const spy = { calls: [], impl: async (o) => { spy.calls.push(o); return { generated: 1, failed: 0, results: [] }; } };
    const rejected = await rejectKg({
      file: 'a_p01.kg.json', reason: '의미 검수 반려', generateImpl: spy.impl,
      rebuildImpl: async () => ({ ok: true, nodes: 0, relationships: 0, buildId: 'T' }),
    });
    expect(rejected).toMatchObject({ from: 'Reviewed', rejectCount: 1, held: false });
    expect(readLedger().sources.k1.reject_count).toBe(1);
    expect(spy.calls).toHaveLength(1); // 리셋 덕분에 보류가 아니라 재생성으로 간다
  });
});
