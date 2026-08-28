// 슬라이스 8 — kg_status 도메인 수집 (TECH-SPEC §4.3-15 v2.12).
// DB count는 sessionFactory 주입 — 표면 파일에 Cypher를 반입하지 않는다(패널 확정).
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-status-'));
process.env.KG_DATA_DIR = ROOT;

const { collectPipelineStatus } = await import('../src/status/index.js');
const { dataPaths, ensureDataDirs } = await import('@bibliomind/shared/paths');

function p() { return dataPaths(); }

beforeEach(() => {
  ensureDataDirs();
  for (const dir of [p().input, p().generated, p().reviewed, p().rejected]) {
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
  }
  fs.rmSync(p().ledgerFile, { force: true });
  fs.writeFileSync(p().schemaFile, JSON.stringify({
    schema_version: 3, updated_at: '2026-08-26T00:00:00+09:00',
    node_labels: [
      { label: 'Person', origin: 'seed' },
      { label: 'Product', origin: 'manual' },
      { label: 'AutoThing', origin: 'auto' },
    ],
    core_relationships: [], extended_relationships: [{ type: 'POSTED_TO', origin: 'auto' }],
    instructions_ko: [],
  }), 'utf8');
});

afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

function fakeCountSession(nodes, rels) {
  const queries = [];
  return {
    queries,
    factory: () => ({
      async run(cypher) {
        queries.push(cypher.replace(/\s+/g, ' ').trim());
        const value = /\[r\]|-\[/.test(cypher) ? rels : nodes;
        return { records: [{ get: () => ({ toInt: () => value }) }] };
      },
      async close() {},
    }),
  };
}

describe('collectPipelineStatus', () => {
  it('#1 폴더 계수·보류 목록·차단 계수를 반환한다', async () => {
    fs.writeFileSync(path.join(p().input, 'a_p01.md'), 'x', 'utf8');
    fs.writeFileSync(path.join(p().input, 'a_p02.md'), 'x', 'utf8');
    fs.writeFileSync(path.join(p().generated, 'a_p01.kg.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(p().reviewed, 'b_p01.kg.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(p().rejected, 'c_p01.kg.rej1.json'), '{}', 'utf8');
    fs.writeFileSync(p().ledgerFile, JSON.stringify({
      version: 1,
      sources: {
        k1: { file: 'a_p01.md', status: 'collected', reject_count: 3 },
        k2: { file: 'x.md', status: 'blocked', reject_count: 0 },
      },
      build: { buildId: 'B1', at: 'T', counts: { nodes: 5, relationships: 7 }, schemaUpdatedAt: 'S' },
    }), 'utf8');

    const r = await collectPipelineStatus({ sessionFactory: fakeCountSession(0, 0).factory });
    expect(r.pipeline).toMatchObject({ input: 2, generated: 1, reviewed: 1, rejected: 1, blocked: 1 });
    expect(r.pipeline.held).toEqual(['a_p01.md']);
    expect(r.build).toMatchObject({ buildId: 'B1', counts: { nodes: 5, relationships: 7 } });
  });

  it('#2 스키마 요약 — 버전·수정 시각·자동 등재 유형 목록', async () => {
    const r = await collectPipelineStatus({ sessionFactory: fakeCountSession(0, 0).factory });
    expect(r.schema).toMatchObject({ schema_version: 3, updated_at: '2026-08-26T00:00:00+09:00' });
    expect(r.schema.autoTypes).toEqual(['AutoThing', 'POSTED_TO']);
  });

  it('#3 기본 엔진은 resolveEngine 규칙(인자>env>codex)을 따른다', async () => {
    const r = await collectPipelineStatus({
      sessionFactory: fakeCountSession(0, 0).factory, env: { KG_ENGINE: 'claude' },
    });
    expect(r.engine).toBe('claude');
  });

  it('#4 DB count는 RKEntity 스코프 질의로 하고 수치를 반환한다', async () => {
    const fake = fakeCountSession(132, 207);
    const r = await collectPipelineStatus({ sessionFactory: fake.factory });
    expect(r.db).toMatchObject({ ok: true, nodes: 132, relationships: 207 });
    for (const q of fake.queries) expect(q).toContain('RKEntity'); // buildId counts와 표시 일관(v2.12)
  });

  it('#5 DB 실패는 throw가 아니라 kind·hint로 환원된다 — 부분 성공의 재료', async () => {
    const r = await collectPipelineStatus({
      sessionFactory: () => { const e = new Error('접속 정보 없음'); e.code = 'BIBLIOMIND_UNCONFIGURED'; throw e; },
    });
    expect(r.db.ok).toBe(false);
    expect(r.db.kind).toBe('unconfigured');
    expect(typeof r.db.hint).toBe('string');
  });
});
