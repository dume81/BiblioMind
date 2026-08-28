// T2 점수 하한 단위 테스트 (유지보수 M2 · TECH-SPEC §6.3 단계 2).
// 개선 전 골든 픽스처의 실측 원점수(t2RawScores)에 상수를 적용해 판정한다 — DB 불요.
// 케이스 번호는 M2-DESIGN.md §5-3 표와 1:1 대응.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SEEDS_MIN_SCORE_RATIO } from '../src/lib/searchEngine.js';

// cwd 기준 경로 금지 — import.meta.url 앵커
const GOLDEN = JSON.parse(readFileSync(new URL('../fixtures/golden-searches.json', import.meta.url), 'utf8'));

/** 런타임과 같은 판정식(raw >= top × ratio)을 픽스처 원점수에 적용한다. */
function applyFloor(probe) {
  const top = probe.hits.reduce((max, h) => Math.max(max, h.score), 0);
  const floor = top * SEEDS_MIN_SCORE_RATIO;
  return {
    kept: probe.hits.filter((h) => h.score >= floor),
    cut: probe.hits.filter((h) => h.score < floor),
  };
}

describe('T2 점수 하한 — 상수와 실측 대조', () => {
  it('#1 하한 비율 상수는 오너 확정값 50%다', () => {
    expect(SEEDS_MIN_SCORE_RATIO).toBe(0.5);
  });

  it('#2 네즈코 — 하가네즈카 호타루 1건만 탈락하고 정탐 4건이 생존한다', () => {
    const { kept, cut } = applyFloor(GOLDEN.t2RawScores['네즈코']);
    expect(kept.map((h) => h.kgid).sort()).toEqual(
      [
        'n_691d4dc82874a1c3', // 카마도 네즈코 (1.6334)
        'n_bf66ca5b78cc47f0', // 네즈코의 도깨비화 (1.3561)
        'n_a45effd08fb519bd', // 네즈코의 탄지로 공격 (1.3561)
        'n_1be68e8ea0ddbf02', // 기유가 네즈코에게 재갈을 물린 사건 (1.0123)
      ].sort(),
    );
    expect(cut.map((h) => h.kgid)).toEqual(['n_69fdefdb99c1eb70']); // 하가네즈카 호타루
    expect(cut[0].ratioToTop).toBeCloseTo(0.3919, 4);
  });

  it('#3 비율 하한에서는 어떤 키워드도 생존 0건이 되지 않는다 (1위 자신의 비율 = 1.0)', () => {
    const empties = [];
    for (const [keyword, probe] of Object.entries(GOLDEN.t2RawScores)) {
      if (!probe.hits || probe.hits.length === 0) continue;
      if (applyFloor(probe).kept.length < 1) empties.push(keyword);
    }
    expect(empties).toEqual([]);
  });

  it('#4 재갈 함정 — T2 하한에 걸릴 후보가 있어도 워터폴이 T1에서 단락돼 도달하지 않는다', () => {
    expect(GOLDEN.t2RawScores['재갈'].wouldCutAt50).not.toEqual([]);
    const s14 = GOLDEN.cases.find((c) => c.id === 'S14');
    expect(s14.keywords).toEqual(['재갈']);
    expect(s14.seeds[0].tier).toBe('T1');
  });
});
