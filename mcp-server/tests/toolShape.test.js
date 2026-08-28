// **도구 반환 형식 회귀 가드** — 등록된 모든 도구의 핸들러 반환을 SDK 자신의 스키마로 검증한다.
//
// 왜 이 파일이 생겼나(2026-08-23 실사고): `kg_generate`가 `{content:[...]}`가 아니라 **문자열**을
// 돌려주고 있었다. 챗에서 부르면 매번 JSON-RPC 오류 -32602("Invalid tools/call result: expected
// object, received string")로 끝났고, 도구는 **단 한 번도 동작한 적이 없었다.**
// 기존 검증이 못 잡은 이유는 둘 다 표면만 봤기 때문이다 —
//   · `npm run mcp:smoke` = `tools/list`만 호출(등록 목록은 정상이었다)
//   · 단위 테스트 = 도메인 함수(generateKg)만 호출(도구 핸들러를 안 지났다)
// 그래서 여기서는 **모든 도구의 핸들러를 실제로 부르고** 반환을 SDK 스키마에 통과시킨다.
// 내가 손으로 쓴 형식 단언이 아니라 클라이언트가 실제로 쓰는 그 스키마여야 의미가 있다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-toolshape-'));
process.env.KG_DATA_DIR = ROOT;
// 개발 허브(8787)를 건드리지 않는다 — 시험이 이사님 화면의 하이라이트를 지우면 안 된다.
process.env.VIZ_SERVER_URL = 'http://127.0.0.1:59099';
// **실 Aura 차단**(v2.12) — kg_status는 인자가 없어 "없는 것을 가리키는 인자"로 조기 탈출을
// 만들 수 없다. 빈 URI는 unconfigured 분기로 즉시 반환되며, 그 분기 자체가 §4.3-15의
// 정상 산출(연결 상태 보고)이다. loadEnv는 기설정 키를 덮지 않는다.
process.env.NEO4J_URI = '';

const { registerKgStatus } = await import('../src/tools/kgStatus.js');
const { registerSourceRemove } = await import('../src/tools/sourceRemove.js');
const { registerSchemaTools } = await import('../src/tools/schema.js');
const { registerKgGenerate } = await import('../src/tools/kgGenerate.js');
const { registerReviewTools } = await import('../src/tools/review.js');
const { registerKgSearch } = await import('../src/tools/kgSearch.js');
const { registerKgCite } = await import('../src/tools/kgCite.js');
const { registerHighlightClear } = await import('../src/tools/highlightClear.js');
const { registerKgRebuild } = await import('../src/tools/kgRebuild.js');
const { registerCollectWeb } = await import('../src/tools/collectWeb.js');
const { registerCollectDocs } = await import('../src/tools/collectDocs.js');

function fakeServer() {
  const tools = new Map();
  return { tools, registerTool(name, definition, handler) { tools.set(name, { definition, handler }); } };
}

/**
 * 각 도구를 **부작용 없이** 부를 수 있는 인자.
 * 전부 "없는 것을 가리키는" 값이라 실엔진·Neo4j·실파일을 건드리지 않는다.
 */
const SAFE_ARGS = {
  kg_status: {},
  // URL 파싱이 원장·네트워크 접촉 **전에** 실패한다 — robots.txt 요청조차 나가지 않는다.
  collect_web: { url: 'not-a-url' },
  // 상대경로는 절대경로 강제(§4.3-2 v2.13)가 파일시스템 접촉 **전에** 거부한다 —
  // 테스트 프로세스의 cwd 상태와 무관하게 결정적이다.
  collect_docs: { path: 'no_such_doc.pdf' },
  // **정상 경로**를 지나게 한다. 격리 폴더에 schema.json은 있고 Input/은 비어 있으므로
  // generateKg가 "대상 0건"으로 정상 반환한다 — 엔진 호출 0회.
  // (초판은 schema.json을 안 깔아 catch 분기만 지났고, 그래서 고의 회귀가 살아남았다.
  //  실패 분기만 밟는 시험은 "통과"라고 말하면서 정작 고장난 길은 안 밟는다.)
  kg_generate: {},
  review_list: {},
  review_show: { file: 'no_such_p01.kg.json' },
  review_approve: { file: 'no_such_p01.kg.json' },
  review_reject: { file: 'no_such_p01.kg.json' },
  kg_search: { keywords: [] }, // 빈 키워드 = 재호출 안내로 조기 반환(Neo4j 미접속)
  kg_cite: {}, // 검색 기록 없음 = 조기 반환
  highlight_clear: {}, // 죽은 포트로 푸시 — vizClient 무-throw 계약
  // **kg_rebuild는 잠금이 걸린 상태로 부른다**(beforeAll에서 건다).
  // 잠금 분기는 DB에 손대기 전에 반환하므로 이 시험이 실제 Aura를 지우는 사고가 원천 차단된다.
  // 성공 분기는 여기서 덮을 수 없다(실 DB가 필요하다) — `npm run rebuild:e2e`가 그 몫이다.
  kg_rebuild: {},
  // 격리 폴더에 대상이 없다 — removed 0건의 멱등 성공 경로(원장·파일 무접촉).
  source_remove: { target: 'no_such_p01.md', mode: 'recollect_ok' },
  schema_get: {},
  schema_update: {}, // 인자 없음 = 실변경 0 = "변경 없음" 정상 반환(버전 불변)
};

let server;

