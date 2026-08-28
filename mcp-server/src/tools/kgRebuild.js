// kg_rebuild — Reviewed/ 전체를 Neo4j에 재조립 (TECH-SPEC §4.3-8).
//
// 도메인 로직은 @bibliomind/pipeline/inject가 정본이고 여기는 표면만 맡는다.
// 이 도구가 하는 표면 일은 둘뿐이다: 실패 분류를 사람 말로 바꾸는 것, 그리고 완료 후
// 3D 앱에 `graph.refresh`를 푸시하는 것(§5.2) — 푸시는 화면 소관이라 도메인에 두지 않는다.

import { rebuildGraph, formatRebuildSummary } from '@bibliomind/pipeline/inject';
import { classifyNeo4jError } from '@bibliomind/shared/neo4jClient';
import { buildSummary, toolContent } from './_summary.js';
import { pushToHub } from '../vizClient.js';

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 */
export function registerKgRebuild(server) {
  server.registerTool(
    'kg_rebuild',
    {
      title: '지식그래프 주입(전체 재빌드)',
      description:
        '승인분(Reviewed) 전체를 Neo4j에 다시 조립한다. 같은 이름·유형의 노드는 하나로 병합되고 '
        + '모든 노드·관계에 출처가 기록된다. **전체 재빌드라 몇 번을 실행해도 같은 결과가 나온다** — '
        + '중간에 실패하면 다시 실행하는 것이 곧 복구다. 완료 후 3D 앱이 자동으로 새 그래프를 받는다.',
      annotations: {
        readOnlyHint: false,
        // DB를 지웠다 다시 넣지만 **원본 진실은 로컬 Reviewed/** 이고 결과가 항상 같다.
        // 사용자 데이터가 사라지는 종류의 파괴가 아니므로 destructive로 표시하지 않는다(§4.4.3-1).
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      let result;
      try {
        result = await rebuildGraph();
      } catch (err) {
        const { kind, hint } = classifyNeo4jError(err);
        return toolContent(
          buildSummary({
            tool: 'kg_rebuild',
            status: '실패',
            lines: [
              `재빌드에 실패했습니다 — ${err.message}`,
              kind === 'paused' ? 'DB가 불완전 상태일 수 있습니다 — 복구 후 kg_rebuild를 다시 실행하세요.' : null,
            ].filter(Boolean),
            next: hint,
          }),
          { error: err.message, kind },
        );
      }

      if (!result.ok) {
        return toolContent(
          buildSummary({
            tool: 'kg_rebuild',
            status: '실패',
            lines: formatRebuildSummary(result).split('\n'),
            next: result.reason === 'locked'
              ? '다른 챗에서 재빌드가 끝난 뒤 다시 실행하세요(정상 동작입니다).'
              : ['invalid_canonical', 'invalid_property_overrides'].includes(result.reason)
                // 사전 오류의 수리는 파일 반려가 아니라 사전 편집이다(§4.3-8 v2.10 안내 분기 —
                // 종전에는 모든 실패가 반려 안내로 떨어져 사전 오류까지 오도했다)
                ? 'data/schema.json의 사전 항목(canonical_entities·property_overrides)을 수정한 뒤 kg_rebuild를 다시 실행하세요 — 파일 반려 대상이 아닙니다.'
                : 'review_show로 해당 파일을 확인하고 review_reject로 반려하면 재생성됩니다.',
          }),
          result,
        );
      }

      // 재빌드 완료 신호 — 3D 앱이 Neo4j 소스면 자동 재조회한다(§5.2·§7.7)
      const viewer = await pushToHub('/api/refresh', {
        type: 'graph.refresh',
        ts: new Date().toISOString(),
        buildId: result.buildId,
        reason: 'rebuild',
        counts: { nodes: result.nodes, relationships: result.relationships },
      });

      const lines = formatRebuildSummary(result).split('\n');
      if (viewer.note) lines.push(viewer.note);
      const verifiedOk = result.verified?.match !== false;
      return toolContent(
        buildSummary({
          tool: 'kg_rebuild',
          status: verifiedOk ? '성공' : '부분 성공',
          lines,
          next: result.files === 0
            ? 'review_list로 검수 대기를 확인하고 review_approve로 승인하세요.'
            : '의미 검수: 이제 질문을 던져 경로를 확인하세요.',
        }),
        { ...result, viewer },
      );
    },
  );
}
