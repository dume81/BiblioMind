// kg_search — 그래프 검색 + 1층 무조건 푸시 (★ TECH-SPEC §4.3-12 표면 · §6 알고리즘).
import fs from 'node:fs';
import { z } from 'zod';
import { dataPaths } from '@bibliomind/shared/paths';
import { buildSummary, toolContent } from './_summary.js';
import { getReadSession, classifyNeo4jError } from '@bibliomind/shared/neo4jClient';
import { runSearch, nodeFacts, SEEDS_MIN_SCORE_RATIO, NODE_LIMIT_DEFAULT, NODE_LIMIT_MAX, HOPS_DEFAULT, HOPS_MAX } from '../lib/searchEngine.js';
import { recordSearch } from '../lib/lastSearches.js';
import { pushToHub } from '../vizClient.js';

// §6.5.3 인용 지시문 원문 — 결과에 동봉(도구 설명이 아니라 직전 컨텍스트).
const CITE_INSTRUCTIONS = `[인용 지침 — 반드시 따를 것]
1. 위 nodes/relationships만 그래프 근거로 사용하라. 여기 없는 내용으로 답할 때는
   "그래프 밖 일반 지식"임을 답변에 밝혀라.
2. 답변을 작성한 직후, 반드시 kg_cite 도구를 호출하라.
   - search_id: 위 searchId 값 그대로 (생략하면 최근 검색으로 처리된다)
   - rel_ids: 답변 근거로 실제 사용한 관계의 a값(별칭) 배열 (예: ["r1","r4"])
     — 근거 경로는 관계 중심으로 인용한다
   - node_ids: 관계 없이 단독으로 근거가 된 노드의 a값(별칭) 배열
3. 이 결과에 없는 a값을 만들어내지 마라. 답변 본문에는 a값이 아니라 이름을 써라.
4. 그래프 근거를 쓰지 않았다면 빈 배열로 호출하라 — "인용 없음"이 3D 앱과
   사용자에게 안내된다.
5. 시드가 0건이면 키워드를 더 일반적인 핵심어로 줄여 kg_search를 1회만 재호출하라.
6. 최종 메시지는 반드시 ① 질문에 대한 답변 본문(근거 관계를 자연어 문장으로 풀어서)
   ② kg_cite 검증 요약 순으로 구성하라. 검증 요약만 단독 전달하는 것은 미완성
   답변이다 — 요약은 답변을 대체하지 않는다.
7. 그래프 근거로 답했다면(인용이 1건 이상 검증 통과) 최종 메시지 맨 앞에
   [비블리오마인드 답변]을 표기하라. 그래프 근거 없이 일반 지식으로만 답하면
   표기하지 말고 "그래프 밖 일반 지식"임을 밝혀라(항목 1).
8. 질문이 요구하는 정보가 위 결과에 없으면(항목 5의 재호출 후에도 시드 미적중,
   또는 해당 속성·관계 부재), 답변 본문 첫머리에 그 부재를 명시하라 —
   "그래프에 없습니다"가 정답이다. 이때 무엇이 없는지 특정하라(노드 자체 부재 /
   노드는 있으나 해당 속성 부재 / 관계 부재). 부재를 밝힌 뒤에만 사전 지식을
   덧붙일 수 있고, 이때 항목 1에 따라 "그래프 밖 일반 지식"임을 표기하라.`;

/** 원장의 buildId 조회 (§3.5-5 — 없으면 null 허용). */
function readBuildId() {
  try {
    return JSON.parse(fs.readFileSync(dataPaths().ledgerFile, 'utf8')).build?.buildId ?? null;
  } catch {
    return null;
  }
}

