// S4 검수 워크플로 도구 4종 — review_list · review_show · review_approve · review_reject
// (TECH-SPEC §4.3-4~7). 도메인 로직은 @bibliomind/pipeline/review가 정본이고 여기는 표면만 맡는다.
//
// 반려 판단 가이드를 도구 설명에 넣는 것은 PRD S6 요구다 — 챗 모델이 "검색이 경로를 못 찾는다"를
// 반려 사유로 오해하면 멀쩡한 그래프가 계속 반려된다.

import { z } from 'zod';
import {
  listReviewQueue, prepareShow, approveKg, rejectKg,
  formatReviewList, formatShow, formatApprove, formatReject,
} from '@bibliomind/pipeline/review';
import { buildSummary, toolContent } from './_summary.js';
import { pushToHub } from '../vizClient.js';

const REJECT_GUIDE = '반려 판단 기준: 검색이 경로를 못 찾는 것은 반려 사유가 아니다(검색 품질 이슈) — '
  + '하이라이트된 경로의 내용이 원문과 다를 때만 반려한다.';

/** 도구가 던진 예외를 §4.1 실패 요약으로 환원한다 — 어떤 도구도 throw로 끝내지 않는다. */
function failure(tool, err, next) {
  return toolContent(
    buildSummary({ tool, status: '실패', lines: [err.message], next }),
    { error: err.message },
  );
}

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 */
export function registerReviewTools(server) {
  registerReviewList(server);
  registerReviewShow(server);
  registerReviewApprove(server);
  registerReviewReject(server);
}

/** §4.3-4 — 인자 없는 조회. */
export function registerReviewList(server) {
  server.registerTool(
    'review_list',
    {
      title: '검수 대기 목록',
      description: '검수 대기(Generated) 중인 지식그래프 파일 목록을 보여준다. '
        + '파일별 노드·관계 수, 생성 엔진, 신규 유형, 누적 반려 횟수와 보류 여부를 함께 돌려준다.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      let result;
      try {
        result = await listReviewQueue();
      } catch (err) {
        return failure('review_list', err, '데이터 폴더 상태를 확인한 뒤 다시 실행하세요.');
      }
      return toolContent(
        buildSummary({
          tool: 'review_list',
          status: '성공',
          lines: formatReviewList(result).split('\n'),
          next: result.pendingCount > 0
            ? 'review_show로 첫 파일을 화면에 띄워 확인하세요.'
            : 'kg_generate로 대기 자료를 생성하세요.',
        }),
        result,
      );
    },
  );
}

