// 재빌드 상호 배제 잠금 (TECH-SPEC §2.5-6).
// 함정은 둘이다: ① 살아 있는 주인을 죽었다고 보면 남의 재빌드에 끼어든다
// ② 죽은 주인의 잠금을 못 걷어내면 한 번 크래시한 뒤 영영 재빌드를 못 한다.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-lock-'));
process.env.KG_DATA_DIR = ROOT;

const { acquireLock, releaseLock, readLock, isLocked, isProcessAlive } = await import('../src/lock.js');
const { dataPaths, ensureDataDirs } = await import('@bibliomind/shared/paths');

/** 이 시스템에 존재할 수 없는 PID — 죽은 주인을 흉내낸다. */
const DEAD_PID = 0x7ffffffe;

function writeLockFile(entry) {
  fs.writeFileSync(dataPaths().lockFile, JSON.stringify(entry), 'utf8');
}

beforeEach(() => {
  ensureDataDirs();
  releaseLock();
});

afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

describe('isProcessAlive', () => {
  it('#1 자기 자신은 살아 있다', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('#2 없는 PID·잘못된 값은 죽은 것으로 본다', () => {
    expect(isProcessAlive(DEAD_PID)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(undefined)).toBe(false);
  });
});

describe('acquireLock', () => {
  it('#3 빈 상태에서 얻고, 파일에 PID·시각·주인을 남긴다', () => {
    const lock = acquireLock({ holder: 'kg_rebuild' });
    expect(lock.ok).toBe(true);
    const written = readLock(dataPaths().lockFile);
    expect(written.pid).toBe(process.pid);
    expect(written.holder).toBe('kg_rebuild');
    expect(written.at).toMatch(/\+09:00$/);
    lock.release();
  });

  it('#4 **살아 있는 주인이 잡고 있으면 실패한다** — 기다리지 않는다', () => {
    writeLockFile({ pid: process.pid, holder: 'other-chat', at: 'now' });
    const lock = acquireLock();
    expect(lock.ok).toBe(false);
    expect(lock.holder.holder).toBe('other-chat');
  });

  it('#5 **죽은 주인의 잠금은 걷어내고 진행한다** — 크래시 후 영구 차단 방지', () => {
    writeLockFile({ pid: DEAD_PID, holder: 'crashed', at: 'yesterday' });
    const lock = acquireLock();
    expect(lock.ok).toBe(true);
    expect(lock.tookOver.holder).toBe('crashed'); // 걷어냈다는 사실을 보고한다
    lock.release();
  });

  it('#6 손상된 잠금 파일도 stale로 보고 걷어낸다', () => {
    fs.writeFileSync(dataPaths().lockFile, '{ 깨짐', 'utf8');
    const lock = acquireLock();
    expect(lock.ok).toBe(true);
    lock.release();
  });

  it('#7 release 후에는 다시 얻을 수 있다', () => {
    const first = acquireLock();
    expect(first.ok).toBe(true);
    first.release();
    expect(fs.existsSync(dataPaths().lockFile)).toBe(false);
    const second = acquireLock();
    expect(second.ok).toBe(true);
    second.release();
  });
});

describe('isLocked — 검색 도구의 "재빌드 진행 중" 표시용 (§4.3-12)', () => {
  it('#8 없으면 false, 살아 있는 주인이 있으면 true', () => {
    expect(isLocked()).toBe(false);
    const lock = acquireLock();
    expect(isLocked()).toBe(true);
    lock.release();
  });

  it('#9 죽은 주인의 잔여 잠금은 "잠김"으로 보고하지 않는다', () => {
    writeLockFile({ pid: DEAD_PID, holder: 'crashed', at: 'yesterday' });
    expect(isLocked()).toBe(false);
  });
});
