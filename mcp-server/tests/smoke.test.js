// kg_status 표면 스모크 — §4.1 규약(이름·어노테이션·요약 형식) + 완성된 핸들러의 격리 실행.
// v2.12 개정: 스텁 시절 이 파일은 환경 격리 없이 핸들러를 불렀다 — kg_status가 완성되면서
// 실 data/·실 Aura를 건드리게 되므로 격리(KG_DATA_DIR·NEO4J_URI 무효화·죽은 허브 포트)를
// 추가했고, DB·허브가 죽은 환경의 정상 산출은 '성공'이 아니라 '부분 성공'이다(§4.3-15).
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-smoke-'));
process.env.KG_DATA_DIR = ROOT;
process.env.VIZ_SERVER_URL = 'http://127.0.0.1:59099';
process.env.NEO4J_URI = ''; // unconfigured 분기 — 그 자체가 연결 상태 보고의 정상 산출

const { registerKgStatus, buildSummary } = await import('../src/tools/kgStatus.js');

afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, definition, handler) {
      tools.set(name, { definition, handler });
    },
  };
}

describe('kg_status 표면', () => {
  it('이름·읽기 전용 어노테이션·한국어 설명으로 등록된다', () => {
    const server = fakeServer();
    registerKgStatus(server);
    const entry = server.tools.get('kg_status');
    expect(entry).toBeDefined();
    expect(entry.definition.annotations.readOnlyHint).toBe(true);
    expect(entry.definition.annotations.destructiveHint).toBe(false);
    expect(entry.definition.description).toContain('조회');
  });

  it('핸들러가 §4.1 요약 형식을 첫 콘텐츠로 반환한다 — DB·허브 부재 환경은 부분 성공', async () => {
    const server = fakeServer();
    registerKgStatus(server);
    const result = await server.tools.get('kg_status').handler();
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toMatch(/^\[bibliomind\] kg_status 결과 — 상태: (성공|부분 성공)/);
    expect(result.content[0].text).toContain('위 요약을 사용자에게 그대로 전달하세요.');
  });
});

describe('buildSummary', () => {
  it('실패 보고 원칙 형식', () => {
    const text = buildSummary({ tool: 'x', status: '실패', lines: ['이유'], next: '재시도' });
    expect(text.split('\n')).toEqual([
      '[bibliomind] x 결과 — 상태: 실패',
      '이유',
      '다음 행동: 재시도',
      '위 요약을 사용자에게 그대로 전달하세요.',
    ]);
  });
});
