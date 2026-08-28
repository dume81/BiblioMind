// collect_docs — S2 문서 수집 표면 (TECH-SPEC §4.3-2 v2.13). 도메인은 @bibliomind/pipeline/extract.
// 요약 문구는 CLI 포매터(formatExtractSummary — "--force" 표기)를 재사용하지 않고 챗 계약에
// 맞춰 조립한다 — 출력 계약이 다른 두 표면이지 같은 코드의 사본이 아니다(코드 품질 3조-1 단서).
import path from 'node:path';
import { z } from 'zod';
import { collectDocsBatch } from '@bibliomind/pipeline/extract';
import { buildSummary, toolContent } from './_summary.js';

/**
 * collectDocsBatch 결과 → §4.1 요약 조각. 순수 함수 — 성공 경로 시험이 여기를 직접 밟는다.
 * 차단(blocked) 스킵은 force가 통하지 않으므로(§2.4.4 blocked>force) force를 권하지 않는다.
 * @param {{ counts: object, results: object[], unsupported: string[] }} batch
 * @returns {{ status: '성공'|'부분 성공'|'실패', lines: string[], next: string }}
 */
export function summarizeCollectDocs(batch) {
  const { counts, results, unsupported } = batch;
  const lines = [
    `추출 대상 ${counts.total}건 — 저장 ${counts.extracted}·스킵 ${counts.skipped}·실패 ${counts.failed}`
    + (counts.low + counts.empty > 0 ? ` (저품질 low ${counts.low}·empty ${counts.empty})` : ''),
  ];

  const okRows = results.filter((r) => !r.failed);
  for (const r of okRows.slice(0, 15)) {
    const name = path.basename(r.file);
    if (r.skipped && r.reason === 'blocked') {
      lines.push(`  [차단] ${name} — 영구 차단된 자료(force로도 재추출되지 않음). `
        + '해제하려면 source_remove(mode: recollect_ok)로 원장 차단을 정리하세요.');
    } else if (r.skipped) {
      lines.push(`  [스킵] ${name} — 이미 추출됨(${r.reason}) → ${r.outFile ?? '기록만 존재'}. 재추출은 force.`);
    } else {
      lines.push(`  [${r.quality}] ${name} → ${r.outFile}${r.overwritten ? ' (덮어씀)' : ''} · ${r.chars}자`);
    }
  }
  if (okRows.length > 15) lines.push(`  … 외 ${okRows.length - 15}건 (전량은 아래 데이터 블록)`);

  const failRows = results.filter((r) => r.failed);
  if (failRows.length > 0) {
    lines.push(`실패 사유(최대 5건 표시${failRows.length > 5 ? `, 나머지 ${failRows.length - 5}건` : ''}):`);
    for (const r of failRows.slice(0, 5)) lines.push(`  · ${path.basename(r.file)} — ${r.error}`);
  }
  if (unsupported.length > 0) {
    lines.push(`지원하지 않아 제외 ${unsupported.length}건: ${unsupported.slice(0, 5).join(', ')}${unsupported.length > 5 ? ' …' : ''}`);
  }
  lines.push('본문은 이 기계를 벗어나지 않았습니다 (S2 로컬 전용).');

  const status = counts.failed > 0
    ? (counts.extracted + counts.skipped > 0 ? '부분 성공' : '실패')
    : '성공';
  const next = counts.extracted > 0
    ? 'kg_generate로 KG 생성을 시작하세요(기본 1건씩).'
    : counts.failed > 0
      ? '실패 항목의 사유를 해소한 뒤 같은 경로로 다시 실행하세요 — 성공분은 멱등 스킵됩니다.'
      : 'kg_status로 파이프라인 상태를 확인하세요.';
  return { status, lines, next };
}

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 */
export function registerCollectDocs(server) {
  server.registerTool(
    'collect_docs',
    {
      title: '문서 자료 수집 (S2 — 로컬 전용)',
      description:
        'PDF·이미지 파일(또는 그 폴더)을 로컬에서 텍스트로 추출해 Input/에 MD로 저장한다. '
        + '본문은 이 기계를 벗어나지 않는다(§1.5). 같은 파일 재투입은 멱등 스킵 — '
        + 'force = 재추출(기존 파일명 유지). 빈 추출도 파일은 만들고 품질(ok/low/empty)을 남긴다. '
        + 'path는 절대경로만 수용한다.',
      inputSchema: {
        path: z.string().describe('PDF/이미지 파일 또는 폴더의 **절대경로**'),
        force: z.boolean().optional().describe('기추출분 재추출(기존 파일명에 덮어씀)'),
      },
      annotations: {
        readOnlyHint: false, // Input/·원장을 쓴다
        destructiveHint: false, // 추가 전용 — 제거는 source_remove의 몫
        idempotentHint: true, // 같은 파일 재투입 = 내용 해시로 멱등 스킵(§2.4.4)
        openWorldHint: false, // 로컬 추출만 — 외부 전송 없음(§1.5)
      },
    },
    async ({ path: targetPath, force }) => {
      let batch;
      try {
        batch = await collectDocsBatch({ path: targetPath, force: Boolean(force) });
      } catch (err) {
        return toolContent(
          buildSummary({
            tool: 'collect_docs', status: '실패', lines: [err.message],
            next: '절대경로와 확장자(PDF/PNG/JPG 등)를 확인해 다시 시도하세요.',
          }),
          { error: err.message },
        );
      }
      const { status, lines, next } = summarizeCollectDocs(batch);
      return toolContent(buildSummary({ tool: 'collect_docs', status, lines, next }), batch);
    },
  );
}
