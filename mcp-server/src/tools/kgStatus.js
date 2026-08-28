// kg_status — 파이프라인·DB·연결 상태 한눈 조회 (TECH-SPEC §4.3-15 v2.12).
// 수집은 도메인(@bibliomind/pipeline/status)이 소유한다 — DB count의 Cypher까지 도메인에 있다
// (표면 파일에 질의문을 반입하는 최초 선례를 만들지 않기 위함. D3 결정과 무관하게 pipeline은
// 합법 위치). 표면의 몫은 둘이다: 허브 조회(화면 소관 — vizClient)와 사람 말 요약.
// DB·허브가 죽어 있어도 이 도구는 실패하지 않는다 — 그 사실의 보고가 곧 이 도구의 일이며,
// 그때의 상태값은 '부분 성공'이다.

import { collectPipelineStatus } from '@bibliomind/pipeline/status';
import { buildSummary, toolContent } from './_summary.js';
import { getHubHealth } from '../vizClient.js';

export { buildSummary }; // 기존 테스트 호환 재-export (_summary.js가 정본)

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 */
export function registerKgStatus(server) {
  server.registerTool(
    'kg_status',
    {
      title: '비블리오마인드 상태 조회',
      description:
        '비블리오마인드 파이프라인(Input/Generated 대기/Reviewed/Rejected/보류)·Neo4j·3D 뷰어 연결 상태를 한눈에 조회한다. ' +
        '인자 없음, 읽기 전용. 문제가 있으면 "다음 행동"에 복구 명령을 안내한다.',
      // 인자 없는 도구 → inputSchema 생략. 인자 있는 도구는 zod raw shape로 전달한다.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      let status;
      let hub;
      try {
        [status, hub] = await Promise.all([collectPipelineStatus(), getHubHealth()]);
      } catch (err) {
        return toolContent(
          buildSummary({ tool: 'kg_status', status: '실패', lines: [err.message], next: 'npm run setup으로 환경을 점검하세요.' }),
          { error: err.message },
        );
      }

      const p = status.pipeline;
      const lines = [
        `자료 파이프라인 — Input ${p.input} · 검수 대기 ${p.generated} · 승인 ${p.reviewed} · 반려 보존 ${p.rejected}`
        + (p.blocked > 0 ? ` · 차단 ${p.blocked}` : ''),
      ];
      if (p.held.length > 0) lines.push(`보류(반려 3회) ${p.held.length}건: ${p.held.join(', ')}`);

      if (status.db.ok) {
        const b = status.build;
        lines.push(`Neo4j — 노드 ${status.db.nodes}·관계 ${status.db.relationships}`
          + (b ? ` (마지막 재빌드 ${b.buildId} · ${b.at})` : ' (재빌드 기록 없음)'));
      } else {
        lines.push(`Neo4j 접속 불가 [${status.db.kind}] — ${status.db.error}`);
      }

      if (status.schema) {
        lines.push(`스키마 v${status.schema.schema_version} (수정 ${status.schema.updated_at})`
          + (status.schema.autoTypes.length > 0 ? ` · 자동 등재 유형 ${status.schema.autoTypes.length}종: ${status.schema.autoTypes.join(', ')}` : ''));
      } else if (status.schemaError) {
        lines.push(`스키마 파일 읽기 실패 — ${status.schemaError}`);
      }
      if (status.ledgerError) lines.push(`⚠ 원장 손상 — ${status.ledgerError}`);

      lines.push(hub.hubUp
        ? `3D 뷰어 — 허브 가동 · 접속 ${hub.connected}명${hub.connected === 0 ? ' (크롬에서 http://localhost:5173 을 열면 표시됩니다)' : ''}`
        : '3D 뷰어 — 허브 꺼짐');
      lines.push(`기본 엔진 — ${status.engine}`);

      // 다음 행동 — 문제 우선순위: DB > 원장 손상 > 허브 > 보류 > 검수 대기 > 평시
      let next;
      if (!status.db.ok) next = status.db.hint;
      else if (status.ledgerError) next = '원장(data/ledger.json)을 복구하기 전에는 수집을 실행하지 마세요.';
      else if (!hub.hubUp) next = hub.note;
      else if (p.held.length > 0) next = '보류 자료는 스키마·지시문 조정 후 kg_generate에 파일명을 명시해 재시도하세요.';
      else if (p.generated > 0) next = 'review_list로 검수 대기를 확인하고 승인·반려를 진행하세요.';
      else next = 'kg_search로 질문을 던져 그래프를 사용하세요.';

      const ok = status.db.ok && hub.hubUp && !status.ledgerError && !status.schemaError;
      return toolContent(
        buildSummary({ tool: 'kg_status', status: ok ? '성공' : '부분 성공', lines, next }),
        { ...status, hub },
      );
    },
  );
}
