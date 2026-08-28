// 루트 .env 자체 로더 (TECH-SPEC §1.10) — dotenv 의존성 없음.
// 탐색 기준은 cwd가 아니라 모듈 파일 위치(paths.js의 REPO_ROOT).
// 우선순위: 이미 설정된 process.env > 루트 .env. 값은 어떤 로그에도 출력하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './paths.js';

const LINE_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/**
 * KEY=VALUE 한 줄의 값 부분을 정리한다.
 * 따옴표("…" 또는 '…')로 감싼 값은 그대로 보존하고,
 * 따옴표 없는 값은 공백 뒤 `#` 이후(인라인 주석)를 제거한다 —
 * 값에 ` #`를 쓰려면 따옴표로 감싼다.
 * @param {string} raw
 * @returns {string}
 */
function parseValue(raw) {
  const trimmed = raw.trim();
  const quoted = trimmed.match(/^"(.*)"$/) || trimmed.match(/^'(.*)'$/);
  if (quoted) return quoted[1];
  return trimmed.replace(/\s+#.*$/, '').trim();
}

/**
 * 루트 .env를 process.env로 로드한다. 이미 설정된 키는 덮어쓰지 않는다.
 * 파일이 없으면 조용히 넘어간다(스캐폴딩·클론 직후 정상 상태).
 * @param {{ envPath?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ loaded: boolean, keys: number }} 로드 여부와 신규 반영 키 수 (값은 반환·로깅 금지)
 */
export function loadEnv({ envPath = path.join(REPO_ROOT, '.env'), env = process.env } = {}) {
  let text;
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch {
    return { loaded: false, keys: 0 };
  }
  let keys = 0;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(LINE_RE);
    if (!m) continue;
    const [, key, rawValue] = m;
    if (env[key] !== undefined) continue;
    env[key] = parseValue(rawValue);
    keys += 1;
  }
  return { loaded: true, keys };
}