/** searchId 발급 — 랜덤 접미 4자로 이중 프로세스 충돌 방지(총감사 확정). */
function newSearchId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `s-${ts}-${rand}`;
}

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 */
export function registerKgSearch(server) {
  server.registerTool(
    'kg_search',
    {
      title: '지식그래프 검색 + 1층 하이라이트',
      description:
        '지식그래프에서 질문 관련 서브그래프를 검색하고 3D 앱에 1층 하이라이트를 표시한다. ' +
        'keywords에는 질문 속 엔티티 이름을 조사/어미를 뗀 기본형으로 1~8개 넣어라(필수 — 예: "탄지로가 왜 싸웠어?" → ["탄지로"]). ' +
        '결과에 포함된 지시에 따라 답변 직후 kg_cite를 반드시 호출하라. ' +
        '질문 정보가 결과에 없으면 "그래프에 없다"고 답하는 것이 정답이다. 읽기 전용.',
      // keywords는 스펙상 필수지만 zod에서 optional로 선언 — SDK 검증 선차단 대신
      // 핸들러가 "재호출 안내" 요약을 반환하기 위함(§4.3-12, 총감사 확정).
      inputSchema: {
        keywords: z.array(z.string().min(1)).max(8).optional()
          .describe('질문 속 엔티티 이름의 기본형 1~8개 (필수 — 누락 시 재호출 안내가 반환된다)'),
        question: z.string().optional().describe(
          '사용자가 입력한 문장 그대로 — 요약·재작성·번역·접두어 부착 금지. '
          + '키워드 손상 자동 재검색의 유일한 대조 기준이자 3D 앱 상태 표시·로그에 쓰인다. 가급적 항상 전달하라.',
        ),
        hops: z.number().int().min(1).max(HOPS_MAX).optional().describe('확장 깊이 (기본 1, 최대 2)'),
        limit_nodes: z.number().int().min(1).max(NODE_LIMIT_MAX).optional().describe('1층 노드 상한 (기본 80, 최대 150)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ keywords, question, hops, limit_nodes: limitNodes }) => {
      if (!keywords || keywords.length === 0) {
        return toolContent(buildSummary({
          tool: 'kg_search',
          status: '실패',
          lines: ['keywords 인자가 없습니다 — 질문 속 엔티티 이름을 조사/어미를 뗀 기본형 1~8개로 추출해 재호출하세요.'],
          next: 'keywords를 채워 kg_search 재호출',
        }));
      }

      const lockWarning = fs.existsSync(dataPaths().lockFile)
        ? '재빌드 진행 중 — 결과가 불완전할 수 있음'
        : null;

      let session;
      let result;
      try {
        session = getReadSession();
        result = await runSearch(session, {
          keywords,
          question,
          hops: hops ?? HOPS_DEFAULT,
          limitNodes: limitNodes ?? NODE_LIMIT_DEFAULT,
        });
      } catch (err) {
        const { hint } = classifyNeo4jError(err);
        return toolContent(buildSummary({
          tool: 'kg_search',
          status: '실패',
          lines: [
            `그래프 검색 실패: ${String(/** @type {{message?: string}} */ (err)?.message ?? err)}`,
            hint,
            '이 상태에서 일반 지식으로 답할 경우 답변에 그래프 근거가 없음을 명시하라.',
          ],
          next: '복구 후 kg_search 재호출',
        }));
      } finally {
        await session?.close().catch(() => {});
      }

      const searchId = newSearchId();
      const buildId = readBuildId();
      const ts = new Date().toISOString();

      // T2 점수 하한에 잘린 후보 관측 로그 — stdout 금지 철칙에 따라 stderr 한 줄 JSON.
      // 재조정 데이터셋 추출: grep 'seed-floor' | sed 's/^.*seed-floor //' | jq
      if (result.seedFloorCuts.length > 0) {
        console.error(`[bibliomind] seed-floor ${JSON.stringify({
          searchId,
          ratio: SEEDS_MIN_SCORE_RATIO,
          cuts: result.seedFloorCuts,
        })}`);
      }

      // runtime 기록 (§6.3 단계 4 — 재시작·이중 클라이언트에서도 인용 검증 성립)
      recordSearch({
        searchId,
        ts,
        buildId,
        question: question ?? null,
        truncated: result.truncated,
        nodes: Object.fromEntries(result.nodes.map((n) => [n.a, { kgid: n.kgid }])),
        rels: Object.fromEntries(result.rels.map((r) => [r.a, { kgid: r.kgid, from: r.from, to: r.to }])),
      });

      // 단계 5a — 1층 결정 푸시 (무조건, 시드 0건이어도 빈 1층 푸시 — 잔상 방지)
      const viewer = await pushToHub('/api/highlight', {
        type: 'highlight.set',
        ts,
        searchId,
        buildId,
        question: question ?? null,
        truncated: result.truncated,
        layer1: {
          nodeIds: result.nodes.map((n) => n.kgid),
          relIds: result.rels.map((r) => r.kgid),
        },
        layer2: { nodeIds: [], relIds: [] },
        citation: { status: 'pending', submitted: 0, accepted: 0 },
      });

      const data = {
        searchId,
        buildId,
        seeds: result.seeds,
        unmatched: result.unmatched,
        ...(result.seedFloorCuts.length > 0 ? { seedFloorCuts: result.seedFloorCuts } : {}),
        nodes: result.nodes.map((n) => {
          const { facts, omitted } = nodeFacts(n.props);
          return {
            a: n.a, name: n.name, label: n.label,
            hop: n.priority === 0 ? 0 : n.priority === 1 ? 'path' : n.priority - 1,
            // `summary`(문자열 1개) → `props`(사실 속성 전부)로 교체(§4.3-12 v2.9).
            // 옛 형식은 숫자 속성을 원천 배제해 "설립 연도가 없다"는 거짓 부재를 만들었다.
            ...(Object.keys(facts).length > 0 ? { props: facts } : {}),
            ...(omitted > 0 ? { propsOmitted: omitted } : {}),
          };
        }),
        relationships: result.rels.map((r) => {
          const fromAlias = result.nodes.find((n) => n.kgid === r.from)?.a ?? null;
          const toAlias = result.nodes.find((n) => n.kgid === r.to)?.a ?? null;
          return { a: r.a, type: r.type, from: fromAlias, to: toAlias };
        }),
        counts: { nodes: result.nodes.length, relationships: result.rels.length, truncated: result.truncated },
        viewer: { hubUp: viewer.hubUp, connected: viewer.connected, delivered: viewer.delivered },
        instructions: CITE_INSTRUCTIONS,
      };

      const seedCount = result.seeds.reduce((sum, s) => sum + s.matched.length, 0);
      const lines = [
        `시드 ${seedCount}건(${result.seeds.map((s) => `${s.keyword}:${s.tier}`).join(', ') || '없음'}) · 1층 노드 ${result.nodes.length}·관계 ${result.rels.length}`,
        ...restorationLines(result.seeds), // 복원 0건이면 빈 배열 — 현행 문구와 바이트 동일
      ];
      if (result.unmatched.length > 0) lines.push(`그래프에 없는 키워드: ${result.unmatched.join(', ')}`);
      if (seedCount === 0) {
        lines.push('시드 0건 — 키워드를 더 일반적인 핵심어로 줄여 1회만 재호출하세요.');
        lines.push('재호출 후에도 시드 0건이면 "그래프에 없다"고 답하는 것이 정답입니다.');
        lines.push('검색이 못 찾는 것은 그래프 오류가 아니라 검색 품질 이슈 — 반려 대상 아님.');
      }
      if (result.truncated) lines.push('검색 결과가 상한에서 절단됨 — 더 좁은 질문 권장.');
      if (lockWarning) lines.push(lockWarning);
      if (result.ftWarning) lines.push(result.ftWarning);
      if (viewer.note) lines.push(viewer.note);

      return toolContent(
        buildSummary({
          tool: 'kg_search',
          status: seedCount === 0 ? '부분 성공' : '성공',
          lines,
          next: '답변 작성 직후 kg_cite 호출 (결과의 instructions 준수)',
        }),
        data,
      );
    },
  );
}

/**
 * 교정(재검색) 사실 공개 줄 — §6.2.3. 순수 함수(테스트 대상).
 *
 * 알고리즘이 실제로 아는 것은 ①원 키워드가 세 계층 모두 미적중 ②question 안에 자모 1개만
 * 다른 문자열이 유일하게 하나 있었다 — 둘뿐이다. "오타를 교정했다"는 확정형 단언은 이
 * 지식을 넘어서므로 쓰지 않는다. 전역 시드 절단으로 근거가 0건이 된 복원도 보고하지 않는다.
 *
 * @param {Array<{ keyword: string, restoredFrom?: string, matched: string[] }>} seeds
 * @returns {string[]}
 */
export function restorationLines(seeds) {
  const restored = seeds.filter((s) => s.restoredFrom && s.matched.length > 0);
  if (restored.length === 0) return [];
  const detail = restored
    .map((s) => `'${s.restoredFrom}'는 그래프에 없어, 이 호출의 question에서 자모 1개만 다른 '${s.keyword}'로 다시 검색함`)
    .join(' / ');
  return [
    `키워드 자동 재검색 ${restored.length}건: ${detail} (자동 추정 — 확정된 오타 판정이 아니다)`,
    '답변 본문에 이 재검색 사실을 밝혀라 — 추출한 키워드가 질문 표기와 달라 질문 쪽 표기로 다시 검색했다. 사용자가 실제로 쓴 표기와 다르면 그렇게 지적하라.',
  ];
}
