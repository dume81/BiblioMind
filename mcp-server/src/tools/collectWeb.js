// collect_web — S1 웹 수집 표면 (TECH-SPEC §4.3-1 v2.13). 도메인은 @bibliomind/pipeline/crawl.
// 수집 2종은 화면 관여가 없다(§4.2 "화면 관여 없음") — 허브 푸시를 하지 않는다.
// 요약은 CLI 포매터(formatSummary)를 재사용하지 않는다 — §4.1의 실패 5건 상한과 상태 판정
// 규칙(robots 전면 차단 = 실패)은 챗 표면만의 계약이라, 공유하면 CLI 출력이 같이 잘린다.
import { z } from 'zod';
import { collectWeb, MAX_PAGES_DEFAULT } from '@bibliomind/pipeline/crawl';
import { buildSummary, toolContent } from './_summary.js';

/**
 * crawl 요약 → §4.1 요약 조각. 순수 함수 — 성공 경로 시험이 여기를 직접 밟는다
 * (실패 분기만 밟는 시험의 재발 방지 — toolShape 2026-08-23 교훈).
 * @param {object} s collectWeb 반환 요약
 * @returns {{ status: '성공'|'부분 성공'|'실패', lines: string[], next: string }}
 */
export function summarizeCollectWeb(s) {
  const lines = [
    `수집 완료 — 성공 ${s.collected}건 · 실패 ${s.failed}건 · 건너뜀 ${s.skipped}건`
    + ` · robots 차단 ${s.robotsBlocked}건 · 중복 ${s.duplicated}건 (시도 ${s.attempted}/${s.maxPages})`,
  ];

  // §4.3-1: 저장 파일명 목록(최대 10 표시 + 총수). force 덮어쓰기는 신규가 아니다 — 구분 표기.
  const saved = s.pages.filter((p) => (p.result === 'collected' || p.result === 'overwritten') && p.file);
  if (saved.length > 0) {
    lines.push(`저장 ${saved.length}건:`);
    for (const p of saved.slice(0, 10)) lines.push(`  · ${p.file}${p.result === 'overwritten' ? ' (덮어씀)' : ''}`);
    if (saved.length > 10) lines.push(`  … 외 ${saved.length - 10}건 (전량은 아래 데이터 블록)`);
  }

  const fails = s.failures ?? [];
  if (fails.length > 0) {
    lines.push(`실패 사유(최대 5건 표시${fails.length > 5 ? `, 나머지 ${fails.length - 5}건` : ''}) — 다음 실행에서 자동 재시도:`);
    for (const f of fails.slice(0, 5)) lines.push(`  · ${f.url} — ${f.reason}`);
  }

  if (s.robotsNote) lines.push(`robots.txt: ${s.robotsNote}`);
  if (s.jinaKey === 'none') {
    lines.push('JINA_API_KEY가 없어 무키 저율 호출로 동작했습니다 — 무료 키 발급 권장(속도·한도 개선).');
  }
  if (s.missingFiles?.length > 0) {
    lines.push(`원장은 수집됨인데 파일이 없는 항목 ${s.missingFiles.length}건 — 그 페이지의 링크는 이어받지 못했습니다:`);
    for (const f of s.missingFiles.slice(0, 5)) lines.push(`  · ${f}`);
    lines.push('  (force로 다시 받거나 source_remove로 원장을 정리하세요.)');
  }
  if (s.remainingInQueue > 0) {
    lines.push(`상한에 걸려 ${s.remainingInQueue}개 URL을 남겼습니다 — 같은 명령을 다시 실행하면 이어서 수집합니다`
      + '(수집한 페이지는 요청 없이 스킵됩니다).');
  }

  // 상태 판정(v2.13) — robots 전면 차단·중복만 해소를 성공/실패에 정직하게 반영한다.
  const progressed = s.collected + s.skipped + s.duplicated > 0;
  let status;
  let next;
  if (s.failed > 0) {
    status = progressed ? '부분 성공' : '실패';
    next = s.collected > 0
      ? 'kg_generate로 KG 생성을 시작하세요(기본 1건씩). 실패분은 같은 명령 재실행 시 자동 재시도됩니다.'
      : '실패 사유 해소 후 같은 명령을 다시 실행하세요 — 실패분은 자동 재시도되고 기수집분은 건너뜁니다.';
  } else if (!progressed && s.robotsBlocked > 0) {
    status = '실패';
    next = 'robots.txt가 대상 경로의 수집을 차단했습니다 — 사이트 정책이라 재시도 대상이 아닙니다. 다른 URL을 시도하세요.';
  } else {
    status = '성공';
    next = s.collected > 0
      ? 'kg_generate로 KG 생성을 시작하세요(기본 1건씩 — 같은 명령 재실행 = 이어서 처리).'
      : '기수집분은 요청 없이 건너뜁니다 — kg_status로 파이프라인 상태를 확인하세요.';
  }
  return { status, lines, next };
}

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 */
export function registerCollectWeb(server) {
  server.registerTool(
    'collect_web',
    {
      title: '웹 자료 수집 (S1)',
      description:
        '시작 URL부터 같은 등록 도메인 안을 BFS로 돌며 max_pages까지 수집해 Input/에 MD로 저장한다. '
        + 'robots.txt와 요청 간격을 지킨다. 기수집 페이지는 요청 없이 건너뛰므로 '
        + '**같은 명령 재실행 = 이어서 수집**이다. force = 기수집분도 다시 받아 기존 파일명에 덮어쓴다.',
      inputSchema: {
        url: z.string().describe('시작 URL (예: https://example.com/)'),
        max_pages: z.number().int().min(1).optional()
          .describe(`시도할 페이지 수 상한 — 기본 ${MAX_PAGES_DEFAULT}(시작 페이지 포함)`),
        force: z.boolean().optional().describe('기수집분 강제 재수집(기존 파일명에 덮어씀)'),
      },
      annotations: {
        readOnlyHint: false, // Input/·원장을 쓴다
        destructiveHint: false, // 추가 전용 — 제거는 source_remove의 몫
        idempotentHint: true, // 재실행 = 기수집 스킵·이어서 수집(§2.4.4)
        openWorldHint: true, // 외부 웹(Jina 리더·robots.txt) 호출
      },
    },
    async ({ url, max_pages, force }) => {
      let s;
      try {
        s = await collectWeb({ url, maxPages: max_pages, force: Boolean(force) });
      } catch (err) {
        return toolContent(
          buildSummary({
            tool: 'collect_web', status: '실패', lines: [err.message],
            next: 'URL을 확인해 다시 시도하세요 (예: https://example.com/).',
          }),
          { error: err.message },
        );
      }
      const { status, lines, next } = summarizeCollectWeb(s);
      return toolContent(buildSummary({ tool: 'collect_web', status, lines, next }), s);
    },
  );
}
