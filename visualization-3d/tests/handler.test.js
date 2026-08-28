import { describe, expect, it } from 'vitest';
import { handleGraphRequest } from '../server/core/handler.js';

// 실제 Neo4j 없이 handler를 검증하기 위한 mock driver.
// 자격증명 값은 모두 명백한 가짜 placeholder다.
const MOCK_ENV = {
  NEO4J_SOURCE_ENABLED: 'true',
  NEO4J_URI: 'bolt://mock-host:7687',
  NEO4J_USERNAME: 'mock-user',
  NEO4J_PASSWORD: 'mock-password',
  NEO4J_DATABASE: 'mockdb',
};

function makeMockDriver({ nodes = [], relationships = [], failWith = null } = {}) {
  const state = {
    sessionClosed: false,
    sessionOptions: null,
    runCalls: [],
  };

  const session = {
    executeRead: async (work, txConfig) => {
      if (failWith) throw failWith;
      const tx = {
        run: async (query, params) => {
          state.runCalls.push({ query, params, txConfig });
          const isNodeQuery = state.runCalls.length === 1;
          const items = isNodeQuery ? nodes : relationships;
          return { records: items.map((item) => ({ get: () => item })) };
        },
      };
      return work(tx);
    },
    close: async () => {
      state.sessionClosed = true;
    },
  };

  const driver = {
    session: (options) => {
      state.sessionOptions = options;
      return session;
    },
  };

  const driverFactory = async () => ({ driver, int: (v) => v });
  return { driverFactory, state };
}

function rawNode(elementId, labels = ['Person'], properties = {}) {
  return { elementId, labels, properties };
}

function rawRel(elementId, startId, endId) {
  return { elementId, type: 'KNOWS', startNodeElementId: startId, endNodeElementId: endId, properties: {} };
}

describe('GET /api/graph (상태 조회)', () => {
  it('활성·설정 여부와 preset 목록만 반환하고 비밀값은 노출하지 않는다', async () => {
    const result = await handleGraphRequest({ method: 'GET', env: MOCK_ENV });
    expect(result.status).toBe(200);
    expect(result.body.enabled).toBe(true);
    expect(result.body.configured).toBe(true);
    expect(result.body.presets.length).toBeGreaterThan(0);
    expect(result.body.limits.maxNodeLimit).toBe(1000);

    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain('mock-host');
    expect(serialized).not.toContain('mock-user');
    expect(serialized).not.toContain('mock-password');
    expect(serialized).not.toContain('MATCH');
  });

  it('환경 변수가 없으면 비활성으로 보고한다', async () => {
    const result = await handleGraphRequest({ method: 'GET', env: {} });
    expect(result.body.enabled).toBe(false);
    expect(result.body.configured).toBe(false);
  });
});

