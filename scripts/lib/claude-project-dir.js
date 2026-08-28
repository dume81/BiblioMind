// Claude Code가 프로젝트 절대경로를 ~/.claude/projects/ 하위 폴더명으로 바꾸는 규약의 단일 구현.
// 규약은 비공개 구현 세부라 문서가 없다 — 이 PC의 실물 폴더명 대조(2026-08-28)로 확정했고,
// 테스트(claude-project-dir.test.js)가 그 실측값을 정답으로 고정한다.

/**
 * 프로젝트 절대경로 → 대화 기록 폴더명. 영숫자(ASCII) 외 모든 문자를 각각 '-' 하나로
 * 치환한다 — 연속이어도 축약하지 않는다(한글 경로 실측 근거).
 * @param {string} absPath 프로젝트 루트 절대경로 (예: 'C:\\...\\GraphRAG_1st')
 * @returns {string} ~/.claude/projects/ 하위 폴더명
 */
export function claudeProjectDirName(absPath) {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}
