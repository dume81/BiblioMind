// kg_generate — Input MD → Generated/<stem>.kg.json 생성 (TECH-SPEC §4.3-3).
//
// limit 기본 1의 이유: 파일당 최장 10분이므로 기본이 크면 단일 도구 호출이 수십 분이 되어
// MCP 클라이언트 타임아웃·챗 UX와 정면 충돌한다. 기본 1 + "같은 명령 재실행 = 이어서 처리"를
// 기본 사용 패턴으로 삼는다. 타임아웃을 올린 사용자만 limit을 올려 부르면 된다.

import { z } from 'zod';
import { generateKg, formatGenerateSummary, LIMIT_DEFAULT } from '@bibliomind/pipeline/generate';
import { buildSummary, toolContent } from './_summary.js';

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 */
export function registerKgGenerate(server) {
  server.registerTool(
    'kg_generate',
    {
      title: '지식그래프 생성',
      description:
        'Input 폴더의 자료(MD)를 지식그래프 JSON으로 생성해 검수 대기(Generated)에 넣는다. '
        + '파일당 엔진 CLI를 1회 호출하며 검증을 통과한 것만 저장한다. '
        + `기본 ${LIMIT_DEFAULT}건만 처리하고 남은 건수를 보고한다 — 같은 명령을 다시 실행하면 이어서 처리한다. `
        + '한도 소진 시 다른 엔진으로 자동 전환한다(failover=false로 끄면 엔진별 검증에 쓸 수 있다).',
      inputSchema: {
        files: z.array(z.string()).optional()
          .describe('Input 파일명 목록. 생략하면 미생성분 전체가 대상이 된다. 명시하면 limit은 무시된다.'),
        engine: z.enum(['codex', 'claude']).optional()
          .describe('시작 엔진. 생략 시 설정 기본값(KG_ENGINE 또는 codex).'),
        failover: z.boolean().optional()
          .describe('한도 소진 시 다른 엔진으로 자동 전환(기본 true). false면 시작 엔진에 고정 — 엔진별 준수율 측정용.'),
        limit: z.number().int().min(1).optional()
          .describe(`이번 호출에서 처리할 최대 파일 수(기본 ${LIMIT_DEFAULT}).`),
        force: z.boolean().optional()
          .describe('이미 생성된 자료도 다시 생성한다(기본 false).'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      let result;
      try {
        result = await generateKg({
          files: args?.files,
          engine: args?.engine,
          failover: args?.failover ?? true,
          limit: args?.limit ?? LIMIT_DEFAULT,
          force: args?.force ?? false,
        });
      } catch (err) {
        return toolContent(
          buildSummary({
            tool: 'kg_generate',
            status: '실패',
            lines: [`생성을 시작하지 못했습니다 — ${err.message}`],
            next: '인자를 확인한 뒤 다시 실행하세요.',
          }),
          { error: err.message },
        );
      }

      const status = result.failed === 0 && result.generated > 0
        ? '성공'
        : result.generated > 0 ? '부분 성공' : '실패';
      const next = result.remaining > 0
        ? '같은 명령을 다시 실행하면 남은 자료를 이어서 처리합니다.'
        : result.generated > 0
          ? 'review_list로 검수 대기 목록을 확인하세요.'
          : 'Input 폴더에 자료가 있는지, 이미 생성된 자료인지 확인하세요(force로 재생성 가능).';

      return toolContent(
        buildSummary({
          tool: 'kg_generate',
          status,
          lines: formatGenerateSummary(result).split('\n'),
          next,
        }),
        result,
      );
    },
  );
}
