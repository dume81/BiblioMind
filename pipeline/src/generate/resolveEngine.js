// 시작 엔진 선택 — "명령 인자 > .env > 내장 기본" (TECH-SPEC §1.4).
// 한도 소진 시의 전환(failover)은 이 함수가 아니라 오케스트레이터가 지배한다.

const VALID = ['codex', 'claude'];

/**
 * @param {string | undefined | null} toolArg 도구 인자로 받은 엔진 이름
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ ok: true, engine: 'codex'|'claude' } | { ok: false, summary: string }}
 */
export function resolveEngine(toolArg, env = process.env) {
  const v = toolArg ?? env.KG_ENGINE ?? 'codex';
  if (!VALID.includes(v)) return { ok: false, summary: `엔진 값 "${v}" 인식 불가 (codex|claude)` };
  return { ok: true, engine: v };
}

/**
 * 한도 전환 대상 — 반대쪽 엔진.
 * @param {'codex'|'claude'} engine
 * @returns {'codex'|'claude'}
 */
export function otherEngine(engine) {
  return engine === 'codex' ? 'claude' : 'codex';
}

export const VALID_ENGINES = VALID;
