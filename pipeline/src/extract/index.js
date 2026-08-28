// S2 문서 추출기 — 로컬 전용 (TECH-SPEC §1.5·§2.4.3).
//
// 철칙: **본문은 이 기계를 벗어나지 않는다.** PDF는 `unpdf`(pdf.js 엔진, 순수 JS),
// 이미지는 `tesseract.js`(WASM) — 둘 다 로컬 실행이며 추출 중 네트워크 요청이 없다.
// 유일한 외부 통신은 **언어팩 최초 1회 다운로드**이고, 그 뒤로는 `data/ocr-cache/`에서 읽는다.
//
// 베스트에포트(PRD S2): 추출 결과가 비어도 **파일은 만든다.** 대신 품질을 프론트매터
// `extraction_quality`(ok | low | empty)에 적어 다음 단계가 판단할 수 있게 한다.
// 원장 키는 **원본 파일 내용 해시** — 같은 파일을 다시 넣으면 멱등 스킵된다(§2.4.4).

import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';

import { dataPaths, ensureDataDirs } from '@bibliomind/shared/paths';
import { sanitizeWindowsName, buildStem } from '@bibliomind/shared/naming';
import { atomicWriteFile } from '@bibliomind/shared/atomicWrite';
import { isoKst } from '@bibliomind/shared/datetime';
import { loadLedger, saveLedger, getEntry, upsertEntry, shouldSkip, contentKey, STATUS } from '../ledger.js';

/** `low` 판정 경계 — 이 글자 수 **미만**이면 low(§1.5의 "임계 길이", 구현 중 확정분). */
export const LOW_QUALITY_CHARS = 200;