describe('POST /api/graph 접근 제어', () => {
  it('Neo4j 모드 비활성 시 503 NEO4J_DISABLED', async () => {
    const result = await handleGraphRequest({
      method: 'POST',
      body: { presetId: 'overview' },
      env: { ...MOCK_ENV, NEO4J_SOURCE_ENABLED: 'false' },
    });
    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe('NEO4J_DISABLED');
  });

  it('환경 변수 누락 시 503 NEO4J_NOT_CONFIGURED', async () => {
    const result = await handleGraphRequest({
      method: 'POST',
      body: { presetId: 'overview' },
      env: { NEO4J_SOURCE_ENABLED: 'true' },
    });
    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe('NEO4J_NOT_CONFIGURED');
  });

  it('허용되지 않은 method는 405', async () => {
    const result = await handleGraphRequest({ method: 'DELETE', env: MOCK_ENV });
    expect(result.status).toBe(405);
    expect(result.body.error.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('잘못된 body는 400 INVALID_REQUEST', async () => {
    for (const badBody of [null, undefined, 'text', [1, 2]]) {
      const result = await handleGraphRequest({ method: 'POST', body: badBody, env: MOCK_ENV });
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe('INVALID_REQUEST');
    }
  });

  it('임의 Cypher·URI·자격증명 등 허용되지 않은 키는 400으로 거부한다', async () => {
    for (const extraKey of ['cypher', 'query', 'uri', 'username', 'password', 'call']) {
      const result = await handleGraphRequest({
        method: 'POST',
        body: { presetId: 'overview', [extraKey]: 'MATCH (n) DETACH DELETE n' },
        env: MOCK_ENV,
      });
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe('INVALID_REQUEST');
    }
  });

  it('허용되지 않은 preset은 400 INVALID_PRESET', async () => {
    const result = await handleGraphRequest({
      method: 'POST',
      body: { presetId: 'anything-else' },
      env: MOCK_ENV,
    });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('INVALID_PRESET');
  });

  it('prototype 키를 preset으로 악용할 수 없다', async () => {
    const result = await handleGraphRequest({
      method: 'POST',
      body: { presetId: 'toString' },
      env: MOCK_ENV,
    });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('INVALID_PRESET');
  });

  it('숫자가 아닌 limit은 400', async () => {
    const result = await handleGraphRequest({
      method: 'POST',
      body: { presetId: 'overview', nodeLimit: 'abc' },
      env: MOCK_ENV,
    });
    expect(result.status).toBe(400);
  });
});

describe('POST /api/graph 성공 경로', () => {
  it('Canonical Graph와 meta만 반환한다', async () => {
    const { driverFactory, state } = makeMockDriver({
      nodes: [rawNode('n1'), rawNode('n2')],
      relationships: [rawRel('r1', 'n1', 'n2')],
    });
    const result = await handleGraphRequest({
      method: 'POST',
      body: { presetId: 'overview' },
      env: MOCK_ENV,
      driverFactory,
    });

    expect(result.status).toBe(200);
    expect(Object.keys(result.body).sort()).toEqual(['meta', 'nodes', 'relationships']);
    expect(result.body.meta).toEqual({ source: 'neo4j', truncated: false, nodeCount: 2, relationshipCount: 1 });
    expect(result.headers['Cache-Control']).toBe('no-store');

    // 응답에 드라이버·세션·query·접속 정보가 없어야 한다.
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain('MATCH');
    expect(serialized).not.toContain('mock-password');
    expect(serialized).not.toContain('bolt://');

    // 명시적 database + 읽기 전용 세션 + 세션 종료.
    expect(state.sessionOptions).toEqual({ database: 'mockdb', defaultAccessMode: 'READ' });
    expect(state.sessionClosed).toBe(true);
    // 트랜잭션 timeout 설정.
    expect(state.runCalls[0].txConfig).toEqual({ timeout: 15000 });
  });

  it('과도한 limit은 서버에서 상한으로 clamp된다', async () => {
    const { driverFactory, state } = makeMockDriver({ nodes: [rawNode('n1')] });
    await handleGraphRequest({
      method: 'POST',
      body: { presetId: 'overview', nodeLimit: 999999, relationshipLimit: 999999 },
      env: MOCK_ENV,
      driverFactory,
    });
    expect(state.runCalls[0].params.nodeLimit).toBe(1000);
    expect(state.runCalls[1].params.relationshipLimit).toBe(2000);
  });

  it('빈 데이터베이스는 nodeCount 0으로 반환한다', async () => {
    const { driverFactory } = makeMockDriver({ nodes: [], relationships: [] });
    const result = await handleGraphRequest({
      method: 'POST',
      body: { presetId: 'overview' },
      env: MOCK_ENV,
      driverFactory,
    });
    expect(result.status).toBe(200);
    expect(result.body.meta.nodeCount).toBe(0);
  });

  it('고립 노드와 dangling 관계 제외를 처리한다', async () => {
    const { driverFactory } = makeMockDriver({
      nodes: [rawNode('n1'), rawNode('isolated')],
      relationships: [rawRel('r1', 'n1', 'not-included')],
    });
    const result = await handleGraphRequest({
      method: 'POST',
      body: { presetId: 'overview' },
      env: MOCK_ENV,
      driverFactory,
    });
    expect(result.body.meta.nodeCount).toBe(2);
    expect(result.body.meta.relationshipCount).toBe(0);
    expect(result.body.meta.truncated).toBe(true);
  });
});

describe('POST /api/graph 오류 처리', () => {
  async function expectErrorCode(failWith, expectedCode, expectedStatus) {
    const { driverFactory, state } = makeMockDriver({ failWith });
    const result = await handleGraphRequest({
      method: 'POST',
      body: { presetId: 'overview' },
      env: MOCK_ENV,
      driverFactory,
    });
    expect(result.status).toBe(expectedStatus);
    expect(result.body).toEqual({ error: { code: expectedCode } });
    // 오류 시에도 세션은 닫힌다.
    expect(state.sessionClosed).toBe(true);
    return result;
  }

  it('인증 실패 → AUTH_FAILED', async () => {
    const err = new Error('The client is unauthorized due to authentication failure.');
    err.code = 'Neo.ClientError.Security.Unauthorized';
    await expectErrorCode(err, 'AUTH_FAILED', 502);
  });

  it('네트워크·TLS 실패 → NETWORK_ERROR', async () => {
    const err = new Error('Could not perform discovery');
    err.code = 'ServiceUnavailable';
    await expectErrorCode(err, 'NETWORK_ERROR', 502);
  });

  it('timeout → TIMEOUT', async () => {
    const err = new Error('The transaction has been terminated');
    err.code = 'Neo.ClientError.Transaction.TransactionTimedOut';
    await expectErrorCode(err, 'TIMEOUT', 504);
  });

  it('기타 오류 → INTERNAL_ERROR, 원시 오류 메시지는 노출하지 않는다', async () => {
    const err = new Error('secret internal detail: bolt://mock-host mock-password');
    const result = await expectErrorCode(err, 'INTERNAL_ERROR', 500);
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain('secret internal detail');
    expect(serialized).not.toContain('mock-password');
  });
});
