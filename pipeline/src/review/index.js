// S4 검수 워크플로 — 대기 조회·승인·반려 (TECH-SPEC §4.3-4~7 · §2.4.1 · §2.4.2 · §2.4.4).
//
// "폴더가 곧 상태"다(§2.4.4). 승인·반려는 파일 이동(rename)이고, 원장에는 reject_count만 오간다.
// 별도 "승인 필드"나 "보류 상태값"을 두지 않는다 — `held`는 reject_count>=3의 파생 값이다.
//
// 이동은 전부 같은 볼륨 rename이므로 원자적이다(§2.5-5) — 두 폴더에 반쪽씩 남는 중간 상태가 없다.
// 새로 쓰는 파일이 아니라 이미 완성된 파일을 옮기는 것이라 스테이징(.tmp)은 쓰지 않는다.

import fs from 'node:fs/promises';
import path from 'node:path';

import { dataPaths, ensureDataDirs } from '@bibliomind/shared/paths';
import { rejectedFileName } from '@bibliomind/shared/naming';
import { normalizeCanonicalGraph } from '@bibliomind/shared/canonicalGraph';
import { isoKst } from '@bibliomind/shared/datetime';
import { loadLedger, saveLedger } from '../ledger.js';

/** Generated/·Reviewed/ 산출물의 고정 확장자 (§2.4.2). */
export const KG_SUFFIX = '.kg.json';

/** 자동 재생성을 멈추는 누적 반려 횟수 (§2.4.4 · PRD S4). */
export const HELD_THRESHOLD = 3;

/**
 * 챗 모델이 넘긴 파일명을 검사한다 — **경로가 아니라 파일명만** 받는다.
 * 인자는 LLM이 만들어 오므로 `../`나 절대경로가 섞이면 data/ 밖을 건드릴 수 있다.
 * @param {unknown} file
 * @returns {string} 검증을 통과한 파일명
 */
export function assertSafeKgFileName(file) {
  const name = String(file ?? '').trim();
  if (!name) throw new Error('file 인자가 비어 있습니다.');
  if (name !== path.basename(name) || name === '.' || name === '..') {
    throw new Error(`file은 폴더 경로가 아니라 파일명이어야 합니다: ${name}`);
  }
  if (!name.endsWith(KG_SUFFIX)) {
    throw new Error(`검수 대상은 ${KG_SUFFIX}로 끝나는 파일입니다: ${name}`);
  }
  return name;
}

/**
 * `<stem>.kg.json` → `<stem>` (§2.4.2의 stem 연쇄).
 * @param {string} file
 * @returns {string}
 */
export function stemOf(file) {
  return assertSafeKgFileName(file).slice(0, -KG_SUFFIX.length);
}

/**
 * stem → 원본 Input MD 파일명.
 * @param {string} stem
 * @returns {string}
 */
export function inputFileOf(stem) {
  return `${stem}.md`;
}

/**
 * 원장에서 Input 파일명으로 엔트리를 찾는다. 원장 키는 URL·내용 해시라 stem으로는 못 찾는다 —
 * `file` 필드가 stem 연쇄의 유일한 연결 고리다(§2.4.4).
 * @param {{sources: Record<string, object>}} ledger
 * @param {string} mdFile
 * @returns {{ key: string, entry: object } | null}
 */
export function findLedgerByInput(ledger, mdFile) {
  for (const [key, entry] of Object.entries(ledger.sources ?? {})) {
    if (entry?.file === mdFile) return { key, entry };
  }
  return null;
}

