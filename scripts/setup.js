#!/usr/bin/env node
// 최초 1회 부트스트랩 (TECH-SPEC §1.11) — 재실행 안전(멱등), 각 단계 독립.
// ① data/ 폴더 생성 ② 스키마 시드 복사 ③ .env 생성 ④ Node·CLI 점검
// ⑤ MCP 등록 명령 출력(절대경로) ⑥ Neo4j AuraDB 접속 점검(.env에 값이 있을 때만)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, SCHEMA_DEFAULT_FILE, ensureDataDirs, dataPaths } from '../shared/src/paths.js';
import { loadEnv } from '../shared/src/env.js';

const results = [];
const note = (step, ok, detail) => {
  results.push({ step, ok, detail });
};

// ── ① data/ 하위 폴더 전체 생성 (멱등) ──────────────────────────────
try {
  const p = ensureDataDirs();
  note('data/ 폴더 생성', true, path.relative(REPO_ROOT, p.root) || p.root);
} catch (err) {
  note('data/ 폴더 생성', false, err.message);
}

// ── ② 스키마 시드 → data/schema.json (없을 때만 — 덮어쓰기 금지) ──────
try {
  const { schemaFile } = dataPaths();
  if (fs.existsSync(schemaFile)) {
    note('전역 스키마 사본', true, '이미 존재 — 유지(자동 등재분 보존)');
  } else {
    fs.copyFileSync(SCHEMA_DEFAULT_FILE, schemaFile);
    note('전역 스키마 사본', true, 'schema.default.json → data/schema.json 복사');
  }
} catch (err) {
  note('전역 스키마 사본', false, err.message);
}

// ── ③ .env.example → .env (없을 때만 — 덮어쓰기 금지) ────────────────
const envFile = path.join(REPO_ROOT, '.env');
try {
  if (fs.existsSync(envFile)) {
    note('.env', true, '이미 존재 — 유지');
  } else {
    fs.copyFileSync(path.join(REPO_ROOT, '.env.example'), envFile);
    note('.env', true, '.env.example 복사 — AuraDB 접속 정보를 채워 주세요');
  }
} catch (err) {
  note('.env', false, err.message);
}

// ── ④ Node 버전 + 엔진 CLI 존재 점검 ────────────────────────────────
// CLI 점검은 where.exe/which의 종료 코드만 쓴다 — stderr는 코드페이지 문제로 출력 금지.
const nodeMajorMinor = process.versions.node.split('.').map(Number);
const nodeOk = nodeMajorMinor[0] > 22 || (nodeMajorMinor[0] === 22 && nodeMajorMinor[1] >= 12);
note('Node.js', nodeOk, `v${process.versions.node} (요구 >=22.12)`);

/** @param {string} bin @returns {boolean} */
function cliExists(bin) {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  const r = spawnSync(finder, [bin], { stdio: 'ignore' });
  return r.status === 0;
}
for (const bin of ['codex', 'claude']) {
  const exists = cliExists(bin);
  note(
    `${bin} CLI`,
    exists,
    exists
      ? '설치됨 — 로그인 여부는 CLI를 직접 실행해 확인하세요'
      : '미설치 — S3 생성 슬라이스 전까지만 설치하면 됩니다 (사용자 액션)',
  );
}

// ── ④-b 커밋 전 가드 훅 활성화 (멱등 — 2026-08-22 재발 방지 결정 2) ──
// .git/hooks는 버전 관리가 안 돼 클론하면 사라진다. 커밋되는 .githooks/를 두고
// core.hooksPath로 가리킨다. 이미 같은 값이면 아무것도 하지 않는다.
try {
  const hooksDir = path.join(REPO_ROOT, '.githooks');
  if (!fs.existsSync(path.join(hooksDir, 'pre-commit'))) {
    note('커밋 전 가드 훅', false, '.githooks/pre-commit 없음 — 저장소가 손상됐거나 구버전입니다');
  } else {
    const read = spawnSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd: REPO_ROOT, encoding: 'utf8',
    });
    const current = (read.stdout || '').trim();
    if (current === '.githooks') {
      note('커밋 전 가드 훅', true, '이미 활성 — core.hooksPath=.githooks');
    } else {
      const w = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], {
        cwd: REPO_ROOT, encoding: 'utf8',
      });
      note('커밋 전 가드 훅', w.status === 0,
        w.status === 0
          ? `활성화 — core.hooksPath=.githooks${current ? ` (이전 값 "${current}" 대체)` : ''}`
          : `설정 실패: ${(w.stderr || '').trim() || 'git 명령 실패'}`);
    }
  }
} catch (err) {
  note('커밋 전 가드 훅', false, err.message);
}

