// 수집 도구 표면의 **성공 경로·요약 로직** — toolShape의 SAFE_ARGS는 실패 분기만 밟는다.
// 2026-08-23 실사고 교훈(실패 분기만 밟는 시험은 고장난 길을 안 밟는다)의 재발 방지:
// ①요약 로직을 순수 함수(summarize*)로 두고 전 분기를 시험한다 — 반박 패널이 잡은
//   robots 전면 차단 '성공' 오보·차단(blocked) 스킵의 force 거짓 안내·§4.1 5건 상한이 대상.
// ②collect_docs 핸들러의 성공 경로는 스킵(멱등)으로 실호출한다 — WASM·네트워크 0.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-collect-tools-'));
process.env.KG_DATA_DIR = ROOT;
process.env.VIZ_SERVER_URL = 'http://127.0.0.1:59099';
process.env.NEO4J_URI = '';

const { summarizeCollectWeb, registerCollectWeb } = await import('../src/tools/collectWeb.js');
const { summarizeCollectDocs, registerCollectDocs } = await import('../src/tools/collectDocs.js');
const { contentKey } = await import('@bibliomind/pipeline/ledger');

afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

function fakeServer() {
  const tools = new Map();
  return { tools, registerTool(name, definition, handler) { tools.set(name, { definition, handler }); } };
}

/** crawl 요약의 합성 최소형 — 실제 collectWeb 반환 필드(§4.3-1) 부분집합. */
function webSummary(over = {}) {
  return {
    collected: 0, skipped: 0, failed: 0, robotsBlocked: 0, duplicated: 0,
    attempted: 0, maxPages: 10, pages: [], failures: [], missingFiles: [],
    robotsNote: null, jinaKey: 'header', remainingInQueue: 0, ...over,
  };
}

describe('summarizeCollectWeb — 상태 판정(§4.3-1 v2.13)', () => {
  it('#W1 robots 전면 차단은 성공이 아니라 실패 — 재시도 권유 금지', () => {
    const r = summarizeCollectWeb(webSummary({
      robotsBlocked: 3,
      pages: [{ url: 'u1', result: 'robots-blocked' }],
      robotsNote: null,
    }));
    expect(r.status).toBe('실패');
    expect(r.next).toContain('robots');
    expect(r.next).not.toContain('자동 재시도'); // 차단은 재실행해도 그대로다
  });

  it('#W2 실패가 있어도 중복 해소가 있으면 부분 성공', () => {
    const r = summarizeCollectWeb(webSummary({
      failed: 1, duplicated: 3, failures: [{ url: 'u', reason: 'HTTP 500' }],
    }));
    expect(r.status).toBe('부분 성공');
  });

  it('#W3 전량 스킵(멱등 재실행)은 성공 — 저장 목록 없음', () => {
    const r = summarizeCollectWeb(webSummary({ skipped: 4 }));
    expect(r.status).toBe('성공');
    expect(r.lines.join('\n')).not.toContain('저장 ');
  });

  it('#W4 저장 목록은 10건 표시 + 총수, force 덮어쓰기는 (덮어씀)으로 구분 — 신규로 세지 않는다', () => {
    const pages = Array.from({ length: 11 }, (_, i) => ({ url: `u${i}`, result: 'collected', file: `p${String(i).padStart(2, '0')}.md` }));
    pages.push({ url: 'u11', result: 'overwritten', file: 'p11.md' });
    const r = summarizeCollectWeb(webSummary({ collected: 12, attempted: 12, pages }));
    const text = r.lines.join('\n');
    expect(text).toContain('저장 12건');
    expect(text).not.toContain('신규 저장'); // §4.3-1 문언 — 덮어쓰기는 신규가 아니다
    expect((text.match(/^ {2}· /gm) ?? []).length).toBe(10); // 최대 10 표시
    expect(text).toContain('외 2건');
  });

  it('#W5 실패 목록은 §4.1의 5건 상한을 지킨다', () => {
    const failures = Array.from({ length: 7 }, (_, i) => ({ url: `f${i}`, reason: 'HTTP 500' }));
    const r = summarizeCollectWeb(webSummary({ failed: 7, attempted: 7, failures }));
    const text = r.lines.join('\n');
    expect((text.match(/HTTP 500/g) ?? []).length).toBe(5);
    expect(text).toContain('나머지 2건');
  });
});