beforeAll(async () => {
  const { ensureDataDirs, dataPaths, SCHEMA_DEFAULT_FILE } = await import('@bibliomind/shared/paths');
  ensureDataDirs();
  fs.copyFileSync(SCHEMA_DEFAULT_FILE, dataPaths().schemaFile);
  // 재빌드 잠금을 걸어 둔다 — kg_rebuild가 **DB에 접속하기 전에** 거절로 반환하게 만드는 안전핀.
  // 이것이 없으면 이 시험 파일이 이사님의 실제 그래프를 지운다.
  fs.writeFileSync(dataPaths().lockFile,
    JSON.stringify({ pid: process.pid, holder: 'toolShape-guard', at: 'test' }), 'utf8');

  server = fakeServer();
  registerKgStatus(server);
  registerCollectWeb(server);
  registerCollectDocs(server);
  registerKgGenerate(server);
  registerReviewTools(server);
  registerKgSearch(server);
  registerKgCite(server);
  registerHighlightClear(server);
  registerKgRebuild(server);
  registerSourceRemove(server);
  registerSchemaTools(server);
});

afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

describe('도구 등록 표면', () => {
  it('#1 index.js가 등록하는 15종이 전부 있다 (슬라이스 8.5 — 수집 도구 합류로 설계 15종 완성)', () => {
    expect([...server.tools.keys()].sort()).toEqual([
      'collect_docs', 'collect_web',
      'highlight_clear', 'kg_cite', 'kg_generate', 'kg_rebuild', 'kg_search', 'kg_status',
      'review_approve', 'review_list', 'review_reject', 'review_show',
      'schema_get', 'schema_update', 'source_remove',
    ]);
  });

  it('#2 모든 도구가 어노테이션 4종을 정직하게 단다 (§4.4.3 — 승인 UI가 위험도를 옳게 표시하도록)', () => {
    for (const [name, { definition }] of server.tools) {
      const a = definition.annotations;
      expect(a, name).toBeDefined();
      for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        expect(typeof a[key], `${name}.${key}`).toBe('boolean');
      }
    }
  });

  it('#3 인자 없는 도구는 inputSchema를 선언하지 않는다 (저장소 철칙)', () => {
    for (const name of ['kg_status', 'review_list', 'highlight_clear', 'kg_rebuild', 'schema_get']) {
      expect(server.tools.get(name).definition.inputSchema, name).toBeUndefined();
    }
  });

  it('#3-c 수집 도구 어노테이션 정직 — collect_web만 openWorld, collect_docs는 로컬 전용(§1.5)', () => {
    expect(server.tools.get('collect_web').definition.annotations.openWorldHint).toBe(true);
    expect(server.tools.get('collect_docs').definition.annotations.openWorldHint).toBe(false);
    for (const name of ['collect_web', 'collect_docs']) {
      const a = server.tools.get(name).definition.annotations;
      expect(a.readOnlyHint, name).toBe(false); // Input/·원장을 쓴다
      expect(a.destructiveHint, name).toBe(false); // 수집은 추가 전용 — 제거는 source_remove의 몫
      expect(a.idempotentHint, name).toBe(true); // 재실행 = 기수집 스킵·이어서 수집(§2.4.4)
    }
  });

  it('#3-b 파괴적 도구의 어노테이션 정직 선언 — source_remove·schema_update는 destructive다 (v2.12)', () => {
    expect(server.tools.get('source_remove').definition.annotations.destructiveHint).toBe(true);
    // SDK 1차 출처: destructiveHint false = "additive-only". remove·set_instructions는 additive가 아니다.
    expect(server.tools.get('schema_update').definition.annotations.destructiveHint).toBe(true);
    expect(server.tools.get('schema_get').definition.annotations.readOnlyHint).toBe(true);
  });
});

describe('**핸들러 반환은 SDK 스키마를 통과해야 한다** — 실사고 회귀', () => {
  for (const name of Object.keys(SAFE_ARGS)) {
    it(`#4-${name} CallToolResultSchema 통과`, async () => {
      const { handler } = server.tools.get(name);
      const result = await handler(SAFE_ARGS[name]);
      // SDK가 클라이언트에 내보내기 전에 거는 그 검증을 그대로 건다.
      expect(() => CallToolResultSchema.parse(result), name).not.toThrow();
      expect(typeof result.content[0].text, name).toBe('string');
    });
  }

  it('#5 첫 콘텐츠는 §4.1 요약 형식이고 **도구 이름이 실제로 박혀 있다**', async () => {
    // kg_generate의 결함에는 `tool` 인자 누락도 있었다 — 요약 첫 줄이 "undefined 결과"였다.
    for (const [name, { handler }] of server.tools) {
      const result = await handler(SAFE_ARGS[name]);
      const first = result.content[0].text;
      expect(first, name).toMatch(new RegExp(`^\\[bibliomind\\] ${name} 결과 — 상태: (성공|부분 성공|실패)`));
      expect(first, name).toContain('위 요약을 사용자에게 그대로 전달하세요.');
    }
  });

  it('#6 kg_generate의 **실패 분기**도 같은 형식을 지킨다 — 알 수 없는 엔진', async () => {
    // 정상 분기(#4·#5)와 실패 분기는 반환문이 다르다. 둘 다 밟아야 형식 가드가 성립한다.
    const r = await server.tools.get('kg_generate').handler({ engine: 'gemma' });
    expect(() => CallToolResultSchema.parse(r)).not.toThrow();
    expect(r.content[0].text).toMatch(/^\[bibliomind\] kg_generate 결과 — 상태: 실패/);
    expect(r.content[0].text).toContain('gemma');
  });

  it('#7 실패 경로도 throw가 아니라 요약으로 환원된다 (실패 보고 원칙)', async () => {
    const r = await server.tools.get('review_approve').handler({ file: '../탈출.kg.json' });
    expect(() => CallToolResultSchema.parse(r)).not.toThrow();
    expect(r.content[0].text).toContain('상태: 실패');
    expect(r.content[0].text).toContain('파일명이어야');
  });
});
