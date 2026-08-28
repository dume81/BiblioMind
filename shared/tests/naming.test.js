import { describe, it, expect } from 'vitest';
import { sanitizeWindowsName, buildStem, kgFileName, rejectedFileName } from '../src/naming.js';

describe('sanitizeWindowsName — Windows 금지 문자·예약 이름·길이 (§1.13-4·5)', () => {
  it('금지 문자 콜론을 치환하고 원제목 보존은 하지 않는다(프론트매터 몫)', () => {
    expect(sanitizeWindowsName('원제목 전체: 부제')).toBe('원제목 전체_ 부제');
  });

  it('금지 문자 9종 전부 치환 — 백슬래시 포함', () => {
    expect(sanitizeWindowsName('a<b>c:d"e/f\\g|h?i*j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });

  it('예약 이름은 대소문자 무시로 회피한다', () => {
    for (const name of ['CON', 'con', 'Aux', 'COM9', 'LPT1', 'NUL']) {
      const out = sanitizeWindowsName(name);
      expect(out).not.toMatch(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i);
      expect(out).toBe(name + '_');
    }
  });

  it('끝 마침표·공백을 제거한다', () => {
    expect(sanitizeWindowsName('제목.')).toBe('제목');
    expect(sanitizeWindowsName('제목 ')).toBe('제목');
  });

  it('한글 90자는 80 코드포인트로 절단 후 끝 문자 재검사', () => {
    const long = '가'.repeat(89) + '.';
    const out = sanitizeWindowsName(long);
    expect(Array.from(out).length).toBe(80);
    expect(out).toBe('가'.repeat(80));
  });

  it('한글 이름은 무변경 통과', () => {
    expect(sanitizeWindowsName('지식그래프_비블리오마인드')).toBe('지식그래프_비블리오마인드');
  });

  it('제어 문자(0x00–0x1F)는 치환이 아니라 제거된다', () => {
    expect(sanitizeWindowsName('\u0001제목\u001f')).toBe('제목');
  });

  it('전부 지워지면 untitled 폴백', () => {
    expect(sanitizeWindowsName(' . ')).toBe('untitled');
  });
});

describe('stem 연쇄 (§2.4.2)', () => {
  it('buildStem — 배치 타임스탬프 + 메인이름 + 페이지 번호', () => {
    expect(buildStem('20260821143012', 'bibliomind', 1)).toBe('20260821143012_bibliomind_p01');
  });

  it('kgFileName — 1:1 고정 파생', () => {
    expect(kgFileName('20260821143012_bibliomind_p01')).toBe('20260821143012_bibliomind_p01.kg.json');
  });

  it('rejectedFileName — 반려 회차 접미사', () => {
    expect(rejectedFileName('20260821143012_bibliomind_p01', 2)).toBe('20260821143012_bibliomind_p01.kg.rej2.json');
  });
});
