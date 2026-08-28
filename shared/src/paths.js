// 저장소 루트·데이터 폴더 경로의 단일 정의 (TECH-SPEC §1.6·§1.10).
// 기준은 cwd가 아니라 이 모듈 파일의 위치다 — MCP 서버는 챗 클라이언트가
// 임의의 cwd에서 기동하므로 cwd 기반 경로는 반드시 깨진다.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

/** 저장소 루트 절대경로 (이 파일 = <repo>/shared/src/paths.js 기준). */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** 커밋되는 초기 스키마 시드 (TECH-SPEC §2.1.2). */
export const SCHEMA_DEFAULT_FILE = fileURLToPath(new URL('../schema/schema.default.json', import.meta.url));

/** KG 생성 프롬프트 템플릿 (TECH-SPEC §2.1.5). */
export const PROMPT_TEMPLATE_FILE = fileURLToPath(new URL('../prompts/kg-generation.md', import.meta.url));

/**
 * KG_DATA_DIR 해석 — 상대 경로는 저장소 루트 기준 (TECH-SPEC §1.9).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} 데이터 루트 절대경로
 */
export function resolveDataDir(env = process.env) {
  const raw = env.KG_DATA_DIR || './data';
  return path.isAbsolute(raw) ? raw : path.resolve(REPO_ROOT, raw);
}

/**
 * 데이터 루트 하위의 전체 경로 상수 묶음 (TECH-SPEC §1.6·§2.4.1).
 * tmp/(엔진 임시 입출력)와 .tmp/(원자 쓰기 스테이징)는 별개 폴더다 — 둘 다 존재해야 한다.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function dataPaths(env = process.env) {
  const root = resolveDataDir(env);
  return {
    root,
    input: path.join(root, 'Input'),
    generated: path.join(root, 'Generated'),
    reviewed: path.join(root, 'Reviewed'),
    rejected: path.join(root, 'Rejected'),
    runtime: path.join(root, 'runtime'),
    tmp: path.join(root, 'tmp'),
    staging: path.join(root, '.tmp'),
    ocrCache: path.join(root, 'ocr-cache'),
    ledgerFile: path.join(root, 'ledger.json'),
    schemaFile: path.join(root, 'schema.json'),
    lastSearchesFile: path.join(root, 'runtime', 'last-searches.json'),
    lockFile: path.join(root, '.lock'),
  };
}

/**
 * 데이터 폴더 전체를 생성한다(없을 때만 — 멱등). 클론 직후에도 오류가 없도록
 * 모든 진입점이 사용 전에 호출할 수 있다 (TECH-SPEC §1.6).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {ReturnType<typeof dataPaths>}
 */
export function ensureDataDirs(env = process.env) {
  const p = dataPaths(env);
  for (const dir of [p.root, p.input, p.generated, p.reviewed, p.rejected, p.runtime, p.tmp, p.staging, p.ocrCache]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return p;
}