/** §4.3-5 — 검증 통과 시에만 화면에 푸시한다. */
export function registerReviewShow(server) {
  server.registerTool(
    'review_show',
    {
      title: '검수용 그래프 표시',
      description: '검수 대기(Generated) 또는 승인분(Reviewed)의 지식그래프 파일을 크롬 3D 앱에 표시한다. '
        + '구조 검증을 통과한 파일만 표시하며, 실패하면 화면에 올리지 않고 사유를 돌려준다.',
      inputSchema: {
        file: z.string().describe('review_list가 보여준 파일명 그대로(예: 20260822211905_readians_p01.kg.json).'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ file }) => {
      let prepared;
      try {
        prepared = await prepareShow({ file });
      } catch (err) {
        return failure('review_show', err, 'review_list로 파일명을 확인하세요.');
      }
      if (!prepared.ok) {
        return toolContent(
          buildSummary({
            tool: 'review_show',
            status: '실패',
            lines: formatShow(prepared).split('\n'),
            next: '이 파일은 구조가 깨져 있습니다 — review_reject로 반려하면 재생성됩니다.',
          }),
          prepared,
        );
      }

      const viewer = await pushToHub('/api/show', {
        type: 'graph.show',
        ts: new Date().toISOString(),
        purpose: 'review',
        file: prepared.file,
        sourceInput: prepared.sourceInput,
        graph: prepared.graph,
      });

      const lines = formatShow(prepared).split('\n');
      if (viewer.note) lines.push(viewer.note);
      return toolContent(
        buildSummary({
          tool: 'review_show',
          status: viewer.delivered ? '성공' : '부분 성공',
          lines,
          next: '내용이 원문과 맞으면 review_approve, 다르면 review_reject를 호출하세요. ' + REJECT_GUIDE,
        }),
        { ...omitGraph(prepared), viewer },
      );
    },
  );
}

/** 반환 데이터에서 그래프 본문은 뺀다 — 챗 컨텍스트에 노드 수천 개를 쏟지 않는다(화면이 받았다). */
function omitGraph(prepared) {
  const { graph: _graph, ...rest } = prepared;
  return rest;
}

/** §4.3-6 — 승인(Reviewed/ 이동 + 카운터 리셋). */
export function registerReviewApprove(server) {
  server.registerTool(
    'review_approve',
    {
      title: '검수 승인',
      description: '검수 대기(Generated) 파일을 승인해 Reviewed/로 옮긴다. 승인분이 Neo4j 주입의 원본이다. '
        + '같은 자료의 기존 승인분이 있으면 교체되며 재주입이 필요하다.',
      inputSchema: {
        file: z.string().describe('review_list가 보여준 파일명 그대로.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ file }) => {
      let result;
      try {
        result = await approveKg({ file });
      } catch (err) {
        return failure('review_approve', err, 'review_list로 파일명을 확인하세요.');
      }
      return toolContent(
        buildSummary({
          tool: 'review_approve',
          status: result.ok ? '성공' : '실패',
          lines: formatApprove(result).split('\n'),
          next: result.ok
            ? (result.remaining > 0
              ? `남은 대기 ${result.remaining}건 — review_list로 다음 파일을 확인하세요.`
              : '검수 대기가 비었습니다 — 주입은 kg_rebuild(슬라이스 7)에서 합니다.')
            : 'review_list로 파일명을 확인하세요.',
        }),
        result,
      );
    },
  );
}

/** §4.3-7 — 반려(Rejected/ 이동 + 카운터 +1 + 자동 재생성 1회). */
export function registerReviewReject(server) {
  server.registerTool(
    'review_reject',
    {
      title: '검수 반려',
      description: '검수 대기(Generated) 또는 승인분(Reviewed)의 지식그래프 파일을 반려한다. '
        + '파일은 삭제되지 않고 Rejected/에 이력으로 남으며, 기본적으로 같은 자료를 1회 자동 재생성한다. '
        + '누적 3회 반려면 자동 재생성을 멈추고 보류한다. '
        + REJECT_GUIDE,
      inputSchema: {
        file: z.string().describe('review_list가 보여준 파일명 그대로.'),
        reason: z.string().optional().describe('반려 사유. 원장에 기록되어 재생성 지시문 개선의 재료가 된다.'),
        regenerate: z.boolean().optional().describe('자동 재생성 1회 실행 여부(기본 true). 실수로 반려했다면 false로 두어 구독 소모를 막는다.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ file, reason, regenerate }) => {
      let result;
      try {
        result = await rejectKg({ file, reason, regenerate: regenerate ?? true });
      } catch (err) {
        return failure('review_reject', err, 'review_list로 파일명을 확인하세요.');
      }
      const status = !result.ok
        ? '실패'
        : (result.rebuild.required && !result.rebuild.done) || (result.regenerate.ran && result.regenerate.result?.failed > 0)
          ? '부분 성공'
          : '성공';
      return toolContent(
        buildSummary({
          tool: 'review_reject',
          status,
          lines: formatReject(result).split('\n'),
          next: result.ok
            ? (result.held
              ? 'schema_update로 스키마·지시문을 조정한 뒤 kg_generate에 files를 명시해 재시도하세요.'
              : 'review_list로 재생성 결과를 확인하세요.')
            : 'review_list로 파일명을 확인하세요.',
        }),
        result,
      );
    },
  );
}
