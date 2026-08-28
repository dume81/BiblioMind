// 슬라이스 8 — source_remove 도메인 (TECH-SPEC §4.3-9 v2.12 · §2.4.1).
// 반박 패널(2026-08-26)이 실증한 함정을 시험으로 고정한다 —
// 리다이렉트 쌍둥이 전수 처리 · 프론트매터 키 복원(파싱→차단→삭제) · 부분 실패 멱등 · rej 앵커.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import matter from 'gray-matter';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-remove-'));
process.env.KG_DATA_DIR = ROOT;

const { removeSource } = await import('../src/remove/index.js');
const { dataPaths, ensureDataDirs } = await import('@bibliomind/shared/paths');
const { loadLedger, saveLedger, webKey, STATUS, LEDGER_VERSION } = await import('../src/ledger.js');
const { sha16 } = await import('@bibliomind/shared/normalize');

const STEM = '20260826000000_ex_p01';
const URL_A = 'https://ex.com/a';
const URL_B = 'https://ex.com/b'; // 리다이렉트로 a와 같은 문서에 도달하는 쌍둥이

function p() { return dataPaths(); }

function seedInput(stem = STEM, fm = {}) {
  const body = matter.stringify('본문', {
    source_type: 'web', url: URL_A, url_normalized: URL_A,
    source_hash: webKey(URL_A).key, domain: 'ex', title: 'x',
    collected_at: '2026-08-26', batch: '20260826000000', ...fm,
  });
  fs.writeFileSync(path.join(p().input, `${stem}.md`), body, 'utf8');
}

function seedFiles(stem = STEM, { generated = true, reviewed = false, rejCounts = [] } = {}) {
  const graph = JSON.stringify({ nodes: [], relationships: [] });
  if (generated) fs.writeFileSync(path.join(p().generated, `${stem}.kg.json`), graph, 'utf8');
  if (reviewed) fs.writeFileSync(path.join(p().reviewed, `${stem}.kg.json`), graph, 'utf8');
  for (const n of rejCounts) fs.writeFileSync(path.join(p().rejected, `${stem}.kg.rej${n}.json`), graph, 'utf8');
}

async function seedLedger(entries) {
  await saveLedger({ version: LEDGER_VERSION, sources: entries }, p().ledgerFile);
}

function entryFor(url, file, extra = {}) {
  const { key, normalized } = webKey(url);
  return [key, {
    kind: 'web', source: normalized, final_url: normalized, final_hash: sha16(normalized),
    status: STATUS.COLLECTED, file, title: 'x', batch: '20260826000000',
    attempts: 1, last_error: null, collected_at: '2026-08-26', last_attempt_at: '2026-08-26',
    reject_count: 0, ...extra,
  }];
}

beforeEach(() => {
  ensureDataDirs();
  for (const dir of [p().input, p().generated, p().reviewed, p().rejected]) {
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  }
  fs.rmSync(p().ledgerFile, { force: true });
  fs.writeFileSync(p().schemaFile, JSON.stringify({
    schema_version: 1, node_labels: [], core_relationships: [], extended_relationships: [],
  }), 'utf8');
});

afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

describe('target 해석', () => {
  it('#1 경로 문자가 섞이면 즉시 거부한다 (1004행 계약)', async () => {
    for (const bad of ['../탈출.md', 'a/b.md', 'a\\b.md']) {
      const r = await removeSource({ target: bad, mode: 'recollect_ok' });
      expect(r.ok, bad).toBe(false);
    }
  });

  it('#2 스킴리스 URL 추정 입력은 "https://를 붙여" 안내한다', async () => {
    const r = await removeSource({ target: 'ex.com/company', mode: 'recollect_ok' });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('https://');
  });

  it('#3 형식이 깨진 URL은 크래시가 아니라 안내로 반환한다', async () => {
    const r = await removeSource({ target: 'https://', mode: 'recollect_ok' });
    expect(r.ok).toBe(false);
  });

  it('#4 .kg.json 파일명도 stem 환산으로 수용한다 — review_list 복사 실수 대비', async () => {
    seedInput(); seedFiles(STEM, { generated: true });
    const [k, e] = entryFor(URL_A, `${STEM}.md`);
    await seedLedger({ [k]: e });
    const r = await removeSource({ target: `${STEM}.kg.json`, mode: 'recollect_ok' });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(p().input, `${STEM}.md`))).toBe(false);
  });
});

