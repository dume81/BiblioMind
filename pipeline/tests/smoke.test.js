// 스캐폴딩 스모크 — 워크스페이스가 테스트 순회에 실제 참여함을 보인다(--if-present 무음 스킵 방지).
import { describe, it, expect } from 'vitest';
import { collectWeb } from '../src/crawl/index.js';
import { collectDocs } from '../src/extract/index.js';
import { generateKg } from '../src/generate/index.js';
import { rebuildGraph } from '../src/inject/index.js';
import { loadLedger } from '../src/ledger.js';

describe('pipeline 스텁 표면', () => {
  it('스텁 5종이 함수로 export된다', () => {
    for (const fn of [collectWeb, collectDocs, generateKg, rebuildGraph, loadLedger]) {
      expect(typeof fn).toBe('function');
    }
  });

  // 2026-08-23: **이 시험은 대상이 소멸해 삭제했다.**
  //   원래 명제 = "미구현 스텁이 조용히 성공하지 않고 안내와 함께 거부되는가".
  //   대상은 generateKg(슬라이스 5-A) → rebuildGraph(슬라이스 7)로 옮겨 다녔고,
  //   슬라이스 7로 **pipeline에 남은 스텁이 0개**가 되어 잴 것이 없어졌다.
  //   시험을 통과시키려고 명제를 무르게 바꾼 것이 아니라, 명제가 참조하던 물건이 없어진 것이다.
  //   (위 export 표면 시험은 그대로 둔다 — 5종이 함수로 노출되는지는 여전히 잴 값이 있다.)
});