async function listDir(dir, ext) {
  try {
    return (await fs.readdir(dir)).filter((f) => f.endsWith(ext)).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * KG JSON 1건을 읽어 파싱한다. 파싱 실패는 삼키지 않는다 — 검수 목록에서 그 파일만
 * 오류로 표시해야 사용자가 손상을 알아챈다.
 * @param {string} dir
 * @param {string} file
 * @returns {Promise<object>}
 */
export async function readKgDoc(dir, file) {
  const raw = await fs.readFile(path.join(dir, file), 'utf8');
  return JSON.parse(raw);
}

/**
 * 그래프 구조 요약 — 라벨별 노드 수·유형별 관계 수 (§4.3-5 반환).
 * @param {{nodes: object[], relationships: object[]}} graph
 * @returns {{ nodeCount: number, relCount: number, byLabel: Record<string, number>, byRelType: Record<string, number> }}
 */
export function describeStructure(graph) {
  const byLabel = {};
  const byRelType = {};
  for (const n of graph.nodes ?? []) {
    const key = n.label ?? '(라벨 없음)';
    byLabel[key] = (byLabel[key] ?? 0) + 1;
  }
  for (const r of graph.relationships ?? []) {
    const key = r.type ?? '(유형 없음)';
    byRelType[key] = (byRelType[key] ?? 0) + 1;
  }
  return {
    nodeCount: (graph.nodes ?? []).length,
    relCount: (graph.relationships ?? []).length,
    byLabel,
    byRelType,
  };
}

/**
 * `review_list` — Generated/ 검수 대기 목록 (§4.3-4).
 *
 * `engine`·`newTypes`는 산출물 `meta`에서 읽는다(§2.2). meta가 없는 파일은 **null로 정직하게**
 * 보고한다 — 추측으로 채우지 않는다(meta 스탬프 도입 전 생성분).
 * @param {{ dirs?: ReturnType<typeof dataPaths> }} [options]
 * @returns {Promise<object>}
 */
export async function listReviewQueue(options = {}) {
  const paths = options.dirs ?? (ensureDataDirs(), dataPaths());
  const [pendingFiles, reviewedFiles, rejectedFiles] = await Promise.all([
    listDir(paths.generated, KG_SUFFIX),
    listDir(paths.reviewed, KG_SUFFIX),
    listDir(paths.rejected, '.json'),
  ]);
  const ledger = await loadLedger(paths.ledgerFile);

  const items = [];
  for (const file of pendingFiles) {
    const stem = file.slice(0, -KG_SUFFIX.length);
    const sourceInput = inputFileOf(stem);
    const found = findLedgerByInput(ledger, sourceInput);
    const rejectCount = Number(found?.entry?.reject_count ?? 0);
    let doc = null;
    let readError = null;
    try {
      doc = await readKgDoc(paths.generated, file);
    } catch (err) {
      readError = err.message;
    }
    items.push({
      file,
      sourceInput,
      engine: doc?.meta?.engine ?? null,
      nodeCount: doc ? (doc.nodes ?? []).length : null,
      relCount: doc ? (doc.relationships ?? []).length : null,
      newTypes: doc?.meta?.new_types ?? null,
      rejectCount,
      held: rejectCount >= HELD_THRESHOLD,
      ...(readError ? { readError } : {}),
    });
  }

  return {
    items,
    pendingCount: items.length,
    reviewedCount: reviewedFiles.length,
    rejectedCount: rejectedFiles.length,
    heldCount: items.filter((i) => i.held).length,
    metaMissingCount: items.filter((i) => i.engine === null && !i.readError).length,
  };
}

/**
 * 검수 대상 파일이 실제로 어느 폴더에 있는지 찾는다. Generated/(구조 검수)가 먼저,
 * Reviewed/(의미 검수)가 다음이다 (§4.3-7은 두 폴더를 모두 받는다).
 * @param {ReturnType<typeof dataPaths>} paths
 * @param {string} file
 * @returns {Promise<{ dir: string, from: 'Generated'|'Reviewed' } | null>}
 */
export async function locateKgFile(paths, file) {
  if (await exists(path.join(paths.generated, file))) return { dir: paths.generated, from: 'Generated' };
  if (await exists(path.join(paths.reviewed, file))) return { dir: paths.reviewed, from: 'Reviewed' };
  return null;
}

/**
 * `review_show` 용 그래프 준비 — 읽기 → canonicalGraph 정규화·검증 (§4.3-5).
 * **검증 실패 시 푸시하지 않는다** — 화면에 깨진 그래프를 올리지 않고 오류만 돌려준다.
 * @param {{ file: string, dirs?: ReturnType<typeof dataPaths> }} options
 * @returns {Promise<{ ok: true, file: string, from: string, sourceInput: string, graph: object, warnings: string[], structure: object, newTypes: object|null }
 *                  | { ok: false, file: string, errors: string[], from?: string }>}
 */
export async function prepareShow({ file, dirs }) {
  const name = assertSafeKgFileName(file);
  const paths = dirs ?? (ensureDataDirs(), dataPaths());
  const located = await locateKgFile(paths, name);
  if (!located) {
    return { ok: false, file: name, errors: [`${name} 을(를) Generated/·Reviewed/ 어느 쪽에서도 찾지 못했습니다.`] };
  }
  let doc;
  try {
    doc = await readKgDoc(located.dir, name);
  } catch (err) {
    return { ok: false, file: name, from: located.from, errors: [`파일을 읽지 못했습니다 — ${err.message}`] };
  }
  const normalized = normalizeCanonicalGraph(doc);
  if (!normalized.ok) {
    return { ok: false, file: name, from: located.from, errors: normalized.errors };
  }
  const stem = name.slice(0, -KG_SUFFIX.length);
  return {
    ok: true,
    file: name,
    from: located.from,
    sourceInput: doc?.meta?.input_file ?? inputFileOf(stem),
    graph: normalized.graph,
    warnings: normalized.warnings ?? [],
    structure: describeStructure(normalized.graph),
    newTypes: doc?.meta?.new_types ?? null,
  };
}

/**
 * `review_approve` — Generated/ → Reviewed/ 이동 + reject_count 리셋 (§4.3-6 · §2.4.4).
 *
 * 같은 stem의 기존 Reviewed/ 파일이 있으면 **덮어쓴다**(구버전 자동 대체) — 그 사실을
 * 보고해야 재주입 필요를 사용자가 안다.
 * @param {{ file: string, dirs?: ReturnType<typeof dataPaths> }} options
 * @returns {Promise<object>}
 */
export async function approveKg({ file, dirs }) {
  const name = assertSafeKgFileName(file);
  const paths = dirs ?? (ensureDataDirs(), dataPaths());
  const src = path.join(paths.generated, name);
  if (!(await exists(src))) {
    const inReviewed = await exists(path.join(paths.reviewed, name));
    return {
      ok: false,
      file: name,
      reason: inReviewed
        ? '이미 승인된 파일입니다(Reviewed/에 있습니다).'
        : 'Generated/에서 찾지 못했습니다 — review_list로 파일명을 확인하세요.',
    };
  }
  const dest = path.join(paths.reviewed, name);
  const replaced = await exists(dest);
  await fs.rename(src, dest);

  const stem = name.slice(0, -KG_SUFFIX.length);
  const sourceInput = inputFileOf(stem);
  const ledger = await loadLedger(paths.ledgerFile);
  const found = findLedgerByInput(ledger, sourceInput);
  let resetFrom = null;
  if (found) {
    resetFrom = Number(found.entry.reject_count ?? 0);
    // 리셋 규칙(§2.4.4 v2): 승인은 실패 사슬의 종결이므로 카운터를 0으로 되돌린다.
    ledger.sources[found.key] = { ...found.entry, reject_count: 0 };
    await saveLedger(ledger, paths.ledgerFile);
  }
  const remaining = (await listDir(paths.generated, KG_SUFFIX)).length;
  return { ok: true, file: name, sourceInput, replaced, resetFrom, ledgerFound: Boolean(found), remaining };
}

/**
 * `review_reject` — 반려 (§4.3-7). 순서 고정: ① Rejected/ 이동 ② (Reviewed였다면) 재빌드
 * ③ 원장 카운터 +1 ④ 자동 재생성 1회.
 *
 * **재빌드(②)는 슬라이스 7(S5 주입)에서 구현된다.** 지금은 이동만 하고 "DB에 아직 남아 있다"를
 * 명시 보고한다 — 조용히 넘어가면 사용자가 반려된 자료가 그래프에 남은 줄 모른다.
 * @param {object} options
 * @param {string} options.file
 * @param {string} [options.reason]
 * @param {boolean} [options.regenerate] 기본 true
 * @param {ReturnType<typeof dataPaths>} [options.dirs]
 * @param {Function} [options.generateImpl] 테스트 주입용 — 기본은 generateKg
 * @param {Function} [options.rebuildImpl] 테스트 주입용 — 기본은 rebuildGraph
 * @returns {Promise<object>}
 */
export async function rejectKg({ file, reason, regenerate = true, dirs, generateImpl, rebuildImpl }) {
  const name = assertSafeKgFileName(file);
  const paths = dirs ?? (ensureDataDirs(), dataPaths());
  const located = await locateKgFile(paths, name);
  if (!located) {
    return { ok: false, file: name, reason: 'Generated/·Reviewed/ 어느 쪽에서도 찾지 못했습니다 — review_list로 파일명을 확인하세요.' };
  }

  const stem = name.slice(0, -KG_SUFFIX.length);
  const sourceInput = inputFileOf(stem);
  const ledger = await loadLedger(paths.ledgerFile);
  const found = findLedgerByInput(ledger, sourceInput);
  const ledgerCount = Number(found?.entry?.reject_count ?? 0);

  // 회차 N은 원장 카운트가 정본이지만(§2.4.2), 원장이 없거나 어긋난 경우에도 기존 반려 파일을
  // 덮어쓰지 않도록 실제 파일 수와 큰 쪽을 쓴다.
  const existingRej = (await listDir(paths.rejected, '.json')).filter((f) => f.startsWith(`${stem}.kg.rej`));
  const nextCount = Math.max(ledgerCount, existingRej.length) + 1;

  // ① 이동
  const outName = rejectedFileName(stem, nextCount);
  await fs.rename(path.join(located.dir, name), path.join(paths.rejected, outName));

  // ② 재빌드 — Reviewed/에 있던 파일만 해당(§4.3-7 ②). 이 파일이 빠진 상태로 DB를 복원한다.
  // **이동(①) 다음에 하는 것이 순서상 중요하다**: 재빌드는 Reviewed/ 폴더를 읽으므로,
  // 옮기기 전에 돌리면 반려한 자료가 그대로 다시 주입된다.
  const rebuild = located.from === 'Reviewed'
    ? await runRebuildAfterReject(rebuildImpl)
    : { required: false, done: false, note: null };

  // ③ 원장 카운터 +1 (+ 사유 기록 — 재생성 지시문 개선의 재료, §4.3-7)
  if (found) {
    ledger.sources[found.key] = {
      ...found.entry,
      reject_count: nextCount,
      last_reject_reason: reason ? String(reason).slice(0, 500) : null,
      last_attempt_at: isoKst(),
    };
    await saveLedger(ledger, paths.ledgerFile);
  }

  const held = nextCount >= HELD_THRESHOLD;
  const result = {
    ok: true,
    file: name,
    from: located.from,
    movedTo: outName,
    sourceInput,
    reason: reason ?? null,
    rejectCount: nextCount,
    held,
    ledgerFound: Boolean(found),
    rebuild,
    regenerate: { requested: regenerate, ran: false, skipReason: null, result: null },
  };

  // ④ 자동 재생성 1회
  if (!regenerate) {
    result.regenerate.skipReason = 'regenerate=false — 재생성을 건너뛰었습니다(구독 소모 방지).';
    return result;
  }
  if (held) {
    result.regenerate.skipReason = `누적 반려 ${nextCount}회 — 자동 재생성을 중단했습니다(보류).`;
    return result;
  }
  if (!(await exists(path.join(paths.input, sourceInput)))) {
    result.regenerate.skipReason = `원본 자료(${sourceInput})가 Input/에 없어 재생성할 수 없습니다.`;
    return result;
  }

  const run = generateImpl ?? (await import('../generate/index.js')).generateKg;
  try {
    result.regenerate.ran = true;
    result.regenerate.result = await run({ files: [sourceInput] });
  } catch (err) {
    result.regenerate.ran = false;
    result.regenerate.skipReason = `재생성을 시작하지 못했습니다 — ${err.message}`;
  }
  return result;
}

/**
 * 승인분 반려 직후의 자동 재빌드 (§4.3-7 ②).
 *
 * **재빌드 실패를 반려 실패로 만들지 않는다.** 파일은 이미 Rejected/로 옮겨졌고 그것이 사용자의
 * 의도였다. Neo4j가 죽어 있어도 반려는 성립하며, 남는 것은 "DB가 아직 옛 상태"라는 사실뿐이라
 * 그것을 요약에 적어 사용자가 나중에 kg_rebuild를 부르게 한다.
 */
async function runRebuildAfterReject(rebuildImpl) {
  const run = rebuildImpl ?? (await import('../inject/index.js')).rebuildGraph;
  try {
    const result = await run();
    if (result?.ok) {
      return {
        required: true,
        done: true,
        note: `제외 재빌드 완료 — 노드 ${result.nodes}·관계 ${result.relationships} (buildId ${result.buildId}).`,
      };
    }
    return {
      required: true,
      done: false,
      note: `파일은 이미 Rejected/로 이동됐지만 재빌드는 하지 못했습니다 — ${result?.summary ?? '사유 불명'} 나중에 kg_rebuild를 실행하세요.`,
    };
  } catch (err) {
    return {
      required: true,
      done: false,
      note: `파일은 이미 Rejected/로 이동됐지만 재빌드는 하지 못했습니다 — ${err.message}. Neo4j 기동 후 kg_rebuild를 실행하세요.`,
    };
  }
}

/** `review_list` 요약 텍스트 (§4.3-4). */
export function formatReviewList(r) {
  const lines = [`검수 대기 ${r.pendingCount}건 · 승인분 ${r.reviewedCount}건 · 반려 이력 ${r.rejectedCount}건${r.heldCount > 0 ? ` · 보류 ${r.heldCount}건` : ''}`];
  for (const i of r.items) {
    if (i.readError) {
      lines.push(`  ! ${i.file} — 읽기 실패: ${i.readError}`);
      continue;
    }
    const bits = [`노드 ${i.nodeCount}·관계 ${i.relCount}`, `엔진 ${i.engine ?? '미기록'}`];
    if (i.rejectCount > 0) bits.push(`반려 ${i.rejectCount}회${i.held ? ' · 보류' : ''}`);
    const nt = newTypesLabel(i.newTypes);
    if (nt) bits.push(nt);
    lines.push(`  · ${i.file} (${bits.join(' · ')})`);
  }
  if (r.pendingCount === 0) lines.push('  (대기 중인 파일이 없습니다)');
  if (r.metaMissingCount > 0) {
    lines.push(`엔진 미기록 ${r.metaMissingCount}건 — meta 스탬프 도입 전에 생성된 파일입니다(추측하지 않고 그대로 표시합니다).`);
  }
  lines.push('표시: review_show, 승인: review_approve, 반려: review_reject — file 인자에 위 파일명을 그대로 넣으세요.');
  return lines.join('\n');
}

function newTypesLabel(newTypes) {
  if (!newTypes) return null;
  const n = (newTypes.node_labels ?? []).length;
  const r = (newTypes.relationships ?? []).length;
  if (n === 0 && r === 0) return null;
  return `신규 유형 노드 ${n}종·관계 ${r}종`;
}

/** `review_show` 요약 텍스트 (§4.3-5). */
export function formatShow(r) {
  if (!r.ok) {
    return [`${r.file} — 구조 검증 실패로 화면에 표시하지 않았습니다.`, ...r.errors.map((e) => `  ✗ ${e}`)].join('\n');
  }
  const s = r.structure;
  const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(' · ');
  const lines = [
    `${r.file} (${r.from}) — 노드 ${s.nodeCount}·관계 ${s.relCount}`,
    `  라벨: ${top(s.byLabel, 8) || '(없음)'}`,
    `  관계: ${top(s.byRelType, 8) || '(없음)'}`,
  ];
  const nt = newTypesLabel(r.newTypes);
  if (nt) lines.push(`  ${nt}: ${[...(r.newTypes.node_labels ?? []), ...(r.newTypes.relationships ?? [])].join(', ')}`);
  for (const w of r.warnings.slice(0, 5)) lines.push(`  ⚠ ${w}`);
  if (r.warnings.length > 5) lines.push(`  ⚠ 경고 ${r.warnings.length - 5}건 더 있습니다.`);
  return lines.join('\n');
}

/** `review_approve` 요약 텍스트 (§4.3-6). */
export function formatApprove(r) {
  if (!r.ok) return `${r.file} — 승인하지 못했습니다: ${r.reason}`;
  const lines = [`${r.file} → Reviewed/ 이동 완료 · 잔여 대기 ${r.remaining}건`];
  if (r.replaced) lines.push('기존 승인분이 교체되었습니다 — 재주입(kg_rebuild) 필요');
  if (r.ledgerFound && r.resetFrom > 0) lines.push(`반려 카운터를 ${r.resetFrom} → 0으로 리셋했습니다.`);
  if (!r.ledgerFound) lines.push(`원장에서 ${r.sourceInput} 항목을 찾지 못해 반려 카운터는 손대지 않았습니다.`);
  return lines.join('\n');
}

/** `review_reject` 요약 텍스트 (§4.3-7). */
export function formatReject(r) {
  if (!r.ok) return `${r.file} — 반려하지 못했습니다: ${r.reason}`;
  const lines = [`${r.file} (${r.from}) → Rejected/${r.movedTo} 이동 완료 · 누적 반려 ${r.rejectCount}회`];
  if (r.reason) lines.push(`사유: ${r.reason}`);
  if (!r.ledgerFound) lines.push(`원장에서 ${r.sourceInput} 항목을 찾지 못해 반려 횟수는 파일 수로 셌습니다.`);
  if (r.rebuild.required) lines.push(r.rebuild.note);
  if (r.held) {
    lines.push(`누적 반려 ${r.rejectCount}회로 보류합니다 — 스키마·지시문을 조정한 뒤 kg_generate에 files로 ${r.sourceInput}을 명시해 재시도하세요.`);
  } else if (r.regenerate.ran && r.regenerate.result) {
    const g = r.regenerate.result;
    lines.push(`자동 재생성 1회 실행 — 생성 ${g.generated}건·실패 ${g.failed}건`);
    for (const x of g.results ?? []) {
      if (!x.ok) lines.push(`  ✗ ${x.file} — [${x.kind}] ${x.summary}`);
    }
  } else if (r.regenerate.skipReason) {
    lines.push(r.regenerate.skipReason);
  }
  return lines.join('\n');
}
