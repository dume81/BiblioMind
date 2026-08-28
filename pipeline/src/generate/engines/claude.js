// Claude 엔진 어댑터 (TECH-SPEC §1.4 — 플래그 세트는 2026-08-22 슬라이스 1.5에서 실측 확정).
//
// 확정 명령: claude -p --output-format json
//   - 프롬프트는 stdin, cwd는 빈 작업 폴더
//   - 결과는 stdout JSON 봉투의 `result` 필드, 실패는 `is_error`로 판별
//   - `--max-turns`는 **이 CLI에 존재하지 않는다**(실측). 그 플래그 없이도 봉투의
//     num_turns가 1로 확인돼 목적이 이미 충족된다.
//   - 도구 차단은 헤드리스(`-p`) 기본 차단으로 충분 — 실측 부작용 0건.

import { runCli, classifyFailure, RATE_LIMIT_RE } from './run.js';

export const ENGINE_NAME = 'claude';

/**
 * @param {object} req
 * @param {string} req.prompt
 * @param {number} req.timeoutMs
 * @param {string} req.cwd
 * @param {string} [req.model]
 * @param {Function} [req.spawnImpl] 테스트 주입용
 * @returns {Promise<{ok:true,text:string}|{ok:false,kind:string,summary:string}>}
 */
export async function run(req) {
  const args = ['-p', '--output-format', 'json'];
  if (req.model) args.push('--model', req.model);

  const r = await runCli({
    bin: 'claude', args, input: req.prompt, cwd: req.cwd,
    timeoutMs: req.timeoutMs, spawnImpl: req.spawnImpl,
  });
  const failure = classifyFailure(r);
  if (failure) return { ok: false, ...failure };

  let envelope = null;
  try {
    envelope = JSON.parse(r.stdout);
  } catch {
    // 봉투가 아니면 원문을 그대로 넘긴다 — 파싱 판정은 오케스트레이터가 한다.
    return String(r.stdout).trim()
      ? { ok: true, text: r.stdout }
      : { ok: false, kind: 'bad_output', summary: '엔진이 빈 응답을 돌려주었습니다.' };
  }
  if (envelope?.is_error === true) {
    const why = String(envelope.result ?? '').slice(0, 200);
    // 봉투가 **명시적으로 오류라고 말할 때만** 그 본문을 신호로 읽는다 — 이때의 result는
    // 모델의 자유 생성물이 아니라 오류 메시지다(2026-08-22 오탐 수리와 짝을 이루는 예외).
    if (RATE_LIMIT_RE.test(why)) {
      return { ok: false, kind: 'rate_limit', summary: `엔진 사용량 한도에 걸렸습니다 — ${why}` };
    }
    return { ok: false, kind: 'crash', summary: `엔진이 오류를 보고했습니다${why ? ` — ${why}` : ''}` };
  }
  const text = String(envelope?.result ?? '');
  if (!text.trim()) {
    return { ok: false, kind: 'bad_output', summary: '엔진이 빈 응답을 돌려주었습니다.' };
  }
  return { ok: true, text };
}
