// §4.1 공통 결과 요약 형식 빌더 — 모든 도구가 공유한다 (실패 보고 원칙).

/**
 * @param {{ tool: string, status: '성공'|'부분 성공'|'실패', lines?: string[], next?: string }} p
 * @returns {string}
 */
export function buildSummary({ tool, status, lines = [], next }) {
  return [
    `[bibliomind] ${tool} 결과 — 상태: ${status}`,
    ...lines,
    next ? `다음 행동: ${next}` : null,
    '위 요약을 사용자에게 그대로 전달하세요.',
  ].filter(Boolean).join('\n');
}

/**
 * 요약 + JSON 데이터 블록을 MCP content 배열로 조립한다.
 * @param {string} summary
 * @param {object} [data]
 */
export function toolContent(summary, data) {
  const content = [{ type: 'text', text: summary }];
  if (data !== undefined) {
    content.push({ type: 'text', text: '```json\n' + JSON.stringify(data, null, 2) + '\n```' });
  }
  return { content };
}
