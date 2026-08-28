// Windows 네이티브 spawn 래퍼 (TECH-SPEC §1.4·§1.13-1).
// npm 설치 CLI(codex, claude)는 .cmd 심으로 깔리며, Node 보안 패치(CVE-2024-27980)
// 이후 .cmd 직접 spawn은 EINVAL로 실패한다. `cmd /c` 래퍼로 감싸되
// `shell: true`는 쓰지 않는다(인자 이스케이프가 셸 해석에 노출됨).
// 주의: cmd /c 경유 시 CLI 부재는 ENOENT가 아니라 종료 코드 9009("not recognized")로
// 나타난다 — not_installed 분류는 9009도 함께 본다 (전문가 패널 실측).
import { spawn } from 'node:child_process';

/**
 * 플랫폼 중립 spawn — Windows에서는 cmd /c로 감싼다. 인자는 배열 그대로 유지.
 * 프롬프트 등 본문은 절대 argv로 넘기지 않는다(cmd 8,191자 한계) — stdin 파이프 사용.
 * @param {string} bin 실행 파일 이름 (예: "codex", "claude")
 * @param {string[]} [args]
 * @param {import('node:child_process').SpawnOptions} [options]
 * @returns {import('node:child_process').ChildProcess}
 */
export function winSpawn(bin, args = [], options = {}) {
  const opts = { stdio: ['pipe', 'pipe', 'pipe'], ...options };
  if (process.platform === 'win32') {
    return spawn('cmd', ['/c', bin, ...args], opts);
  }
  return spawn(bin, args, opts);
}

/** cmd /c 경유 시 "명령을 찾을 수 없음"의 종료 코드 (Windows). */
export const WIN_NOT_FOUND_EXIT_CODE = 9009;
