#!/usr/bin/env node
// 수동 실행·디버그용 CLI — MCP 우회 수단 (TECH-SPEC §1.8).
// 도구(kg_rebuild)와 **같은 도메인 함수**를 부른다 — 두 경로가 다르게 동작하면 디버그 수단이 아니다.
import { rebuildGraph, formatRebuildSummary } from '../src/inject/index.js';
import { classifyNeo4jError, closeDriver } from '../../shared/src/neo4jClient.js';

try {
  const result = await rebuildGraph();
  console.log(formatRebuildSummary(result));
  process.exitCode = result.ok && result.verified?.match !== false ? 0 : 1;
} catch (err) {
  const { hint } = classifyNeo4jError(err);
  console.error(`[bibliomind] kg_rebuild 실패: ${err.message}\n${hint}`);
  process.exitCode = 1;
} finally {
  // 드라이버를 닫지 않으면 열린 소켓 때문에 프로세스가 끝나지 않는다(2026-08-23 실측).
  // MCP 서버는 장수 프로세스라 드라이버를 열어 두는 것이 맞지만, CLI는 끝나야 한다.
  await closeDriver();
}
