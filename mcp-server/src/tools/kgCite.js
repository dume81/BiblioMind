// kg_cite — 인용 검증(∩1층) + 2층 푸시 (TECH-SPEC §4.3-13 표면 · §6.5 검증 규칙).
import { z } from 'zod';
import { buildSummary, toolContent } from './_summary.js';
import { getSearch, latestSearch } from '../lib/lastSearches.js';
import { pushToHub } from '../vizClient.js';

// 인용 밀도 안내 임계(§4.3-13 v2.3) — 1층 별칭 총수 대비 제출 비율.
// 이 신호는 "인용이 잘못됐다"가 아니라 "1층이 작아 2층 대비가 안 난다"는 화면 가독성 정보다.
// 스파이크 21문에서 4회 전부 오탐이었으므로(1층 대부분이 실제 근거였다) 서술형으로만 쓰고,
// 모델이 정당한 인용을 철회하도록 유도하지 않는다.
const CITE_DENSITY_RATIO = 0.5;

/**
 * 교집합 검증 — 별칭 존재성 검사(§6.5.4). 순수 함수(테스트 대상).
 * @param {{ nodes: Record<string, {kgid: string}>, rels: Record<string, {kgid: string, from: string, to: string}> }} entry
 * @param {string[]} nodeIds 노드 별칭
 * @param {string[]} relIds 관계 별칭
 */
export function verifyCitations(entry, nodeIds, relIds) {
  const layer2Nodes = new Set();
  const layer2Rels = new Set();
  const dropped = [];
  for (const a of nodeIds) {
    const hit = entry.nodes[a];
    if (hit) layer2Nodes.add(hit.kgid);
    else dropped.push({ a, reason: '검색 결과에 없는 별칭' });
  }
  let acceptedRels = 0;
  for (const a of relIds) {
    const hit = entry.rels[a];
    if (hit) {
      layer2Rels.add(hit.kgid);
      layer2Nodes.add(hit.from); // 통과 관계의 양 끝 노드 자동 포함(§6.5.4)
      layer2Nodes.add(hit.to);
      acceptedRels += 1;
    } else {
      dropped.push({ a, reason: '검색 결과에 없는 별칭' });
    }
  }
  const acceptedNodes = nodeIds.filter((a) => entry.nodes[a]).length;
  const submitted = nodeIds.length + relIds.length;
  const accepted = acceptedNodes + acceptedRels;
  const status = submitted === 0 || accepted === 0 ? 'none' : dropped.length > 0 ? 'partial' : 'verified';
  return {
    layer2: { nodeIds: [...layer2Nodes], relIds: [...layer2Rels] },
    dropped,
    submitted,
    accepted,
    acceptedNodes,
    acceptedRels,
    status,
  };
}

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 */
export function registerKgCite(server) {
  server.registerTool(
    'kg_cite',
    {
      title: '인용 검증 + 2층 하이라이트',
      description:
        '답변이 실제 인용한 근거를 제출해 검증하고 3D 앱에 2층(강조+파티클)을 표시한다. ' +
        'node_ids/rel_ids에는 직전 kg_search 결과의 a값(별칭 — 예: "n1", "r4")을 그대로 넣어라. ' +
        '그래프 근거를 쓰지 않았다면 빈 배열로 호출하라("인용 없음" 안내). 읽기 전용.',
      inputSchema: {
        node_ids: z.array(z.string()).optional().describe('답변이 인용한 노드 별칭 배열 (기본 [])'),
        rel_ids: z.array(z.string()).optional().describe('답변이 인용한 관계 별칭 배열 — 경로는 관계 중심으로 인용 (기본 [])'),
        search_id: z.string().optional().describe('kg_search가 반환한 searchId (생략 시 최근 검색)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ node_ids: nodeIds = [], rel_ids: relIds = [], search_id: searchId }) => {
      const entry = getSearch(searchId);
      if (!entry) {
        return toolContent(buildSummary({
          tool: 'kg_cite',
          status: '실패',
          lines: [searchId
            ? `검색 "${searchId}"를 찾을 수 없습니다(5건 초과 밀림 또는 오기재) — 2층 미표시.`
            : '검증할 검색 기록이 없습니다 — kg_search를 먼저 호출하세요.'],
          next: '재검색(kg_search) 후 다시 인용',
        }));
      }

      const verdict = verifyCitations(entry, nodeIds, relIds);
      const layer1Total = Object.keys(entry.nodes).length + Object.keys(entry.rels).length;
      const denseCite = layer1Total > 0 && verdict.submitted > layer1Total * CITE_DENSITY_RATIO;

      // "현재 표시 중" = 최신 레코드(총감사 확정) — 불일치면 검증만 하고 푸시 생략(§6.5.4)
      const latest = latestSearch();
      const isCurrent = latest?.searchId === entry.searchId;
      let viewer = null;
      if (isCurrent) {
        viewer = await pushToHub('/api/highlight', {
          type: 'highlight.set',
          ts: new Date().toISOString(),
          searchId: entry.searchId,
          buildId: entry.buildId ?? null,
          question: entry.question ?? null,
          truncated: Boolean(entry.truncated),
          layer1: {
            nodeIds: Object.values(entry.nodes).map((n) => n.kgid),
            relIds: Object.values(entry.rels).map((r) => r.kgid),
          },
          layer2: verdict.layer2,
          citation: { status: verdict.status, submitted: verdict.submitted, accepted: verdict.accepted },
        });
      }

      const data = {
        searchId: entry.searchId,
        verified: { relationships: verdict.acceptedRels, nodes: verdict.acceptedNodes },
        dropped: verdict.dropped.length,
        dropped_detail: verdict.dropped,
        citationStatus: verdict.status,
        viewer: viewer
          ? { hubUp: viewer.hubUp, connected: viewer.connected, delivered: viewer.delivered }
          : { skipped: '이미 새 검색으로 대체됨 — 푸시 생략(화면 오염 방지)' },
      };

      const lines = [
        verdict.submitted === 0
          ? '빈 인용 제출 — "인용 없음"으로 확정(1층만 표시).'
          : `인용 ${verdict.submitted}건 중 ${verdict.accepted}건이 검색 결과에 존재${verdict.dropped.length > 0 ? `, ${verdict.dropped.length}건 탈락` : ''} — 의미 일치는 화면에서 직접 확인하세요.`,
      ];
      if (denseCite) lines.push(`1층의 ${layer1Total}건 중 ${verdict.submitted}건을 인용했습니다 — 2층이 1층과 거의 같아 강조 대비가 낮습니다.`);
      if (!isCurrent) lines.push('이미 새 검색으로 대체됨 — 검증만 수행하고 화면 푸시는 생략했습니다.');
      if (viewer?.note) lines.push(viewer.note);
      lines.push(verdict.accepted > 0
        ? '그래프 근거 답변입니다 — 답변 맨 앞에 [비블리오마인드 답변]을 표기하고, 이 검증 요약을 답변 본문 뒤에 덧붙이세요(요약만 단독 전달 금지).'
        : '검증 통과 인용이 없습니다 — [비블리오마인드 답변] 표기 없이 답하고, 그래프 밖 일반 지식임을 밝힌 뒤 이 요약을 덧붙이세요.');

      return toolContent(
        buildSummary({
          tool: 'kg_cite',
          status: verdict.dropped.length > 0 && verdict.accepted === 0 ? '부분 성공' : '성공',
          lines,
          next: '답변 본문 + 검증 요약을 함께 전달하고, 3D 화면에서 강조 경로가 원문과 맞는지 확인 (의미 검수)',
        }),
        data,
      );
    },
  );
}
