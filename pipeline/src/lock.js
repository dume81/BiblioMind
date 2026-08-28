// 재빌드 상호 배제 잠금 — `data/.lock` (TECH-SPEC §2.5-6).
//
// 왜 이것만 잠그나: Claude·Codex 이중 등록이 권장 구성이라 MCP 서버가 2개 뜰 수 있다.
// 조회는 파일·DB를 읽기만 하므로 안전하지만, **재빌드는 "전부 삭제 후 전부 주입"이라
// 두 개가 교차하면 DB가 오염된다.** 그래서 재빌드 경로에만 잠금을 건다
// (kg_rebuild · review_reject의 내장 재빌드 · source_remove의 재빌드).
//
// 범용 파일 잠금 라이브러리는 도입하지 않는다(§1.3 의존성 최소주의) —
// 필요한 것은 `O_EXCL` 생성 한 번과 죽은 PID 판정뿐이다.

import fs from 'node:fs';
import path from 'node:path';
import { dataPaths } from '@bibliomind/shared/paths';
import { isoKst } from '@bibliomind/shared/datetime';

/**
 * 기록된 PID의 프로세스가 살아 있는지 본다.
 * `process.kill(pid, 0)`은 신호를 보내지 않고 존재만 확인하는 표준 관용구다.
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 다른 사용자의 프로세스지만 **살아 있다**. 죽었다고 보면 남의 재빌드 중에 끼어든다.
    return err.code === 'EPERM';
  }
}

/**
 * 잠금을 얻는다. 이미 잡혀 있으면 **기다리지 않고** 실패로 환원한다 —
 * 챗 도구는 몇 분씩 매달리면 안 되고, "다른 챗에서 재빌드 중"이 정상 동작이다(§4.4.3-3).
 *
 * 크래시로 남은 잠금(stale)은 기록된 PID가 죽어 있으면 자동 해제한다 —
 * 그러지 않으면 한 번 죽은 뒤 영영 재빌드를 못 하는 함정이 된다.
 *
 * @param {{ file?: string, holder?: string }} [options]
 * @returns {{ ok: true, release: () => void, tookOver: object | null } | { ok: false, holder: object }}
 */
export function acquireLock({ file, holder = 'kg_rebuild' } = {}) {
  const target = file ?? dataPaths().lockFile;
  fs.mkdirSync(path.dirname(target), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(target, 'wx'); // O_CREAT|O_EXCL — 이미 있으면 EEXIST
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, holder, at: isoKst() }, null, 2));
      fs.closeSync(fd);
      return { ok: true, release: () => releaseLock(target), tookOver: attempt > 0 ? lastStale : null };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const current = readLock(target);
      if (current && isProcessAlive(current.pid)) {
        return { ok: false, holder: current };
      }
      // 죽은 주인의 잠금 — 한 번만 걷어내고 재시도한다.
      lastStale = current;
      fs.rmSync(target, { force: true });
    }
  }
  return { ok: false, holder: readLock(target) ?? { pid: null, holder: 'unknown', at: null } };
}

let lastStale = null;

/**
 * 잠금 파일 내용을 읽는다. 손상됐으면 null — 손상된 잠금은 stale로 취급해 걷어낸다.
 * @param {string} target
 * @returns {{ pid: number, holder: string, at: string } | null}
 */
export function readLock(target) {
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return null;
  }
}

/** @param {string} [file] */
export function releaseLock(file) {
  fs.rmSync(file ?? dataPaths().lockFile, { force: true });
}

/**
 * 잠금이 걸려 있는지만 본다(검색 도구가 "재빌드 진행 중" 플래그를 붙일 때 — §4.3-12).
 * @param {string} [file]
 * @returns {boolean}
 */
export function isLocked(file) {
  const target = file ?? dataPaths().lockFile;
  if (!fs.existsSync(target)) return false;
  const current = readLock(target);
  return current ? isProcessAlive(current.pid) : false;
}
