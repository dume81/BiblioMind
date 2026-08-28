#!/usr/bin/env node
// 수동 실행·디버그용 CLI — MCP 우회 수단 (TECH-SPEC §1.8).
// S1(웹 수집)과 S2(문서 추출)를 함께 다룬다 — 정본 §1.6의 bin 목록이 이 배치를 정한다.
//
// 사용:
//   웹  node pipeline/bin/collect.js <url> [--max-pages 10] [--force] [--json]
//   문서 node pipeline/bin/collect.js <파일경로.pdf|.png|…> [--force] [--json]
// 대상이 http(s)로 시작하면 웹 수집, 아니면 문서 추출로 보낸다.
// 종료 코드: 0 = 실행 완료(실패 페이지가 있어도 0 — 재시도는 다음 실행의 몫) / 2 = 인자·전제 오류

import { collectWeb, formatSummary, MAX_PAGES_DEFAULT } from '../src/crawl/index.js';
import { collectDocs, formatExtractSummary } from '../src/extract/index.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i > -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const FLAG_VALUES = new Set([value('--max-pages', null)].filter(Boolean));
const target = argv.find((a) => !a.startsWith('--') && !FLAG_VALUES.has(a));
if (!target) {
  console.error('사용:');
  console.error('  웹   node pipeline/bin/collect.js <url> [--max-pages 10] [--force] [--json]');
  console.error('  문서 node pipeline/bin/collect.js <파일경로.pdf|.png> [--force] [--json]');
  process.exit(2);
}

const isWeb = /^https?:\/\//i.test(target);

try {
  if (isWeb) {
    const maxPages = Number(value('--max-pages', MAX_PAGES_DEFAULT));
    if (!Number.isInteger(maxPages) || maxPages < 1) {
      console.error(`✗ --max-pages는 1 이상의 정수여야 합니다: ${value('--max-pages', '')}`);
      process.exit(2);
    }
    const summary = await collectWeb({ url: target, maxPages, force: flag('--force') });
    if (flag('--json')) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(formatSummary(summary));
      console.log('');
      for (const p of summary.pages) {
        const tail = p.file ? `  → ${p.file}` : p.reason ? `  — ${p.reason}` : p.sameAs ? `  = ${p.sameAs}` : '';
        console.log(`  [${p.result}] ${p.url}${tail}`);
      }
    }
  } else {
    const result = await collectDocs({ path: target, force: flag('--force') });
    console.log(flag('--json') ? JSON.stringify(result, null, 2) : formatExtractSummary(result));
  }
} catch (err) {
  console.error(`✗ ${isWeb ? '수집' : '추출'} 실패: ${err.message}`);
  process.exit(2);
}
