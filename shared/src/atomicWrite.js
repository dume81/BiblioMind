// 원자적 쓰기 (TECH-SPEC §2.5-1) — 스테이징 후 rename.
//
// 규칙: 모든 산출물 쓰기는 data/.tmp/ 에 완전히 쓴 뒤 fs.rename으로 목적지에 옮긴다.
// 같은 볼륨 내 rename은 NTFS에서 원자적이므로 목적 폴더에는 "완전히 써진 파일"만 나타난다.
// 중간에 프로세스가 죽어도 반쪽 파일이 조회 대상에 들어가지 않는다.

import fs from 'node:fs/promises';
import path from 'node:path';
import { dataPaths } from './paths.js';

/**
 * 텍스트를 원자적으로 쓴다.
 * @param {string} destFile 최종 경로(절대)
 * @param {string} content
 * @returns {Promise<void>}
 */
export async function atomicWriteFile(destFile, content) {
  const { staging } = dataPaths();
  await fs.mkdir(staging, { recursive: true });
  await fs.mkdir(path.dirname(destFile), { recursive: true });
  // 같은 목적 파일에 동시에 쓰는 두 작업이 서로의 스테이징을 덮지 않도록 유일한 이름을 쓴다.
  const stage = path.join(staging, `${path.basename(destFile)}.${process.pid}.${counter()}.staging`);
  await fs.writeFile(stage, content, 'utf8');
  try {
    await fs.rename(stage, destFile);
  } catch (err) {
    await fs.rm(stage, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * JSON을 원자적으로 쓴다(2칸 들여쓰기 + 끝 개행 — 사람이 열어 보는 파일).
 * @param {string} destFile
 * @param {unknown} value
 * @returns {Promise<void>}
 */
export async function atomicWriteJson(destFile, value) {
  await atomicWriteFile(destFile, `${JSON.stringify(value, null, 2)}\n`);
}

let seq = 0;
/** 프로세스 내 단조 증가 — Date.now()만으로는 같은 밀리초 충돌이 가능하다. */
function counter() {
  seq += 1;
  return seq;
}
