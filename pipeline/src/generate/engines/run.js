// 엔진 어댑터 공용 실행부 — spawn·stdin 전달·타임아웃·실패 분류 (TECH-SPEC §1.4·§1.13).
//
// 두 어댑터(codex/claude)가 다른 것은 **argv와 결과 수취 방식**뿐이므로 그 둘만 각자 갖고,
// 나머지(프로세스 실행·본문 stdin 파이프·실패 분류)는 여기 한 곳에 둔다.
//
// 테스트는 실제 CLI 대신 **가짜 실행 스크립트**를 spawn한다(§1.12-2) — 실구독을 소모하지
// 않기 위해 `spawnImpl`을 주입 가능하게 열어 둔다.

import { winSpawn, WIN_NOT_FOUND_EXIT_CODE } from '@bibliomind/shared/winSpawn';

/**
 * 한도 소진 안내 문구 — 두 엔진의 표현을 함께 본다(대소문자 무시).
 *
 * **맨숫자 `429`를 넣지 않는다.** 2026-08-22 실사고: 자료 본문의 회사 주소
 * "서울시 동대문구 장안동 **429**-2"가 HTTP 429로 오인돼 **정상 생성이 한도 소진으로
 * 기록**됐다. HTTP 상태 코드는 반드시 `HTTP`/`status` 같은 문맥과 함께 있을 때만 센다.
 */
const RATE_LIMIT_RE = /rate[ _-]?limit|usage limit|quota exceeded|too many requests|사용량 한도|한도에 도달|(?:http|status)[^0-9]{0,10}429/i;

/**
 * CLI를 실행하고 프롬프트를 stdin으로 흘려 넣는다.
 * @param {object} req
 * @param {string} req.bin
 * @param {string[]} req.args
 * @param {string} req.input stdin으로 보낼 본문(절대 argv로 넘기지 않는다 — cmd 8,191자 한계)
 * @param {string} req.cwd
 * @param {number} req.timeoutMs
 * @param {Function} [req.spawnImpl] 테스트 주입용
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, timedOut: boolean, spawnError: Error|null }>}
 */
export function runCli({ bin, args, input, cwd, timeoutMs, spawnImpl = winSpawn }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: err });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { spawnError = err; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, spawnError });
    });

    // stdin이 이미 닫혔거나 대상이 즉시 죽으면 EPIPE가 난다 — 실행 실패로 환원하고 throw하지 않는다.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input, 'utf8');
  });
}

/**
 * 실행 결과를 실패 종류로 분류한다 (§1.4 실패 분류).
 * `bad_output`은 여기서 판정하지 않는다 — 파싱·검증 단계의 몫이다.
 * @param {{ code: number|null, stdout: string, stderr: string, timedOut: boolean, spawnError: Error|null }} r
 * @returns {{ kind: 'timeout'|'rate_limit'|'crash'|'not_installed', summary: string } | null} null = 성공
 */
export function classifyFailure(r) {
  // **모델이 쓴 자유 본문(stdout)을 시스템 신호로 읽지 않는다** (2026-08-22 실사고 수리).
  // 초판은 stdout+stderr를 함께 봤는데, stdout에는 모델이 생성한 KG JSON이 들어 있다.
  // 자료에 있던 주소 번지수 "429"가 그대로 실려 나와 한도 소진으로 오판됐고,
  // **정상 생성 1건이 실패로 기록되고 배치가 중단**됐다.
  // 한도 안내는 CLI가 stderr(또는 명시적 오류 봉투)로 낸다 — 거기서만 찾는다.
  const signal = String(r.stderr ?? '');

  // 정상 종료(0)면 결과가 나온 것이다 — 본문에 무슨 단어가 있든 한도가 아니다.
  if (r.code !== 0 && RATE_LIMIT_RE.test(signal)) {
    return { kind: 'rate_limit', summary: '엔진 사용량 한도에 걸렸습니다.' };
  }
  if (r.timedOut) {
    return { kind: 'timeout', summary: '엔진이 제한 시간 안에 응답하지 않았습니다.' };
  }
  // 비-Windows는 spawn ENOENT, Windows는 cmd /c 경유라 종료 코드 9009로 나타난다(§1.13-1).
  if (r.spawnError?.code === 'ENOENT' || r.code === WIN_NOT_FOUND_EXIT_CODE) {
    return { kind: 'not_installed', summary: 'CLI가 설치되어 있지 않습니다.' };
  }
  if (r.spawnError) {
    return { kind: 'crash', summary: `엔진 실행 실패: ${r.spawnError.message}` };
  }
  if (r.code !== 0) {
    const tail = r.stderr.trim().slice(-200) || r.stdout.trim().slice(-200);
    return { kind: 'crash', summary: `엔진이 종료 코드 ${r.code}로 끝났습니다${tail ? ` — ${tail}` : ''}` };
  }
  return null;
}

export { RATE_LIMIT_RE };
