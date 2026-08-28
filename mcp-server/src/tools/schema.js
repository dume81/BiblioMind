// schema_get / schema_update — 전역 스키마 조회·수동 조정 (TECH-SPEC §4.3-10·11 v2.12).
// 한 파일 = 한 도구 도메인(스키마) — review.js가 4종 한 파일인 것과 같은 관례.
// 도메인은 @bibliomind/pipeline/schema — 표면은 요약 문장만 만든다.
import { z } from 'zod';
import { getSchema, updateSchema } from '@bibliomind/pipeline/schema';
import { buildSummary, toolContent } from './_summary.js';

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 */
export function registerSchemaTools(server) {
  server.registerTool(
    'schema_get',
    {
      title: '전역 스키마 조회',
      description:
        '지식그래프 유형 체계(노드 라벨·관계 유형·명명 규칙·추출 지시문·정본 사전 계수)와 '
        + 'schema_version을 조회한다. 인자 없음, 읽기 전용.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const r = await getSchema();
      if (!r.ok) {
        return toolContent(
          buildSummary({ tool: 'schema_get', status: '실패', lines: [r.summary], next: 'npm run setup 실행 후 다시 시도하세요.' }),
          r,
        );
      }
      const origins = { seed: 0, auto: 0, manual: 0 };
      for (const x of r.node_labels) origins[x.origin] = (origins[x.origin] ?? 0) + 1;
      return toolContent(
        buildSummary({
          tool: 'schema_get',
          status: '성공',
          lines: [
            `schema_version ${r.schema_version} (수정 ${r.updated_at})`,
            `노드 라벨 ${r.node_labels.length}종(seed ${origins.seed ?? 0} · auto ${origins.auto ?? 0} · manual ${origins.manual ?? 0}) · 관계 유형 ${r.relationships.length}종`,
            `추출 지시문 ${r.instructions_ko.length}줄 · 정본 사전 — 엔티티 ${r.dictionaries.canonical_entities}항 · 속성 승자 ${r.dictionaries.property_overrides}항`,
          ],
          next: '유형 조정은 schema_update, 상태 전반은 kg_status.',
        }),
        r,
      );
    },
  );

  server.registerTool(
    'schema_update',
    {
      title: '전역 스키마 수동 조정',
      description:
        '유형 체계를 연산 기반으로 조정한다(추가·제거·지시문 교체 — 전체 교체 불가). '
        + '그래프 데이터·파일은 건드리지 않으며 **새 생성분부터 적용, 기존 그래프 소급 없음**. '
        + '제거한 유형은 엔진이 다시 산출하면 자동 재등재될 수 있다(영구 배제 아님).',
      inputSchema: {
        add_node_types: z.array(z.string()).optional().describe('추가할 노드 라벨(영문 PascalCase)'),
        remove_node_types: z.array(z.string()).optional().describe('제거할 노드 라벨'),
        add_rel_types: z.array(z.string()).optional().describe('추가할 관계 유형(대문자 스네이크)'),
        remove_rel_types: z.array(z.string()).optional().describe('제거할 관계 유형'),
        set_instructions: z.array(z.string()).optional()
          .describe('추출 지시문 전체 교체(빈 배열 불가). 현재 지시문은 schema_get으로 먼저 확인'),
      },
      annotations: {
        readOnlyHint: false,
        // SDK 1차 출처: destructiveHint false = "additive-only". remove·set_instructions는
        // additive가 아니고, 런타임 스키마는 커밋 금지라 이전 값의 VCS 안전망도 없다.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args = {}) => {
      let r;
      try {
        r = await updateSchema(args);
      } catch (err) {
        return toolContent(
          buildSummary({ tool: 'schema_update', status: '실패', lines: [err.message], next: 'schema_get으로 현재 상태를 확인하세요.' }),
          { error: err.message },
        );
      }
      if (!r.ok) {
        return toolContent(
          buildSummary({ tool: 'schema_update', status: '실패', lines: [r.summary], next: 'schema_get으로 현재 지시문을 확인한 뒤 다시 시도하세요.' }),
          r,
        );
      }
      const lines = [r.summary];
      if (r.added.node_types.length > 0) lines.push(`추가(노드): ${r.added.node_types.join(', ')}`);
      if (r.added.rel_types.length > 0) lines.push(`추가(관계): ${r.added.rel_types.join(', ')}`);
      for (const rec of r.removed.node_types) lines.push(`제거(노드): ${JSON.stringify(rec)} — 복원 재료로 보관하세요`);
      for (const rec of r.removed.rel_types) lines.push(`제거(관계): ${JSON.stringify(rec)} — 복원 재료로 보관하세요`);
      if (r.previousInstructions) lines.push(`교체 전 지시문(되돌리기 재료): ${JSON.stringify(r.previousInstructions)}`);
      for (const s of r.skipped) lines.push(`건너뜀: ${s}`);
      for (const s of r.rejected) lines.push(`거부: ${s}`);
      for (const w of r.warnings) lines.push(`⚠ ${w}`);
      return toolContent(
        buildSummary({
          tool: 'schema_update',
          status: '성공',
          lines,
          next: r.changed ? 'schema_get으로 결과를 확인하세요. 다음 kg_generate부터 적용됩니다.' : '변경할 것이 없었습니다 — schema_get으로 현재 상태를 확인하세요.',
        }),
        r,
      );
    },
  );
}
