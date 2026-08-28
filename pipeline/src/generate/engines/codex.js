// Codex 엔진 어댑터 (TECH-SPEC §1.4 — 플래그 세트는 2026-08-22 슬라이스 1.5에서 실측 확정).
//
// 확정 명령: codex exec --skip-git-repo-check -s read-only -C <cwd> -o <출력파일> -
//   - 프롬프트는 stdin(`-`)
//   - 결과는 `-o` 파일에서 읽는다(stdout 인코딩 이슈 회피)
//   - `--output-schema`는 **미채택** — structured output이 모든 object에
//     additionalProperties:false를 요구해 KG의 자유 속성 객체와 구조적으로 비호환이다.

import fs from 'node:fs/promises';
import path from 'node:path';
import { runCli, classifyFailure } from './run.js';

export const ENGINE_NAME = 'codex';

/**
 * @param {object} req
 * @param {string} req.prompt
 * @param {number} req.timeoutMs
 * @param {string} req.cwd 빈 작업 폴더(data/tmp) — 저장소 루트면 CLAUDE.md/AGENTS.md가 주입돼 프롬프트가 오염된다
 * @param {string} [req.model]
 * @param {Function} [req.spawnImpl] 테스트 주입용
 * @param {string} [req.outFile] 테스트 주입용(기본은 cwd 안의 고정 이름)
 * @returns {Promise<{ok:true,text:string}|{ok:false,kind:string,summary:string}>}
 */
export async function run(req) {
  const outFile = req.outFile ?? path.join(req.cwd, 'codex-last-message.txt');
  await fs.rm(outFile, { force: true });

  const args = ['exec', '--skip-git-repo-check', '-s', 'read-only', '-C', req.cwd, '-o', outFile];
  if (req.model) args.push('-m', req.model);
  args.push('-');

  const r = await runCli({
    bin: 'codex', args, input: req.prompt, cwd: req.cwd,
    timeoutMs: req.timeoutMs, spawnImpl: req.spawnImpl,
  });
  const failure = classifyFailure(r);
  if (failure) return { ok: false, ...failure };

  let text = '';
  try {
    text = await fs.readFile(outFile, 'utf8');
  } catch {
    text = r.stdout; // -o 파일이 없으면 stdout 폴백
  }
  if (!String(text).trim()) {
    return { ok: false, kind: 'bad_output', summary: '엔진이 빈 응답을 돌려주었습니다.' };
  }
  return { ok: true, text };
}
