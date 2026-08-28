// Neo4j 오류를 일반화된 코드로 변환한다.
// 원시 오류 메시지·URI·계정·Cypher는 절대 응답에 포함하지 않는다.

export const ERROR_CODES = {
  NEO4J_DISABLED: { status: 503, code: 'NEO4J_DISABLED' },
  NEO4J_NOT_CONFIGURED: { status: 503, code: 'NEO4J_NOT_CONFIGURED' },
  METHOD_NOT_ALLOWED: { status: 405, code: 'METHOD_NOT_ALLOWED' },
  INVALID_REQUEST: { status: 400, code: 'INVALID_REQUEST' },
  INVALID_PRESET: { status: 400, code: 'INVALID_PRESET' },
  AUTH_FAILED: { status: 502, code: 'AUTH_FAILED' },
  NETWORK_ERROR: { status: 502, code: 'NETWORK_ERROR' },
  TIMEOUT: { status: 504, code: 'TIMEOUT' },
  INTERNAL_ERROR: { status: 500, code: 'INTERNAL_ERROR' },
};

export function classifyNeo4jError(err) {
  const code = err?.code || '';
  const name = err?.name || '';

  if (code === 'Neo.ClientError.Security.Unauthorized' || code === 'Neo.ClientError.Security.AuthenticationRateLimit') {
    return ERROR_CODES.AUTH_FAILED;
  }
  if (
    code === 'ServiceUnavailable' ||
    code === 'SessionExpired' ||
    name === 'Neo4jError' && /connection|routing|ECONNREFUSED|ENOTFOUND|certificate|TLS/i.test(err?.message || '')
  ) {
    return ERROR_CODES.NETWORK_ERROR;
  }
  if (
    code === 'Neo.ClientError.Transaction.TransactionTimedOut' ||
    code === 'Neo.ClientError.Transaction.TransactionTimedOutClientConfiguration' ||
    /timeout|timed out/i.test(err?.message || '')
  ) {
    return ERROR_CODES.TIMEOUT;
  }
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT/i.test(err?.message || '')) {
    return ERROR_CODES.NETWORK_ERROR;
  }
  return ERROR_CODES.INTERNAL_ERROR;
}

export function errorBody(entry) {
  return { error: { code: entry.code } };
}