const PDF_EXT = new Set(['.pdf']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff']);

/**
 * 확장자로 자료 종류를 판정한다.
 * @param {string} file
 * @returns {'pdf' | 'image' | null}
 */
export function sourceTypeOf(file) {
  const ext = path.extname(String(file)).toLowerCase();
  if (PDF_EXT.has(ext)) return 'pdf';
  if (IMAGE_EXT.has(ext)) return 'image';
  return null;
}

/**
 * 추출 품질 판정 (§1.5 — 세 값뿐이고 어느 경우든 파일은 만든다).
 * @param {string} text
 * @returns {'ok' | 'low' | 'empty'}
 */
export function judgeQuality(text) {
  const n = String(text ?? '').trim().length;
  if (n === 0) return 'empty';
  return n < LOW_QUALITY_CHARS ? 'low' : 'ok';
}

/** yyyymmddhhmmss (로컬 시각). */
function batchStamp(now) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
    + `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/**
 * PDF 텍스트 레이어 추출 — 로컬(`unpdf`).
 * @param {Buffer} buf
 * @returns {Promise<string>}
 */
async function extractPdf(buf) {
  const { extractText } = await import('unpdf');
  const { text } = await extractText(new Uint8Array(buf), { mergePages: true });
  return Array.isArray(text) ? text.join('\n') : String(text ?? '');
}

/**
 * 이미지 OCR — 로컬(`tesseract.js` WASM, kor+eng).
 * 언어팩은 `data/ocr-cache/`에 캐시된다(최초 1회만 네트워크).
 * @param {string} file
 * @param {string} cacheDir
 * @returns {Promise<string>}
 */
async function extractImage(file, cacheDir) {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('kor+eng', undefined, {
    cachePath: cacheDir,
    logger: () => {}, // stdout은 MCP JSON-RPC 전용 — 진행률을 찍지 않는다
  });
  try {
    const { data } = await worker.recognize(file);
    return String(data?.text ?? '');
  } finally {
    await worker.terminate();
  }
}

/**
 * S2 문서 추출 — 파일 1건을 Input/*.md 로 만든다.
 *
 * 이름과 인자 키(`path`)는 **스캐폴딩이 선언한 계약을 그대로 따른다** — 기존 스모크
 * 테스트를 고치지 않기 위함이다(저장소 관행: 기존 테스트 무수정 통과).
 * 모듈이 `node:path`를 쓰므로 구조 분해에서 `filePath`로 받아 가린을 피한다.
 *
 * @param {object} options
 * @param {string} options.path 원본 파일 절대·상대 경로
 * @param {boolean} [options.force] 기추출분도 다시 추출해 **기존 파일명에 덮어쓴다**(§2.4.4)
 * @param {Date} [options.now]
 * @returns {Promise<object>} 결과 요약
 */
export async function collectDocs(options) {
  const { path: filePath, force = false, now = new Date() } = options ?? {};
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new Error('path가 필요합니다 (예: C:\\자료\\보고서.pdf).');
  }
  const abs = path.resolve(filePath);
  const kind = sourceTypeOf(abs);
  if (!kind) {
    throw new Error(
      `지원하지 않는 확장자입니다: ${path.extname(abs) || '(없음)'}`
      + ` — PDF는 ${[...PDF_EXT].join('·')}, 이미지는 ${[...IMAGE_EXT].join('·')}만 처리합니다.`,
    );
  }

  let buf;
  try {
    buf = await fs.readFile(abs);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`파일이 없습니다: ${abs}`);
    throw err;
  }

  ensureDataDirs();
  const paths = dataPaths();
  const ledger = await loadLedger();
  const batch = batchStamp(now);
  const stampedAt = isoKst(now);

  // 원장 키 = **원본 파일 내용** 해시(§2.4.4) — 같은 파일이면 경로가 달라도 같은 키다.
  const key = contentKey(buf.toString('latin1'));
  const existing = getEntry(ledger, key);
  const verdict = shouldSkip(existing, { force });
  if (verdict.skip) {
    return {
      file: abs, kind, key, skipped: true, reason: verdict.reason,
      outFile: existing?.file ?? null, quality: null, chars: 0, batch,
    };
  }

  const originalTitle = path.basename(abs, path.extname(abs));
  let text = '';
  let extractor = kind === 'pdf' ? 'unpdf' : 'tesseract.js';
  let error = null;
  try {
    text = kind === 'pdf' ? await extractPdf(buf) : await extractImage(abs, paths.ocrCache);
  } catch (err) {
    // 베스트에포트 — 추출이 실패해도 파일은 만들고 품질을 empty로 남긴다(PRD S2).
    error = err.message;
    text = '';
  }
  const quality = judgeQuality(text);

  // --force 재추출은 **기존 파일명을 유지**한다(stem 연쇄 보존, §2.4.4).
  const fileName = existing?.file
    ?? `${buildStem(batch, sanitizeWindowsName(originalTitle), 1)}.md`;
  const body = matter.stringify(text.trim(), {
    source_type: kind,
    original_file: abs,
    source_hash: key,
    title: originalTitle,
    collected_at: stampedAt,
    batch,
    extraction_quality: quality,
    extractor,
  });
  await atomicWriteFile(path.join(paths.input, fileName), body);

  upsertEntry(ledger, key, {
    kind,
    source: abs,
    final_url: null,
    final_hash: key,
    status: STATUS.COLLECTED,
    file: fileName,
    title: originalTitle,
    batch,
    attempts: (existing?.attempts ?? 0) + 1,
    last_error: error,
    collected_at: stampedAt,
    last_attempt_at: stampedAt,
  });
  await saveLedger(ledger);

  return {
    file: abs, kind, key, skipped: false, reason: null,
    outFile: fileName, overwritten: Boolean(existing?.file),
    quality, chars: text.trim().length, extractor, error, batch,
  };
}

/**
 * S2 배치 진입점 — `path`가 파일이면 1건, 폴더면 지원 확장자 전부를 이름순으로 추출한다
 * (§4.3-2: "PDF/이미지 파일 또는 폴더"). 한 파일의 실패가 배치를 죽이지 않는다 — 실패
 * 항목으로 남기고 계속한다(실패 보고 원칙: 성공/저품질/실패 목록 반환).
 * @param {object} options
 * @param {string} options.path 파일 또는 폴더 경로
 * @param {boolean} [options.force]
 * @param {Date} [options.now]
 * @param {Function} [options.extractOne] 주입용(기본 collectDocs)
 * @returns {Promise<{target: string, kind: 'file'|'dir', results: object[], unsupported: string[], counts: object}>}
 */
export async function collectDocsBatch(options) {
  const { path: targetPath, force = false, now = new Date(), extractOne = collectDocs } = options ?? {};
  if (typeof targetPath !== 'string' || targetPath.trim() === '') {
    throw new Error('path가 필요합니다 (예: C:\\자료\\보고서.pdf 또는 C:\\자료 폴더).');
  }
  // MCP 서버의 cwd는 클라이언트 스폰 위치라 예측 불가 — 상대경로를 조용히 해석하지 않는다(§4.3-2 v2.13).
  if (!path.isAbsolute(targetPath.trim())) {
    throw new Error(`절대경로가 필요합니다: ${targetPath} (예: C:\\자료\\보고서.pdf)`);
  }
  const abs = path.resolve(targetPath);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`경로가 없습니다: ${abs}`);
    throw err;
  }

  let files;
  let unsupported = [];
  let kind;
  if (stat.isFile()) {
    kind = 'file';
    files = [abs];
  } else {
    kind = 'dir';
    // 파일만 대상 — 지원 확장자로 위장한 폴더(EISDIR)와 하위 폴더를 목록에서부터 배제한다(v2.13).
    const names = (await fs.readdir(abs, { withFileTypes: true }))
      .filter((e) => e.isFile()).map((e) => e.name).sort();
    unsupported = names.filter((n) => !sourceTypeOf(n));
    files = names.filter((n) => sourceTypeOf(n)).map((n) => path.join(abs, n));
    if (files.length === 0) {
      throw new Error(
        `폴더에 지원 파일이 없습니다: ${abs}`
        + ` — PDF는 ${[...PDF_EXT].join('·')}, 이미지는 ${[...IMAGE_EXT].join('·')}만 처리합니다.`,
      );
    }
  }

  const results = [];
  for (const file of files) {
    try {
      results.push(await extractOne({ path: file, force, now }));
    } catch (err) {
      results.push({ file, kind: sourceTypeOf(file), failed: true, error: err.message, outFile: null, quality: null, chars: 0 });
    }
  }

  const counts = {
    total: results.length,
    extracted: results.filter((r) => !r.skipped && !r.failed).length,
    skipped: results.filter((r) => r.skipped).length,
    low: results.filter((r) => r.quality === 'low').length,
    empty: results.filter((r) => r.quality === 'empty').length,
    failed: results.filter((r) => r.failed).length,
  };
  return { target: abs, kind, results, unsupported, counts };
}

/** 결과 요약을 사람이 읽는 여러 줄 텍스트로. */
export function formatExtractSummary(r) {
  if (r.skipped) {
    return `이미 추출된 파일입니다 (${r.reason}) — ${r.outFile ?? '기록만 존재'}.`
      + ' 다시 추출하려면 --force를 쓰세요.';
  }
  const lines = [
    `추출 완료 — ${r.kind === 'pdf' ? 'PDF 텍스트 레이어' : '이미지 OCR'}(${r.extractor}),`
    + ` 글자 ${r.chars}자 · 품질 ${r.quality} → ${r.outFile}${r.overwritten ? ' (덮어씀)' : ''}`,
  ];
  if (r.quality === 'empty') {
    lines.push('본문이 비어 있습니다 — 텍스트 레이어가 없는 스캔본이거나 추출이 실패했습니다.'
      + ' 파일은 만들었으니 이미지로 다시 넣으면 OCR 경로로 처리됩니다.');
  } else if (r.quality === 'low') {
    lines.push(`글자 수가 ${LOW_QUALITY_CHARS}자 미만이라 품질을 low로 표시했습니다 — 그래프 생성 결과가 빈약할 수 있습니다.`);
  }
  if (r.error) lines.push(`추출 중 오류: ${r.error}`);
  lines.push('본문은 이 기계를 벗어나지 않았습니다 (S2 로컬 전용).');
  return lines.join('\n');
}