describe('완전 제거 — 파일·원장', () => {
  it('#5 4폴더 + rej 전 회차를 지우고 전수 목록을 반환한다', async () => {
    seedInput(); seedFiles(STEM, { generated: true, reviewed: true, rejCounts: [1, 2] });
    const [k, e] = entryFor(URL_A, `${STEM}.md`);
    await seedLedger({ [k]: e });
    const r = await removeSource({ target: `${STEM}.md`, mode: 'recollect_ok', rebuildImpl: async () => ({ ok: true, nodes: 0, relationships: 0, buildId: 'b' }) });
    expect(r.ok).toBe(true);
    expect(r.removed).toHaveLength(5); // md + generated + reviewed + rej1 + rej2
    const ledger = await loadLedger(p().ledgerFile);
    expect(ledger.sources[k]).toBeUndefined(); // recollect_ok = 엔트리 삭제
  });

  it('#6 rej 매칭은 앵커 정규식이다 — 타 stem 반려 파일을 오폭하지 않는다', async () => {
    seedInput(); seedFiles(STEM, { rejCounts: [1] });
    const otherRej = `${STEM}.kg.rejX_p01.kg.rej1.json`; // startsWith면 오폭되는 이름
    fs.writeFileSync(path.join(p().rejected, otherRej), '{}', 'utf8');
    const r = await removeSource({ target: `${STEM}.md`, mode: 'recollect_ok' });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(p().rejected, otherRej))).toBe(true); // 살아남는다
    expect(fs.existsSync(path.join(p().rejected, `${STEM}.kg.rej1.json`))).toBe(false);
  });

  it('#7 리다이렉트 쌍둥이 — 같은 file을 공유하는 원장 엔트리 전수를 함께 처리한다', async () => {
    seedInput();
    const [k1, e1] = entryFor(URL_A, `${STEM}.md`);
    const [k2, e2] = entryFor(URL_B, `${STEM}.md`); // 쌍둥이(2차 dedupe 산물)
    await seedLedger({ [k1]: e1, [k2]: e2 });
    const r = await removeSource({ target: `${STEM}.md`, mode: 'recollect_ok' });
    expect(r.ok).toBe(true);
    const ledger = await loadLedger(p().ledgerFile);
    expect(ledger.sources[k1]).toBeUndefined();
    expect(ledger.sources[k2]).toBeUndefined(); // 첫 매치만 지우면 재수집 영구 불능
  });

  it('#8 block — 쌍둥이 전수를 blocked + blocked_at으로 표시하고 파일은 제거한다', async () => {
    seedInput();
    const [k1, e1] = entryFor(URL_A, `${STEM}.md`);
    const [k2, e2] = entryFor(URL_B, `${STEM}.md`);
    await seedLedger({ [k1]: e1, [k2]: e2 });
    const r = await removeSource({ target: `${STEM}.md`, mode: 'block' });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(p().input, `${STEM}.md`))).toBe(false);
    const ledger = await loadLedger(p().ledgerFile);
    expect(ledger.sources[k1].status).toBe(STATUS.BLOCKED);
    expect(ledger.sources[k2].status).toBe(STATUS.BLOCKED);
    expect(typeof ledger.sources[k1].blocked_at).toBe('string');
  });

  it('#9 block + 원장 미발견 — Input MD 프론트매터의 source_hash로 차단 키를 복원한다', async () => {
    seedInput(); // 원장은 비어 있다
    const r = await removeSource({ target: `${STEM}.md`, mode: 'block' });
    expect(r.ok).toBe(true);
    const ledger = await loadLedger(p().ledgerFile);
    expect(ledger.sources[webKey(URL_A).key].status).toBe(STATUS.BLOCKED);
  });

  it('#10 block + 원장 미발견 + Input MD 부재 — 조용한 성공이 아니라 명시 실패다', async () => {
    seedFiles(STEM, { generated: true }); // Input MD 없음
    const r = await removeSource({ target: `${STEM}.md`, mode: 'block' });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('차단');
    expect(fs.existsSync(path.join(p().generated, `${STEM}.kg.json`))).toBe(true); // 삭제 전 중단
  });
});

