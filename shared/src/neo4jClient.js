// Neo4j AuraDB 접속 계층 — 세션 발급 + 실패 분류(일시정지·자격증명·기타).
//
// 2026-08-23 이사: mcp-server/src/lib/에 있던 것을 shared로 옮겼다. 슬라이스 7의 주입기가
// pipeline에 생기면서 **접속·설정 코드의 두 번째 사본이 생길 자리**였기 때문이다.
// 택하지 않은 대안: pipeline이 자기 드라이버를 따로 만든다 → 접속 설정·실패 분류가 두 벌이 되어
// 한쪽만 고쳐지는 순간 "검색은 되는데 주입은 안 되는" 상태가 만들어진다. 파일에 mcp 고유 로직이
// 하나도 없어 이사 비용이 import 1줄 수정뿐이라 옮기는 쪽이 싸다.
import neo4j from 'neo4j-driver';
import { loadEnv } from './env.js';

let driver = null;

/** @returns {{ uri?: string, user: string, password?: string, database: string, configured: boolean }} */
export function neo4jConfig() {
  loadEnv();
  const { NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD } = process.env;
  const configured = Boolean(NEO4J_URI && NEO4J_PASSWORD && NEO4J_PASSWORD !== 'replace-me');
  return {
    uri: NEO4J_URI,
    user: NEO4J_USERNAME || 'neo4j',
    password: NEO4J_PASSWORD,
    database: process.env.NEO4J_DATABASE || 'neo4j',
    configured,
  };
}

/**
 * 읽기 전용 세션 — 검색 경로는 이것만 쓴다(임의 Cypher·쓰기 금지, §3.6).
 * @returns {import('neo4j-driver').Session}
 */
export function getReadSession() {
  return openSession(neo4j.session.READ);
}

/**
 * 쓰기 세션 — **재빌드 경로 전용**(§2.3.4). 검색 경로는 절대 이것을 쓰지 않는다.
 * @returns {import('neo4j-driver').Session}
 */
export function getWriteSession() {
  return openSession(neo4j.session.WRITE);
}

/** 설정 검증 + 드라이버 지연 생성 — 읽기·쓰기가 같은 드라이버를 공유한다. */
function openSession(accessMode) {
  const cfg = neo4jConfig();
  if (!cfg.configured) {
    const err = new Error('Neo4j 접속 정보가 .env에 없습니다');
    err.code = 'BIBLIOMIND_UNCONFIGURED';
    throw err;
  }
  if (!driver) {
    driver = neo4j.driver(cfg.uri, neo4j.auth.basic(cfg.user, cfg.password), {
      connectionAcquisitionTimeout: 15000,
    });
  }
  return driver.session({ database: cfg.database, defaultAccessMode: accessMode });
}

/** 테스트·종료용. */
export async function closeDriver() {
  await driver?.close().catch(() => {});
  driver = null;
}

/**
 * Aura 실패 분류 3종(총감사 확정) — MCP 타임아웃 전에 사용자 안내가 도달하게 한다.
 * @param {unknown} err
 * @returns {{ kind: 'unconfigured'|'paused'|'auth'|'other', hint: string }}
 */
export function classifyNeo4jError(err) {
  const message = String(/** @type {{message?: string}} */ (err)?.message ?? err);
  const code = /** @type {{code?: string}} */ (err)?.code ?? '';
  if (code === 'BIBLIOMIND_UNCONFIGURED') {
    return { kind: 'unconfigured', hint: 'npm run setup으로 .env의 Neo4j 항목을 확인하세요 (AuraDB 자격증명 .txt 값 그대로).' };
  }
  if (/Unauthorized|authentication/i.test(message) || /Security/.test(code)) {
    return { kind: 'auth', hint: '자격증명 불일치 — 인스턴스를 재생성했다면 새 자격증명 .txt 값으로 .env를 갱신하세요.' };
  }
  if (/ServiceUnavailable|routing|Connection was closed|Failed to connect|ECONNREFUSED|ETIMEDOUT/i.test(message + code)) {
    return { kind: 'paused', hint: 'AuraDB 무료 인스턴스가 일시정지됐을 수 있습니다 — console.neo4j.io에서 Resume 후 수 분 뒤 재시도하세요.' };
  }
  return { kind: 'other', hint: 'npm run setup으로 접속 상태를 점검하세요.' };
}
