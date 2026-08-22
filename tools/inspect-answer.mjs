// 판정 보조 — 특정 질문의 도구 내역(시드·계층·1층 규모·인용 검증)을 대화 기록에서 추출한다.
// 이사님이 챗 화면에서 "사용함 도구"를 펼치지 않아도 ②시드 계층이 확정 판정된다.
//
// 사용: node bibliomind/tools/inspect-answer.mjs "우로코다키"

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const needle = process.argv[2];
if (!needle) {
  console.error('사용법: node bibliomind/tools/inspect-answer.mjs "질문 일부"');
  process.exit(1);
}

const ROOT = join(homedir(), '.claude', 'projects');
const DIRS = [
  'C--Users-DUME-Desktop-Claude-Code-Workspace-GraphRAG-1st',
  'C--Users-DUME-Desktop-Claude-Code-Workspace-GraphRAG-1st-mcp-server',
];

const files = [];
for (const dir of DIRS) {
  const path = join(ROOT, dir);
  if (!existsSync(path)) continue;
  for (const f of readdirSync(path).filter((x) => x.endsWith('.jsonl'))) {
    files.push({ full: join(path, f), mtime: statSync(join(path, f)).mtimeMs });
  }
}
files.sort((a, b) => b.mtime - a.mtime); // 최신 세션부터

const resultText = (part) =>
  typeof part.content === 'string'
    ? part.content
    : Array.isArray(part.content)
      ? part.content.map((c) => c.text || '').join('\n')
      : '';

let found = 0;
for (const { full } of files) {
  const rows = readFileSync(full, 'utf8')
    .split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  let active = false;
  for (const row of rows) {
    const content = row.message?.content;
    const at = row.timestamp ? new Date(Date.parse(row.timestamp) + 9 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ') : '';

    if (row.type === 'user' && typeof content === 'string' && !content.startsWith('<')) {
      active = content.includes(needle);
      if (active) {
        found += 1;
        console.log(`\n=== [${at}] ${content.trim().slice(0, 60)} ===`);
      }
      continue;
    }
    if (!active || !Array.isArray(content)) continue;

    for (const part of content) {
      if (part.type === 'tool_use' && /kg_(search|cite)/.test(part.name || '')) {
        console.log(`  → ${part.name.replace(/^.*__/, '')} ${JSON.stringify(part.input).slice(0, 120)}`);
      }
      if (part.type === 'tool_result') {
        const body = resultText(part);
        if (!/bibliomind/.test(body)) continue;
        // 요약 줄 + seeds 블록만 발췌
        body.split('\n').filter((l) => /상태:|시드|인용|과잉|그래프에 없는|절단|viewer|delivered/.test(l))
          .slice(0, 6).forEach((l) => console.log(`     ${l.trim().slice(0, 110)}`));
        const seeds = body.match(/"seeds":\s*\[[\s\S]*?\n\s{2}\]/);
        if (seeds) console.log('     seeds:', seeds[0].replace(/\s+/g, ' ').slice(0, 200));
        const counts = body.match(/"counts":\s*\{[^}]*\}/);
        if (counts) console.log('     ' + counts[0].replace(/\s+/g, ' '));
      }
    }
  }
  if (found) break; // 가장 최근 세션의 결과만
}

if (!found) console.log(`"${needle}" 을 포함한 질문을 찾지 못했습니다.`);
