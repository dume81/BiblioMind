import { readNeo4jConfig, isConfigured } from './config.js';
import {
  PRESETS,
  getPresetList,
  clampLimit,
  DEFAULT_NODE_LIMIT,
  MAX_NODE_LIMIT,
  DEFAULT_RELATIONSHIP_LIMIT,
  MAX_RELATIONSHIP_LIMIT,
  TRANSACTION_TIMEOUT_MS,
} from './presets.js';
import { mapToCanonicalGraph } from './mapper.js';
import { ERROR_CODES, classifyNeo4jError, errorBody } from './errors.js';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

const ALLOWED_BODY_KEYS = new Set(['presetId', 'nodeLimit', 'relationshipLimit']);

// Vercel 웜 인보케이션 간 드라이버 재사용.
let cachedDriver = null;
let cachedDriverKey = '';

async function defaultDriverFactory(config) {
  const neo4j = (await import('neo4j-driver')).default;
  const key = `${config.uri}|${config.username}|${config.database}`;
  if (!cachedDriver || cachedDriverKey !== key) {
    if (cachedDriver) {
      await cachedDriver.close().catch(() => {});
    }
    cachedDriver = neo4j.driver(config.uri, neo4j.auth.basic(config.username, config.password), {
      maxConnectionPoolSize: 5,
      connectionAcquisitionTimeout: 10000,
    });
    cachedDriverKey = key;
  }
  return { driver: cachedDriver, int: neo4j.int };
}

function validateBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: ERROR_CODES.INVALID_REQUEST };
  }
  // 허용된 키(presetId, nodeLimit, relationshipLimit) 외의 값 — 임의 Cypher,
  // URI, 자격증명, procedure 호출 등 — 은 어떤 것도 받지 않는다.
  for (const key of Object.keys(body)) {
    if (!ALLOWED_BODY_KEYS.has(key)) {
      return { error: ERROR_CODES.INVALID_REQUEST };
    }
  }
  const presetId = body.presetId;
  if (typeof presetId !== 'string' || !Object.prototype.hasOwnProperty.call(PRESETS, presetId)) {
    return { error: ERROR_CODES.INVALID_PRESET };
  }
  for (const limitKey of ['nodeLimit', 'relationshipLimit']) {
    if (body[limitKey] !== undefined && !Number.isFinite(Number(body[limitKey]))) {
      return { error: ERROR_CODES.INVALID_REQUEST };
    }
  }
  return {
    presetId,
    nodeLimit: clampLimit(body.nodeLimit, MAX_NODE_LIMIT, DEFAULT_NODE_LIMIT),
    relationshipLimit: clampLimit(body.relationshipLimit, MAX_RELATIONSHIP_LIMIT, DEFAULT_RELATIONSHIP_LIMIT),
  };
}

/**
 * /api/graph 요청 처리 (Vercel Function과 로컬 dev 서버가 공유하는 코어).
 * @param {{method: string, body?: unknown, env?: object, driverFactory?: Function}} request
 * @returns {Promise<{status: number, headers: object, body: object}>}
 */
export async function handleGraphRequest({ method, body, env = process.env, driverFactory = defaultDriverFactory }) {
  const config = readNeo4jConfig(env);

  if (method === 'GET') {
    return {
      status: 200,
      headers: NO_STORE_HEADERS,
      body: {
        enabled: config.enabled,
        configured: config.enabled && isConfigured(config),
        presets: getPresetList(),
        limits: {
          defaultNodeLimit: DEFAULT_NODE_LIMIT,
          maxNodeLimit: MAX_NODE_LIMIT,
          defaultRelationshipLimit: DEFAULT_RELATIONSHIP_LIMIT,
          maxRelationshipLimit: MAX_RELATIONSHIP_LIMIT,
        },
      },
    };
  }

  if (method !== 'POST') {
    return { status: 405, headers: NO_STORE_HEADERS, body: errorBody(ERROR_CODES.METHOD_NOT_ALLOWED) };
  }

  if (!config.enabled) {
    return { status: ERROR_CODES.NEO4J_DISABLED.status, headers: NO_STORE_HEADERS, body: errorBody(ERROR_CODES.NEO4J_DISABLED) };
  }
  if (!isConfigured(config)) {
    return { status: ERROR_CODES.NEO4J_NOT_CONFIGURED.status, headers: NO_STORE_HEADERS, body: errorBody(ERROR_CODES.NEO4J_NOT_CONFIGURED) };
  }

  const validated = validateBody(body);
  if (validated.error) {
    return { status: validated.error.status, headers: NO_STORE_HEADERS, body: errorBody(validated.error) };
  }

  const preset = PRESETS[validated.presetId];
  let session = null;
  try {
    const { driver, int } = await driverFactory(config);
    // 명시적인 database + 읽기 전용 세션.
    session = driver.session({ database: config.database, defaultAccessMode: 'READ' });

    const txConfig = { timeout: TRANSACTION_TIMEOUT_MS };
    const nodeResult = await session.executeRead(
      (tx) => tx.run(preset.nodeQuery, { nodeLimit: int(validated.nodeLimit) }),
      txConfig,
    );
    const relResult = await session.executeRead(
      (tx) => tx.run(preset.relationshipQuery, { relationshipLimit: int(validated.relationshipLimit) }),
      txConfig,
    );

    const rawNodes = nodeResult.records.map((record) => record.get(0));
    const rawRelationships = relResult.records.map((record) => record.get(0));

    const graph = mapToCanonicalGraph(rawNodes, rawRelationships, {
      nodeLimit: validated.nodeLimit,
      relationshipLimit: validated.relationshipLimit,
    });

    return { status: 200, headers: NO_STORE_HEADERS, body: graph };
  } catch (err) {
    const classified = classifyNeo4jError(err);
    return { status: classified.status, headers: NO_STORE_HEADERS, body: errorBody(classified) };
  } finally {
    // 성공·오류 모두에서 세션을 닫는다.
    if (session) {
      await session.close().catch(() => {});
    }
  }
}
