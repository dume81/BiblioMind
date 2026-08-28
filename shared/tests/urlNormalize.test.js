import { describe, it, expect } from 'vitest';
import { normalizeUrl } from '../src/urlNormalize.js';

describe('normalizeUrl (§2.4.4)', () => {
  it('scheme·host 소문자화 + 기본 포트 제거 + fragment 제거 + 추적 파라미터 제거 + 쿼리 정렬 — 경로 대소문자는 보존', () => {
    expect(normalizeUrl('HTTPS://Blog.Example.COM:443/Post/42?utm_source=x&b=2&a=1#frag'))
      .toBe('https://blog.example.com/Post/42?a=1&b=2');
  });

  it('http 기본 포트 80 제거 + 경로 끝 슬래시 제거', () => {
    expect(normalizeUrl('http://x.com:80/a/')).toBe('http://x.com/a');
  });

  it('루트는 슬래시 유지 형태로 통일된다', () => {
    expect(normalizeUrl('https://x.com')).toBe(normalizeUrl('https://x.com/'));
    expect(normalizeUrl('https://x.com')).toBe('https://x.com/');
  });

  it('추적 파라미터만 있으면 쿼리 자체가 사라진다', () => {
    expect(normalizeUrl('https://x.com/a?utm_source=1&utm_medium=2')).toBe('https://x.com/a');
    expect(normalizeUrl('https://x.com/a?fbclid=abc')).toBe('https://x.com/a');
  });

  it('퍼센트 인코딩은 대문자로 통일하되 디코딩하지 않는다', () => {
    expect(normalizeUrl('https://x.com/%eb%b9%84%ec%9d%98')).toBe('https://x.com/%EB%B9%84%EC%9D%98');
  });

  it('쿼리 키 정렬 시 동일 키의 값 순서는 보존된다', () => {
    expect(normalizeUrl('https://x.com/a?b=2&a=1&a=0')).toBe('https://x.com/a?a=1&a=0&b=2');
  });

  it('멱등성: normalize(normalize(u)) === normalize(u)', () => {
    const inputs = [
      'HTTPS://Blog.Example.COM:443/Post/42?utm_source=x&b=2&a=1#frag',
      'https://x.com/%eb%b9%84%ec%9d%98',
      'http://x.com:80/a/',
      'https://x.com',
    ];
    for (const u of inputs) {
      expect(normalizeUrl(normalizeUrl(u))).toBe(normalizeUrl(u));
    }
  });
});
