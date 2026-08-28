// claude-project-dir 회귀 테스트 — 실측 폴더명(~/.claude/projects/ 실물, 2026-08-28)을 정답으로 고정한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeProjectDirName } from './claude-project-dir.js';

test('Windows 경로 실측 재현 — 콜론·역슬래시·공백·밑줄이 각각 - 치환', () => {
  assert.equal(
    claudeProjectDirName('C:\\Users\\DUME\\Desktop\\Claude Code Workspace\\GraphRAG_1st'),
    'C--Users-DUME-Desktop-Claude-Code-Workspace-GraphRAG-1st',
  );
});

test('mcp-server 하위 경로도 같은 규약으로 산출된다', () => {
  assert.equal(
    claudeProjectDirName('C:\\Users\\DUME\\Desktop\\Claude Code Workspace\\GraphRAG_1st\\mcp-server'),
    'C--Users-DUME-Desktop-Claude-Code-Workspace-GraphRAG-1st-mcp-server',
  );
});

test('POSIX 절대경로는 선행 -로 시작한다 (타 PC 이식 대상 형태)', () => {
  assert.equal(claudeProjectDirName('/Users/x/GraphRAG_1st'), '-Users-x-GraphRAG-1st');
});

test('영숫자 외 문자는 연속이어도 하나로 축약하지 않는다 — 비ASCII 실측 근거', () => {
  // 실측: 한글이 든 경로가 'Cluade-------------'처럼 글자당 - 1개로 남는다.
  assert.equal(claudeProjectDirName('한글'), '--');
  assert.equal(claudeProjectDirName('a_b c.d'), 'a-b-c-d');
});
