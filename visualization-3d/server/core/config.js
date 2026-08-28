// Neo4j 연결 정보는 서버 전용 환경 변수로만 읽는다.
// 어떤 값도 클라이언트로 전달하지 않으며, VITE_ 접두사를 사용하지 않는다.
export function readNeo4jConfig(env = process.env) {
  return {
    enabled: env.NEO4J_SOURCE_ENABLED === 'true',
    uri: env.NEO4J_URI || '',
    username: env.NEO4J_USERNAME || '',
    password: env.NEO4J_PASSWORD || '',
    database: env.NEO4J_DATABASE || 'neo4j',
  };
}

export function isConfigured(config) {
  return Boolean(config.uri && config.username && config.password);
}
