// S3 KG 생성 오케스트레이터 — 엔진 어댑터·failover·스키마 자동 등재 (TECH-SPEC §1.4·§2.1·§4.3-3).
//
// 흐름(§1.4): Input MD 읽기 → 프롬프트 조립(전역 스키마 렌더 치환) → 엔진 호출 →
//   JSON 파싱 → canonicalGraph 정규화 → 스키마 검증 → **통과 시에만** Generated/로 원자 이동
//   → 실행 단위로 신규 유형 자동 등재(schema_version +1).
//
// 스킵 판정(§2.4.1): 미생성분 = Input에 있으나 **Generated/ ∪ Reviewed/** 에 <stem>.kg.json이
//   없는 것. **Rejected/는 판정에서 제외**한다 — 반려분이 재생성 경로에서 영구 누락되는 것을 막는다.

import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';

import { dataPaths, ensureDataDirs } from '@bibliomind/shared/paths';
import { kgFileName } from '@bibliomind/shared/naming';
import { renderSchema, injectSchema } from '@bibliomind/shared/renderSchema';
import { validateKgSchema } from '@bibliomind/shared/kgSchemaValidate';
import { atomicWriteFile, atomicWriteJson } from '@bibliomind/shared/atomicWrite';
import { isoKst } from '@bibliomind/shared/datetime';
import { resolveEngine, otherEngine } from './resolveEngine.js';
import * as codexEngine from './engines/codex.js';
import * as claudeEngine from './engines/claude.js';

/** 파일당 엔진 호출 제한 시간 — 기본 10분(§4.3-3의 limit 기본 1 근거). */
export const ENGINE_TIMEOUT_MS = Number(process.env.KG_ENGINE_TIMEOUT_MS) || 600000;
/** 이번 호출에서 처리할 최대 파일 수 — 기본 1(§4.3-3 v2 하향). */
export const LIMIT_DEFAULT = 1;

const ENGINES = { codex: codexEngine, claude: claudeEngine };

/**
 * 엔진 출력에서 KG JSON을 꺼낸다. 백틱 펜스를 쓰지 말라고 지시하지만 붙여 올 수 있어 함께 처리한다.
 * @param {string} raw
 * @returns {{ ok: true, doc: object } | { ok: false, why: string }}
 */
export function parseEngineJson(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, why: '출력이 비어 있습니다.' };
  // 최상위 배열은 **구제하지 않는다**. 중괄호 구간만 뽑으면 `[{a},{b}]`에서 첫 객체만
  // 조용히 가져가게 되는데, 그건 자료의 일부를 말없이 버리는 것이다. 프롬프트가
  // "최상위는 단일 객체"라고 명시했고 bad_output 교정 재호출이 안전망이므로 되돌려보낸다.
  if (text.startsWith('[')) {
    return { ok: false, why: '최상위가 배열입니다 — 단일 JSON 객체여야 합니다.' };
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  const candidate = fenced ? fenced[1] : (first > -1 && last > first ? text.slice(first, last + 1) : text);
  try {
    const doc = JSON.parse(candidate);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      return { ok: false, why: '최상위가 단일 JSON 객체가 아닙니다.' };
    }
    return { ok: true, doc };
  } catch (err) {
    return { ok: false, why: `JSON 파싱 실패: ${err.message}` };
  }
}

/**
 * 미생성분 판정 — Generated ∪ Reviewed 기준, Rejected 제외 (§2.4.1).
 * @param {{input:string, generated:string, reviewed:string}} paths
 * @returns {Promise<string[]>} Input MD 파일명 목록
 */
export async function pendingInputs(paths) {
  const [inputs, generated, reviewed] = await Promise.all([
    listDir(paths.input, '.md'),
    listDir(paths.generated, '.json'),
    listDir(paths.reviewed, '.json'),
  ]);
  const done = new Set([...generated, ...reviewed]);
  return inputs.filter((f) => !done.has(kgFileName(path.basename(f, '.md'))));
}

