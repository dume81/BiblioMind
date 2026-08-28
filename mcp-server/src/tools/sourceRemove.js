// source_remove — 자료의 완전 제거 (TECH-SPEC §4.3-9 v2.12). 파괴적 도구 — 정본이 '파괴적'을
// 명시하며, 승인 정책도 이 도구만 매번 확인이다(총감사 확정). 도메인은 @bibliomind/pipeline/remove.
import { z } from 'zod';
import { removeSource } from '@bibliomind/pipeline/remove';
import { buildSummary, toolContent } from './_summary.js';
import { pushToHub } from '../vizClient.js';

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 */
export function registerSourceRemove(server) {
  server.registerTool(
    'source_remove',
    {
      title: '자료 완전 제거 (파괴적)',
      description:
        '자료 하나를 **완전 제거**한다 — Input 원문·Generated·Reviewed·Rejected(반려 사본 전 회차)와 '
        + '원장 기록까지. 민감 자료가 반려 사본으로도 남지 않게 하기 위한 상위 명령이다. '
        + 'mode는 반드시 사용자에게 물어서 정한다: recollect_ok = 재수집 허용(원장에서 삭제) / '
        + 'block = 영구 차단(이후 수집이 이 자료를 건너뜀). 승인분이 제거되면 DB도 자동 재빌드된다.',
      inputSchema: {
        target: z.string()
          .describe('Input 파일명(.md — review_list의 .kg.json 파일명도 수용) 또는 원본 URL'),
        mode: z.enum(['recollect_ok', 'block'])
          .describe('recollect_ok = 재수집 허용 / block = 영구 차단. 사용자 확인 후 지정'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true, // 원본 자료가 사라진다 — 정본 명시 '파괴적'
        idempotentHint: true, // 재실행 = 남은 것만 마저 제거(부분 실패의 복구 수단)
        openWorldHint: true, // 승인분 제거 시 Neo4j 재빌드 동반
      },
    },
    async ({ target, mode }) => {
      let result;
      try {
        result = await removeSource({ target, mode });
      } catch (err) {
        return toolContent(
          buildSummary({ tool: 'source_remove', status: '실패', lines: [err.message], next: 'kg_status로 상태를 확인한 뒤 다시 시도하세요.' }),
          { error: err.message },
        );
      }

      // 재빌드가 실제로 돌았으면 3D 앱에 갱신 신호 — kg_rebuild와 같은 §5.2 계약
      let viewer = null;
      if (result.rebuild?.done) {
        viewer = await pushToHub('/api/refresh', {
          type: 'graph.refresh', ts: new Date().toISOString(),
          buildId: null, reason: 'rebuild', counts: null,
        });
      }

      const lines = [result.summary];
      for (const f of result.removed) lines.push(`  제거: ${f}`);
      for (const f of result.failed) lines.push(`  ✗ 실패: ${f.file} — ${f.error}`);
      if (result.ledger?.action === 'deleted') lines.push(`원장 엔트리 ${result.ledger.keys.length}건 삭제(재수집 허용).`);
      if (result.ledger?.action === 'blocked') lines.push(`원장 엔트리 ${result.ledger.keys.length || 1}건 영구 차단(blocked).`);
      if (result.rebuild?.note) lines.push(result.rebuild.note);
      if (viewer?.note) lines.push(viewer.note);
      lines.push(...result.notes);

      return toolContent(
        buildSummary({
          tool: 'source_remove',
          status: result.ok ? '성공' : '실패',
          lines,
          next: result.ok
            ? 'kg_status로 파이프라인 상태를 확인하세요.'
            : (result.failed.length > 0
              ? '장애 원인(파일 잠김 등) 해소 후 같은 명령을 다시 실행하세요 — 남은 것만 마저 지웁니다.'
              : 'target 표기를 확인해 다시 시도하세요.'),
        }),
        { ...result, viewer },
      );
    },
  );
}