// ── ⑤ MCP 등록 명령 출력 (절대경로 자동 치환) ────────────────────────
const serverEntry = path.join(REPO_ROOT, 'mcp-server', 'src', 'index.js');
note('MCP 등록 명령', true, '아래 출력 참조');

// ── ⑥ Neo4j AuraDB 접속 점검 (.env에 실제 값이 있을 때만) ─────────────
loadEnv();
const uri = process.env.NEO4J_URI || '';
const password = process.env.NEO4J_PASSWORD || '';
const unset = uri === '' || password === '' || password === 'replace-me';
if (unset) {
  note('Neo4j AuraDB', true, '미설정 — 슬라이스 0.5에서 AuraDB 무료 인스턴스 생성 후 .env 입력(정상 상태)');
} else {
  const neo4j = await import('neo4j-driver').then((m) => m.default ?? m).catch(() => null);
  if (!neo4j) {
    note('Neo4j AuraDB', false, 'neo4j-driver 미설치 — 저장소 루트에서 npm install을 먼저 실행하세요');
  } else {
    let driver;
    try {
      driver = neo4j.driver(uri, neo4j.auth.basic(process.env.NEO4J_USERNAME || 'neo4j', password));
      await driver.verifyConnectivity({ database: process.env.NEO4J_DATABASE || 'neo4j' });
      note('Neo4j AuraDB', true, '접속 성공');
    } catch (err) {
      const hint = /unavailable|routing|ServiceUnavailable/i.test(String(err?.message))
        ? ' — AuraDB 무료 인스턴스는 장기 미사용 시 일시정지될 수 있습니다. console.neo4j.io에서 인스턴스 상태(Resume)를 확인하세요'
        : '';
      note('Neo4j AuraDB', false, `접속 실패: ${err.message}${hint}`);
    } finally {
      await driver?.close().catch(() => {});
    }
  }
}

// ── 결과표 출력 ──────────────────────────────────────────────────────
console.log('\n[bibliomind] setup 결과 (재실행 안전 — 몇 번을 실행해도 같은 상태로 수렴)');
console.log('─'.repeat(72));
for (const { step, ok, detail } of results) {
  console.log(`${ok ? '✓' : '✗'}  ${step.padEnd(14)} ${detail}`);
}
console.log('─'.repeat(72));
console.log('\n[MCP 등록 — 1회성 사용자 액션]');
console.log('Claude Code(권장 — 스파이크 표면): 저장소 루트에서 Claude Code를 열면 .mcp.json이 자동 안내됩니다.');
console.log('  ※ 상위 폴더에서 열면 .mcp.json이 적용되지 않습니다 — 그 경우 아래 명령 사용(claude CLI 필요):');
console.log(`  claude mcp add bibliomind -- node "${serverEntry}"`);
console.log('\nClaude Desktop(후순위 대안): %APPDATA%\\Claude\\claude_desktop_config.json 의 mcpServers에 추가 후 앱 재시작:');
console.log('  "bibliomind": { "command": "node", "args": [' + JSON.stringify(serverEntry) + '] }');
console.log('\nCodex(데스크탑 앱·CLI 공용): %USERPROFILE%\\.codex\\config.toml 에 추가 후 재시작:');
console.log('  [mcp_servers.bibliomind]');
console.log('  command = "node"');
console.log(`  args = ['${serverEntry}']`);
console.log('\n등록 직후 자가검증: npm run mcp:smoke  (Tools 목록에 kg_status가 보이면 정상)');
