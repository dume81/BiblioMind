#!/usr/bin/env node
// BiblioMind MCP 서버 — stdio 엔트리포인트 (TECH-SPEC §4).
// 규칙: stdout은 MCP JSON-RPC 전용이다. 모든 진단·로그는 stderr(console.error)로만 —
// stdout 오염 시 클라이언트 연결이 조용히 깨진다 (§1.13-3).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadEnv } from '@bibliomind/shared/env';
import { registerKgStatus } from './tools/kgStatus.js';
import { registerKgSearch } from './tools/kgSearch.js';
import { registerKgCite } from './tools/kgCite.js';
import { registerHighlightClear } from './tools/highlightClear.js';
import { registerKgGenerate } from './tools/kgGenerate.js';
import { registerReviewTools } from './tools/review.js';
import { registerKgRebuild } from './tools/kgRebuild.js';
import { registerSourceRemove } from './tools/sourceRemove.js';
import { registerSchemaTools } from './tools/schema.js';
import { registerCollectWeb } from './tools/collectWeb.js';
import { registerCollectDocs } from './tools/collectDocs.js';

// stdout 오염 방어선 — 실수로 남은 console.log도 stderr로 우회한다.
console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);

process.on('uncaughtException', (err) => {
  console.error('[bibliomind] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[bibliomind] unhandledRejection:', reason);
});

// .env 로드 — cwd가 아니라 저장소 루트 기준(§1.10). 값이 비어도 서버는 정상 기동하고,
// 각 도구가 실패 요약으로 안내한다(스캐폴딩 단계에서 Inspector 검증이 가능해야 함).
loadEnv();

const server = new McpServer({ name: 'bibliomind-mcp-server', version: '0.1.0' });
registerKgStatus(server);
registerCollectWeb(server); // §4.2 파이프라인 순서(S1→S2→S3)대로 등록한다
registerCollectDocs(server);
registerKgGenerate(server);
registerReviewTools(server);
registerKgRebuild(server);
registerKgSearch(server);
registerKgCite(server);
registerHighlightClear(server);
registerSourceRemove(server);
registerSchemaTools(server);
// 설계 15종 전부 등록 완료 — D4는 슬라이스 8.5로 해소(2026-08-27 오너 A안).

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[bibliomind] MCP server ready (stdio)');
}

main().catch((err) => {
  console.error('[bibliomind] fatal:', err);
  process.exit(1);
});