describe('summarizeCollectDocs — 스킵·차단·상한(§4.3-2 v2.13)', () => {
  const batch = (results, over = {}) => ({
    target: 'C:\\자료', kind: 'dir', results, unsupported: [],
    counts: {
      total: results.length,
      extracted: results.filter((r) => !r.skipped && !r.failed).length,
      skipped: results.filter((r) => r.skipped).length,
      low: results.filter((r) => r.quality === 'low').length,
      empty: results.filter((r) => r.quality === 'empty').length,
      failed: results.filter((r) => r.failed).length,
    },
    ...over,
  });

  it('#D1 차단(blocked) 스킵은 force를 권하지 않는다 — 해제 경로(source_remove)를 안내', () => {
    const r = summarizeCollectDocs(batch([
      { file: 'C:\\자료\\차단됨.pdf', skipped: true, reason: 'blocked', outFile: 'p01.md', quality: null, chars: 0 },
    ]));
    const text = r.lines.join('\n');
    expect(text).toContain('[차단]');
    expect(text).toContain('source_remove');
    expect(text).not.toContain('재추출은 force'); // blocked > force(§2.4.4) — 통하지 않는 조언 금지
    expect(text).not.toContain('이미 추출됨(blocked)');
  });

  it('#D2 기추출 스킵은 force 안내를 유지한다', () => {
    const r = summarizeCollectDocs(batch([
      { file: 'C:\\자료\\기추출.pdf', skipped: true, reason: 'collected', outFile: 'p02.md', quality: null, chars: 0 },
    ]));
    expect(r.lines.join('\n')).toContain('재추출은 force');
    expect(r.status).toBe('성공');
  });

  it('#D3 실패 표시는 5건 상한 — 전량 실패는 상태도 실패', () => {
    const results = Array.from({ length: 6 }, (_, i) => ({
      file: `C:\\자료\\깨진${i}.pdf`, failed: true, error: '읽기 실패', outFile: null, quality: null, chars: 0,
    }));
    const r = summarizeCollectDocs(batch(results));
    const text = r.lines.join('\n');
    expect((text.match(/읽기 실패/g) ?? []).length).toBe(5);
    expect(text).toContain('나머지 1건');
    expect(r.status).toBe('실패');
  });
});

describe('collect_docs 핸들러 성공 경로 — 스킵(멱등) 실호출', () => {
  it('#H1 기추출 파일 재투입이 §4.1 성공 요약으로 돌아온다', async () => {
    const doc = path.join(ROOT, '재투입.pdf');
    const body = 'collect-tools-h1';
    fs.writeFileSync(doc, body);
    fs.writeFileSync(path.join(ROOT, 'ledger.json'), JSON.stringify({
      version: 1,
      sources: { [contentKey(body)]: { kind: 'doc', file: 'p77.md', status: 'collected', reject_count: 0 } },
    }), 'utf8');

    const server = fakeServer();
    registerCollectDocs(server);
    const result = await server.tools.get('collect_docs').handler({ path: doc });
    expect(() => CallToolResultSchema.parse(result)).not.toThrow();
    const text = result.content[0].text;
    expect(text).toMatch(/^\[bibliomind\] collect_docs 결과 — 상태: 성공/);
    expect(text).toContain('[스킵]');
    expect(text).toContain('p77.md');
  });

  it('#H2 collect_web 핸들러의 실패 환원 — 등록·요약 형식(성공 경로 요약식은 #W군이 담당)', async () => {
    const server = fakeServer();
    registerCollectWeb(server);
    const result = await server.tools.get('collect_web').handler({ url: 'not-a-url' });
    expect(() => CallToolResultSchema.parse(result)).not.toThrow();
    expect(result.content[0].text).toMatch(/^\[bibliomind\] collect_web 결과 — 상태: 실패/);
  });
});