async function listDir(dir, ext) {
  try {
    return (await fs.readdir(dir)).filter((f) => f.endsWith(ext));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * 신규 유형을 전역 스키마에 등재한다 (§2.1 — 실행 단위 1회, schema_version +1).
 * @param {object} schema
 * @param {{node_labels: string[], relationships: string[]}} newTypes
 * @param {string} schemaFile
 * @returns {Promise<{registered: boolean, from: number, to: number, nodes: string[], rels: string[]}>}
 */
export async function registerNewTypes(schema, newTypes, schemaFile) {
  const known = new Set([
    ...(schema.node_labels ?? []).map((x) => x.label),
  ]);
  const knownRels = new Set([
    ...(schema.core_relationships ?? []).map((x) => x.type),
    ...(schema.extended_relationships ?? []).map((x) => x.type),
  ]);
  const nodes = [...new Set(newTypes.node_labels ?? [])].filter((l) => !known.has(l)).sort();
  const rels = [...new Set(newTypes.relationships ?? [])].filter((t) => !knownRels.has(t)).sort();
  const from = Number(schema.schema_version ?? 1);
  if (nodes.length === 0 && rels.length === 0) {
    return { registered: false, from, to: from, nodes: [], rels: [] };
  }
  const next = {
    ...schema,
    schema_version: from + 1,
    updated_at: schema.updated_at,
    node_labels: [...(schema.node_labels ?? []), ...nodes.map((label) => ({ label, ko: null, desc: null, origin: 'auto' }))],
    extended_relationships: [...(schema.extended_relationships ?? []), ...rels.map((type) => ({ type, ko: null, origin: 'auto' }))],
  };
  await atomicWriteJson(schemaFile, next);
  return { registered: true, from, to: from + 1, nodes, rels };
}

/**
 * S3 KG 생성 — Input MD를 Generated/<stem>.kg.json 으로 만든다.
 *
 * @param {object} [options]
 * @param {string[]} [options.files] Input 파일명 목록. **명시 시 limit 무시**(사용자 의도 우선)
 * @param {'codex'|'claude'} [options.engine] 시작 엔진
 * @param {boolean} [options.failover] 한도 시 타 엔진 전환(기본 true)
 * @param {number} [options.limit] 처리 최대 파일 수(기본 1)
 * @param {boolean} [options.force] 기생성분 재생성
 * @param {Record<string, object>} [options.enginesImpl] 테스트 주입용
 * @param {Function} [options.spawnImpl] 테스트 주입용
 * @param {number} [options.timeoutMs] 테스트 주입용
 * @returns {Promise<object>} 결과 요약
 */
export async function generateKg(options = {}) {
  const {
    files = null, engine: engineArg, failover = true,
    limit = LIMIT_DEFAULT, force = false,
    enginesImpl = ENGINES, spawnImpl, timeoutMs = ENGINE_TIMEOUT_MS,
  } = options;

  const chosen = resolveEngine(engineArg);
  if (!chosen.ok) throw new Error(chosen.summary);

  ensureDataDirs();
  const paths = dataPaths();
  const schema = JSON.parse(await fs.readFile(paths.schemaFile, 'utf8'));
  const template = await fs.readFile(path.join(paths.root, '..', 'shared', 'prompts', 'kg-generation.md'), 'utf8')
    .catch(() => fs.readFile(new URL('../../../shared/prompts/kg-generation.md', import.meta.url), 'utf8'));

  // 대상 선정 — files 명시가 limit을 이긴다(§4.3-3).
  let targets;
  if (Array.isArray(files) && files.length > 0) {
    targets = files;
  } else {
    const pending = force ? await listDir(paths.input, '.md') : await pendingInputs(paths);
    targets = pending.slice(0, Math.max(1, limit));
  }
  const totalPending = Array.isArray(files) && files.length > 0
    ? files.length
    : (force ? (await listDir(paths.input, '.md')).length : (await pendingInputs(paths)).length);

  const summary = {
    engineStart: chosen.engine, failover, limit, force,
    generated: 0, failed: 0, results: [], switches: [],
    byEngine: { codex: 0, claude: 0 },
    remaining: Math.max(0, totalPending - targets.length),
    schemaUpdate: null, exhausted: false,
  };
  const collectedNewTypes = { node_labels: [], relationships: [] };
  let current = chosen.engine;

  for (const file of targets) {
    const stem = path.basename(file, '.md');
    let body;
    try {
      body = await fs.readFile(path.join(paths.input, file), 'utf8');
    } catch {
      summary.failed += 1;
      summary.results.push({ file, ok: false, kind: 'crash', summary: `Input 파일을 읽지 못했습니다: ${file}` });
      continue;
    }
    const parsedMd = matter(body);
    const prompt = injectSchema(template, renderSchema(schema))
      + `\n\n[자료 메타데이터]\n${JSON.stringify(parsedMd.data)}\n\n[자료 본문]\n${parsedMd.content.trim()}`;

    const outcome = await generateOne({
      prompt, stem, file, current, failover, enginesImpl, spawnImpl, timeoutMs,
      cwd: paths.tmp, schema, paths,
    });
    if (outcome.switchedTo) {
      summary.switches.push({ file, from: current, to: outcome.switchedTo });
      current = outcome.switchedTo;
    }
    if (outcome.ok) {
      summary.generated += 1;
      summary.byEngine[outcome.engine] += 1;
      collectedNewTypes.node_labels.push(...outcome.newTypes.node_labels);
      collectedNewTypes.relationships.push(...outcome.newTypes.relationships);
      summary.results.push({ file, ok: true, engine: outcome.engine, out: outcome.out, nodes: outcome.nodes, rels: outcome.rels, corrected: outcome.corrected });
    } else {
      summary.failed += 1;
      summary.results.push({ file, ok: false, kind: outcome.kind, summary: outcome.summary, engine: outcome.engine });
      if (outcome.kind === 'rate_limit') {
        summary.exhausted = true;
        break; // 양쪽 소진 — 자동 대기·폴링 없이 중단하고 보고한다(§1.4-4)
      }
    }
  }

  if (summary.generated > 0) {
    summary.schemaUpdate = await registerNewTypes(schema, collectedNewTypes, paths.schemaFile);
  }
  return summary;
}

/** 파일 1건 처리 — 한도 전환과 bad_output 교정 재호출 1회를 담당한다. */
async function generateOne(ctx) {
  const { prompt, stem, file, current, failover, enginesImpl, spawnImpl, timeoutMs, cwd, schema, paths } = ctx;
  let engine = current;
  let switchedTo = null;
  let corrected = false;
  let attemptPrompt = prompt;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const impl = enginesImpl[engine];
    const res = await impl.run({ prompt: attemptPrompt, timeoutMs, cwd, spawnImpl });

    if (!res.ok) {
      // 한도 → 같은 파일부터 타 엔진으로 전환해 계속(§1.4). 양쪽 소진이면 중단.
      if (res.kind === 'rate_limit' && failover && switchedTo === null) {
        switchedTo = otherEngine(engine);
        engine = switchedTo;
        continue;
      }
      return { ok: false, kind: res.kind, summary: res.summary, engine, switchedTo };
    }

    const parsed = parseEngineJson(res.text);
    const verdict = parsed.ok
      ? validateKgSchema(parsed.doc, schema, { requireMeta: false })
      : { ok: false, errors: [parsed.why] };

    if (verdict.ok) {
      const doc = verdict.doc ?? parsed.doc;
      const newTypes = verdict.newTypes ?? { node_labels: [], relationships: [] };
      // meta 스탬프 (§2.2) — **파이프라인이 찍는다**. 엔진에게 맡기면 값을 지어낼 수 있고,
      // meta.engine은 "실제로 생성한 엔진"이라 한도 전환 후에는 우리만 알 수 있다(§1.4-7).
      // schema_version은 신규 유형 등재 **전** 기준이다(§2.2 규약).
      doc.meta = {
        input_file: file,
        schema_version: Number(schema.schema_version ?? 1),
        engine,
        generated_at: isoKst(),
        ...(newTypes.node_labels.length > 0 || newTypes.relationships.length > 0
          ? { new_types: newTypes }
          : {}),
      };
      const out = kgFileName(stem);
      await atomicWriteFile(path.join(paths.generated, out), `${JSON.stringify(doc, null, 2)}\n`);
      return {
        ok: true, engine, switchedTo, out, corrected,
        nodes: doc.nodes?.length ?? 0, rels: doc.relationships?.length ?? 0,
        newTypes,
      };
    }

    // bad_output → **1회에 한해** 실패 사유를 붙여 교정 재호출(§1.4). 반려 카운트에는 넣지 않는다.
    if (corrected) {
      return { ok: false, kind: 'bad_output', summary: `교정 재호출도 실패했습니다 — ${(verdict.errors ?? []).slice(0, 3).join(' / ')}`, engine, switchedTo };
    }
    corrected = true;
    attemptPrompt = `${prompt}\n\n[직전 응답이 거부된 이유 — 이번에는 반드시 고쳐서 JSON만 반환하라]\n`
      + `${(verdict.errors ?? []).slice(0, 5).join('\n')}\n`
      + `[직전 응답 요지]\n${String(res.text).slice(0, 500)}`;
  }
  return { ok: false, kind: 'bad_output', summary: '재시도 한도를 넘었습니다.', engine, switchedTo };
}

/** 결과 요약을 사람이 읽는 텍스트로 (§4.3-3 반환 규약). */
export function formatGenerateSummary(s) {
  const lines = [`생성 ${s.generated}건 · 실패 ${s.failed}건 (시작 엔진 ${s.engineStart}${s.failover ? '' : ' · failover 없음'})`];
  for (const r of s.results) {
    lines.push(r.ok
      ? `  ✓ ${r.file} → ${r.out} (${r.engine}, 노드 ${r.nodes}·관계 ${r.rels}${r.corrected ? ' · 교정 재호출 1회' : ''})`
      : `  ✗ ${r.file} — [${r.kind}] ${r.summary}`);
  }
  if (s.switches.length > 0) {
    for (const w of s.switches) lines.push(`엔진 전환: ${w.file}에서 ${w.from} → ${w.to}`);
    lines.push(`파일별 엔진 집계: codex ${s.byEngine.codex}건 · claude ${s.byEngine.claude}건`);
  }
  if (s.exhausted) lines.push('두 엔진 모두 사용량 한도 — 회복 후 같은 명령을 다시 실행하면 이어서 처리합니다.');
  if (s.schemaUpdate?.registered) {
    lines.push(`신규 노드 유형 ${s.schemaUpdate.nodes.length}종·관계 유형 ${s.schemaUpdate.rels.length}종 등재, schema_version ${s.schemaUpdate.from}→${s.schemaUpdate.to}`);
  }
  if (s.results.some((r) => r.kind === 'not_installed')) {
    lines.push('엔진 CLI가 설치되어 있지 않습니다 — npm install -g @openai/codex 또는 @anthropic-ai/claude-code 후 로그인하세요.');
  }
  if (s.remaining > 0) lines.push(`남은 대기 ${s.remaining}건 — 다시 실행하면 이어서 처리합니다.`);
  return lines.join('\n');
}
