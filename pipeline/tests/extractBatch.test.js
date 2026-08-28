// S2 배치 진입점 — collectDocsBatch (TECH-SPEC §4.3-2: path는 "파일 또는 폴더").
// 실제 추출(unpdf·tesseract)은 슬라이스 4가 검증했다 — 여기서는 이 함수의 신규 몫인
// 열거·정렬·필터·오류 격리·집계만 extractOne 주입으로 시험한다(collectWeb의 fetchPage 주입 관행).
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { collectDocsBatch } from '../src/extract/index.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-extract-batch-'));
const DIR = path.join(ROOT, '자료');
fs.mkdirSync(DIR);
for (const name of ['b.pdf', 'a.png', 'c.txt', '확장자없음']) {
  fs.writeFileSync(path.join(DIR, name), 'x');
}
// 함정 2종: 지원 확장자로 위장한 폴더(EISDIR 유발원)와 이름만 있는 하위 폴더 —
// 둘 다 처리 대상에서도, 비지원 목록에서도 빠져야 한다(파일만 대상 — §4.3-2 v2.13).
fs.mkdirSync(path.join(DIR, '폴더로된.pdf'));
fs.mkdirSync(path.join(DIR, '그냥폴더'));
const EMPTY_DIR = path.join(ROOT, '빈폴더');
fs.mkdirSync(EMPTY_DIR);
fs.writeFileSync(path.join(EMPTY_DIR, '지원안함.docx'), 'x');

afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

/** 호출 기록용 가짜 추출기 — 실 WASM·원장 무접촉. */
function fakeExtractor(perFile = {}) {
  const calls = [];
  const extractOne = async ({ path: p, force, now }) => {
    calls.push({ path: p, force, now });
    const stub = perFile[path.basename(p)];
    if (stub instanceof Error) throw stub;
    return stub ?? { file: p, skipped: false, outFile: `${path.basename(p)}.md`, quality: 'ok', chars: 500 };
  };
  return { calls, extractOne };
}

describe('collectDocsBatch — 파일/폴더 분기', () => {
  it('#1 파일 경로면 그 파일 1건만 추출기에 넘긴다', async () => {
    const { calls, extractOne } = fakeExtractor();
    const r = await collectDocsBatch({ path: path.join(DIR, 'b.pdf'), extractOne });
    expect(r.kind).toBe('file');
    expect(calls.map((c) => path.basename(c.path))).toEqual(['b.pdf']);
    expect(r.results).toHaveLength(1);
  });

  it('#2 폴더면 지원 확장자 **파일**만 이름순으로 전부 — 폴더는 제외, 비지원 파일은 목록으로 알린다', async () => {
    const { calls, extractOne } = fakeExtractor();
    const r = await collectDocsBatch({ path: DIR, extractOne });
    expect(r.kind).toBe('dir');
    expect(calls.map((c) => path.basename(c.path))).toEqual(['a.png', 'b.pdf']);
    expect(r.unsupported).toEqual(['c.txt', '확장자없음']);
  });

  it('#3 지원 파일이 하나도 없는 폴더는 확장자 안내와 함께 거부한다', async () => {
    const { extractOne } = fakeExtractor();
    await expect(collectDocsBatch({ path: EMPTY_DIR, extractOne }))
      .rejects.toThrow(/지원 파일이 없습니다/);
  });

  it('#4 없는 경로는 명확히 거부한다', async () => {
    const { extractOne } = fakeExtractor();
    await expect(collectDocsBatch({ path: path.join(ROOT, '없는곳'), extractOne }))
      .rejects.toThrow(/경로가 없습니다/);
  });

  it('#4-b 상대경로는 거부한다 — MCP 서버의 cwd는 예측 불가(§4.3-2 v2.13)', async () => {
    const { calls, extractOne } = fakeExtractor();
    await expect(collectDocsBatch({ path: '상대/경로.pdf', extractOne }))
      .rejects.toThrow(/절대경로/);
    expect(calls).toHaveLength(0); // 파일시스템 접촉 전에 거부된다
  });

  it('#5 한 파일의 예외가 배치를 죽이지 않는다 — 실패 항목으로 남고 다음 파일은 계속', async () => {
    const { calls, extractOne } = fakeExtractor({ 'a.png': new Error('읽기 실패') });
    const r = await collectDocsBatch({ path: DIR, extractOne });
    expect(calls).toHaveLength(2); // a.png 실패 후에도 b.pdf 진행
    expect(r.results[0]).toMatchObject({ failed: true, error: '읽기 실패' });
    expect(r.results[1].outFile).toBe('b.pdf.md');
    expect(r.counts.failed).toBe(1);
  });

  it('#6 force·now가 파일마다 그대로 전달된다', async () => {
    const { calls, extractOne } = fakeExtractor();
    const now = new Date('2026-08-27T12:00:00+09:00');
    await collectDocsBatch({ path: DIR, force: true, now, extractOne });
    for (const c of calls) {
      expect(c.force).toBe(true);
      expect(c.now).toBe(now);
    }
  });

  it('#7 집계 — extracted/skipped/low/empty/failed를 센다', async () => {
    const { extractOne } = fakeExtractor({
      'a.png': { file: 'a', skipped: true, reason: '기수집', outFile: 'a.md', quality: null, chars: 0 },
      'b.pdf': { file: 'b', skipped: false, outFile: 'b.md', quality: 'low', chars: 10 },
    });
    const r = await collectDocsBatch({ path: DIR, extractOne });
    expect(r.counts).toEqual({ total: 2, extracted: 1, skipped: 1, low: 1, empty: 0, failed: 0 });
  });
});
