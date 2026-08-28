// Neo4j 특수 값을 JSON-safe 값으로 재귀 변환한다.
// neo4j-driver 인스턴스에 의존하지 않고 구조적으로 판별해 단위 테스트가 가능하다.

const MAX_DEPTH = 32;

function isNeo4jInteger(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.toNumber === 'function' &&
    typeof value.inSafeRange === 'function' &&
    typeof value.toString === 'function'
  );
}

function isNeo4jPoint(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    value.srid !== undefined &&
    value.x !== undefined &&
    value.y !== undefined &&
    typeof value.toNumber !== 'function'
  );
}

// Date, Time, DateTime, LocalDateTime, LocalTime, Duration 등 temporal 타입 판별.
function isNeo4jTemporal(value) {
  if (value === null || typeof value !== 'object') return false;
  const hasDateFields = value.year !== undefined && value.month !== undefined && value.day !== undefined;
  const hasTimeFields = value.hour !== undefined && value.minute !== undefined && value.second !== undefined;
  const hasDurationFields = value.months !== undefined && value.days !== undefined && value.seconds !== undefined;
  return hasDateFields || hasTimeFields || hasDurationFields;
}

export function toJsonSafe(value, depth = 0) {
  if (depth > MAX_DEPTH) return null;

  if (value === null || value === undefined) return null;

  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') return Number.isFinite(value) ? value : String(value);
  if (type === 'bigint') return value.toString(10);

  if (isNeo4jInteger(value)) {
    // 안전 범위 Integer → number, 초과 → 10진 문자열 (정밀도 손실 방지).
    return value.inSafeRange() ? value.toNumber() : value.toString(10);
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJsonSafe(item, depth + 1));
  }

  if (value instanceof Date) return value.toISOString();

  if (isNeo4jTemporal(value)) return String(value);

  if (isNeo4jPoint(value)) {
    const point = {
      srid: toJsonSafe(value.srid, depth + 1),
      x: toJsonSafe(value.x, depth + 1),
      y: toJsonSafe(value.y, depth + 1),
    };
    if (value.z !== undefined && !Number.isNaN(value.z)) {
      point.z = toJsonSafe(value.z, depth + 1);
    }
    return point;
  }

  if (type === 'object') {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = toJsonSafe(entry, depth + 1);
    }
    return result;
  }

  // 함수 등 직렬화 불가능한 값은 제외한다.
  return null;
}

export function propertiesToJsonSafe(properties) {
  const safe = toJsonSafe(properties || {});
  return safe && typeof safe === 'object' && !Array.isArray(safe) ? safe : {};
}