describe('URL target', () => {
  it('#11 webKey 정확 일치로 엔트리를 찾아 파일까지 제거한다', async () => {
    seedInput(); seedFiles(STEM, { generated: true });
    const [k, e] = entryFor(URL_A, `${STEM}.md`);
    await seedLedger({ [k]: e });
    const r = await removeSource({ target: 'https://EX.com/a/?utm_source=x', mode: 'recollect_ok' }); // 정규화 흡수
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(p().input, `${STEM}.md`))).toBe(false);
  });

  it('#12 리다이렉트 최종 URL 입력은 final_hash 폴백으로 잡는다', async () => {
    seedInput();
    const finalUrl = 'https://ex.com/final';
    const [k, e] = entryFor(URL_A, `${STEM}.md`, {
      final_url: webKey(finalUrl).normalized, final_hash: sha16(webKey(finalUrl).normalized),
    });
    await seedLedger({ [k]: e });
    const r = await removeSource({ target: finalUrl, mode: 'recollect_ok' });
    expect(r.ok).toBe(true);
    expect((await loadLedger(p().ledgerFile)).sources[k]).toBeUndefined();
  });

  it('#13 URL + 원장 미발견 — recollect_ok는 정직 실패, block은 webKey로 신규 차단 엔트리를 만든다', async () => {
    const miss = await removeSource({ target: 'https://ex.com/none', mode: 'recollect_ok' });
    expect(miss.ok).toBe(false);
    const blocked = await removeSource({ target: 'https://ex.com/none', mode: 'block' });
    expect(blocked.ok).toBe(true);
    const ledger = await loadLedger(p().ledgerFile);
    expect(ledger.sources[webKey('https://ex.com/none').key].status).toBe(STATUS.BLOCKED);
  });

  it('#14 failed 엔트리(file: null)는 파일 0건 제거 + 원장 처리만 한다', async () => {
    const [k, e] = entryFor(URL_A, null, { status: STATUS.FAILED, file: null });
    await seedLedger({ [k]: e });
    const r = await removeSource({ target: URL_A, mode: 'recollect_ok' });
    expect(r.ok).toBe(true);
    expect(r.removed).toHaveLength(0);
    expect((await loadLedger(p().ledgerFile)).sources[k]).toBeUndefined();
  });
});

describe('재빌드·부분 실패·안내', () => {
  it('#15 Reviewed 제거분이 있을 때만 자동 재빌드를 부른다', async () => {
    let called = 0;
    const rebuildImpl = async () => { called += 1; return { ok: true, nodes: 0, relationships: 0, buildId: 'b' }; };
    seedInput(); seedFiles(STEM, { generated: true });
    const [k, e] = entryFor(URL_A, `${STEM}.md`);
    await seedLedger({ [k]: e });
    await removeSource({ target: `${STEM}.md`, mode: 'recollect_ok', rebuildImpl });
    expect(called).toBe(0); // Generated만 — 재빌드 불요

    seedInput(); seedFiles(STEM, { generated: false, reviewed: true });
    await seedLedger({ [k]: e });
    const r = await removeSource({ target: `${STEM}.md`, mode: 'recollect_ok', rebuildImpl });
    expect(called).toBe(1);
    expect(r.rebuild.done).toBe(true);
  });

  it('#16 부분 실패 — 실패 전수 보고 + **원장은 건드리지 않는다** + 재실행이 곧 복구다', async () => {
    seedInput();
    // Generated 자리에 같은 이름의 **디렉터리**를 놓아 unlink를 실패시킨다
    fs.mkdirSync(path.join(p().generated, `${STEM}.kg.json`));
    const [k, e] = entryFor(URL_A, `${STEM}.md`);
    await seedLedger({ [k]: e });
    const r1 = await removeSource({ target: `${STEM}.md`, mode: 'recollect_ok' });
    expect(r1.ok).toBe(false);
    expect(r1.failed).toHaveLength(1);
    expect(r1.removed.length).toBeGreaterThan(0); // Input은 지워졌음을 정직 보고
    expect((await loadLedger(p().ledgerFile)).sources[k]).toBeDefined(); // 원장 불변
    // 장애물 제거 후 재실행 = 복구 (실존분만 지우므로 멱등)
    fs.rmdirSync(path.join(p().generated, `${STEM}.kg.json`));
    fs.writeFileSync(path.join(p().generated, `${STEM}.kg.json`), '{}', 'utf8');
    const r2 = await removeSource({ target: `${STEM}.md`, mode: 'recollect_ok' });
    expect(r2.ok).toBe(true);
    expect((await loadLedger(p().ledgerFile)).sources[k]).toBeUndefined();
  });

  it('#17 사전(정본 엔티티·속성 승자)이 비어있지 않으면 점검 안내를 동봉한다 (§2.3.2 한계 ③)', async () => {
    fs.writeFileSync(p().schemaFile, JSON.stringify({
      schema_version: 1, node_labels: [], core_relationships: [], extended_relationships: [],
      canonical_entities: [{ canonical: { label: 'X', name: 'y' }, variants: [] }],
    }), 'utf8');
    seedInput();
    const [k, e] = entryFor(URL_A, `${STEM}.md`);
    await seedLedger({ [k]: e });
    const r = await removeSource({ target: `${STEM}.md`, mode: 'recollect_ok' });
    expect(r.notes.join(' ')).toMatch(/사전/);
  });

  it('#18 이미 없는 대상 재실행 — removed 0건의 멱등 성공(파일명 + 원장 무엔트리)', async () => {
    const r = await removeSource({ target: `${STEM}.md`, mode: 'recollect_ok' });
    expect(r.ok).toBe(true);
    expect(r.removed).toHaveLength(0);
  });
});
