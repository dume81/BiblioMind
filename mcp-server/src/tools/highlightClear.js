// highlight_clear — 하이라이트 해제 (TECH-SPEC §4.3-14).
import { buildSummary, toolContent } from './_summary.js';
import { pushToHub } from '../vizClient.js';

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 */
export function registerHighlightClear(server) {
  server.registerTool(
    'highlight_clear',
    {
      title: '하이라이트 해제',
      description: '3D 앱의 쿼리 하이라이트를 해제한다(소스·그래프는 유지). 인자 없음.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const viewer = await pushToHub('/api/highlight', {
        type: 'highlight.clear',
        ts: new Date().toISOString(),
      });
      const lines = ['하이라이트 해제 신호를 보냈습니다.'];
      if (viewer.note) lines.push(viewer.note);
      return toolContent(
        buildSummary({ tool: 'highlight_clear', status: '성공', lines }),
        { viewer: { hubUp: viewer.hubUp, connected: viewer.connected, delivered: viewer.delivered } },
      );
    },
  );
}
