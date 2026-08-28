import { describe, it, expect } from 'vitest';
import { decomposeSyllable, toJamoUnits, jamoEditDistance } from '../src/hangul.js';

/** 편의 — 문자열 두 개의 자모 편집거리 */
const dist = (a, b, max = 3) => jamoEditDistance(toJamoUnits(a), toJamoUnits(b), max);

describe('decomposeSyllable — 완성형 음절 → 초·중·종성 (§6.2.3)', () => {
  it('실측 손상 사례 1: 륜(U+B95C) 종성 4 → 륨(U+B968) 종성 16, 초·중성 보존', () => {
    expect(decomposeSyllable('륜')).toEqual({ cho: 5, jung: 17, jong: 4 });
    expect(decomposeSyllable('륨')).toEqual({ cho: 5, jung: 17, jong: 16 });
  });

  it('실측 손상 사례 2: 혈(U+D608) 종성 8 → 혐(U+D610) 종성 16, 초·중성 보존', () => {
    expect(decomposeSyllable('혈')).toEqual({ cho: 18, jung: 6, jong: 8 });
    expect(decomposeSyllable('혐')).toEqual({ cho: 18, jung: 6, jong: 16 });
  });

  it('종성 없는 음절은 jong = 0', () => {
    expect(decomposeSyllable('가')).toEqual({ cho: 0, jung: 0, jong: 0 });
    expect(decomposeSyllable('도')).toEqual({ cho: 3, jung: 8, jong: 0 });
  });

  it('음절 범위 경계: 가(U+AC00)·힣(U+D7A3)은 분해되고 그 밖은 null', () => {
    expect(decomposeSyllable('가')).not.toBeNull();
    expect(decomposeSyllable('힣')).not.toBeNull();
    expect(decomposeSyllable('꯿')).toBeNull();
    expect(decomposeSyllable('힤')).toBeNull();
  });

  it('비음절(영문·숫자·공백·자모 낱자·빈 문자열)은 null', () => {
    for (const ch of ['a', '1', ' ', 'ㄱ', 'ㅏ', '']) expect(decomposeSyllable(ch)).toBeNull();
  });
});

describe('toJamoUnits — 자모 토큰 배열 (접두 L/V/T로 리터럴과 충돌 방지)', () => {
  it('종성 있는 음절은 3토큰, 없으면 2토큰', () => {
    expect(toJamoUnits('일륜도')).toEqual(['L11', 'V20', 'T8', 'L5', 'V17', 'T4', 'L3', 'V8']);
    expect(toJamoUnits('일륨도')).toEqual(['L11', 'V20', 'T8', 'L5', 'V17', 'T16', 'L3', 'V8']);
  });

  it('혈귀 / 혐귀 — 종성만 다른 한 토큰', () => {
    expect(toJamoUnits('혈귀')).toEqual(['L18', 'V6', 'T8', 'L0', 'V16']);
    expect(toJamoUnits('혐귀')).toEqual(['L18', 'V6', 'T16', 'L0', 'V16']);
  });

  it('비음절 문자는 그 문자 자체가 1토큰 (공백·영문 혼재 보존)', () => {
    expect(toJamoUnits('a 가')).toEqual(['a', ' ', 'L0', 'V0']);
    expect(toJamoUnits('')).toEqual([]);
  });
});

describe('jamoEditDistance — 밴드 DP (상한 초과 시 maxDistance+1)', () => {
  it('실측 손상 2건은 모두 거리 1 (종성 단일 치환)', () => {
    expect(dist('일륨도', '일륜도')).toBe(1);
    expect(dist('혐귀', '혈귀')).toBe(1);
  });

  it('동일 문자열은 0, 상한 1에서도 0', () => {
    expect(dist('일륜도', '일륜도')).toBe(0);
    expect(jamoEditDistance(toJamoUnits('탄지로'), toJamoUnits('탄지로'), 1)).toBe(0);
  });

  it('탄지룸↔탄지로 = 2 (중성+종성) / 탄지롬↔탄지로 = 1 — 거리 1 상한이 전자를 배제한다', () => {
    expect(dist('탄지룸', '탄지로')).toBe(2);
    expect(dist('탄지롬', '탄지로')).toBe(1);
    expect(jamoEditDistance(toJamoUnits('탄지룸'), toJamoUnits('탄지로'), 1)).toBe(2);
  });

  it('길이 차가 상한을 넘으면 즉시 초과값 반환 (조기 탈출)', () => {
    expect(jamoEditDistance(toJamoUnits('가'), toJamoUnits('카마도 탄지로'), 1)).toBe(2);
  });

  it('상한 초과 시 반환값은 정확한 거리가 아니라 maxDistance+1 (초과 신호)', () => {
    expect(jamoEditDistance(toJamoUnits('귀살대'), toJamoUnits('일륜도'), 1)).toBe(2);
    expect(jamoEditDistance(toJamoUnits('귀살대'), toJamoUnits('일륜도'), 2)).toBe(3);
  });

  it('빈 배열 처리 — 상한 안이면 길이, 밖이면 초과값', () => {
    expect(jamoEditDistance([], [], 1)).toBe(0);
    expect(jamoEditDistance(toJamoUnits('가'), [], 3)).toBe(2);
    expect(jamoEditDistance(toJamoUnits('가'), [], 1)).toBe(2);
  });
});
