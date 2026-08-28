// S2 문서 추출기 단위 테스트 (TECH-SPEC §1.5·§2.4.3 · ROADMAP 슬라이스 4).
// 네트워크·무거운 WASM은 건드리지 않는다 — 판정 순수 함수만 시험한다.
import { describe, it, expect } from 'vitest';
import { sourceTypeOf, judgeQuality, LOW_QUALITY_CHARS } from '../src/extract/index.js';

describe('sourceTypeOf — 확장자로 처리 경로를 가른다', () => {
  it('#1 PDF는 pdf 경로', () => {
    expect(sourceTypeOf('보고서.pdf')).toBe('pdf');
    expect(sourceTypeOf('C:\\자료\\REPORT.PDF')).toBe('pdf');
  });

  it('#2 이미지 확장자는 image 경로', () => {
    for (const f of ['a.png', 'a.jpg', 'a.jpeg', 'a.webp', 'a.bmp', 'a.tif', 'a.tiff']) {
      expect(sourceTypeOf(f)).toBe('image');
    }
  });

  it('#3 지원하지 않는 확장자는 null — 조용히 처리하지 않는다', () => {
    expect(sourceTypeOf('a.docx')).toBeNull();
    expect(sourceTypeOf('a.txt')).toBeNull();
    expect(sourceTypeOf('확장자없음')).toBeNull();
  });

  it('#4 대소문자·경로 구분자에 무관하다', () => {
    expect(sourceTypeOf('/tmp/dir.pdf/실제.PnG')).toBe('image');
  });
});

describe('judgeQuality — 베스트에포트 3값 (§1.5)', () => {
  it('#5 0자는 empty — 스캔본이거나 추출 실패', () => {
    expect(judgeQuality('')).toBe('empty');
    expect(judgeQuality('   \n\t ')).toBe('empty');
    expect(judgeQuality(null)).toBe('empty');
    expect(judgeQuality(undefined)).toBe('empty');
  });

  it('#6 임계 미만은 low', () => {
    expect(judgeQuality('짧다')).toBe('low');
    expect(judgeQuality('가'.repeat(LOW_QUALITY_CHARS - 1))).toBe('low');
  });

  it('#7 임계 이상은 ok — 경계값이 ok 쪽이다', () => {
    expect(judgeQuality('가'.repeat(LOW_QUALITY_CHARS))).toBe('ok');
    expect(judgeQuality('가'.repeat(LOW_QUALITY_CHARS + 500))).toBe('ok');
  });

  it('#8 앞뒤 공백은 글자 수에 세지 않는다', () => {
    const body = '가'.repeat(LOW_QUALITY_CHARS - 1);
    expect(judgeQuality(`\n\n   ${body}   \n`)).toBe('low');
  });

  it('#9 임계 상수는 200자다 — 값이 바뀌면 이 시험이 알려준다', () => {
    expect(LOW_QUALITY_CHARS).toBe(200);
  });
});
