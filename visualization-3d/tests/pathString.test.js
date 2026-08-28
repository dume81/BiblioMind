import { describe, expect, it } from 'vitest';
import { looksLikeFilePath } from '../src/lib/pathString.js';

describe('looksLikeFilePath', () => {
  it('Windows 경로·fakepath·file URL을 감지한다', () => {
    expect(looksLikeFilePath('C:\\Users\\me\\graph.json')).toBe(true);
    expect(looksLikeFilePath('C:\\fakepath\\graph.json')).toBe(true);
    expect(looksLikeFilePath('C:/Users/me/graph.json')).toBe(true);
    expect(looksLikeFilePath('file:///C:/graph.json')).toBe(true);
    expect(looksLikeFilePath('\\\\server\\share\\graph.json')).toBe(true);
    expect(looksLikeFilePath('  C:\\spaced.json  ')).toBe(true);
  });

  it('JSON 텍스트는 경로로 감지하지 않는다', () => {
    expect(looksLikeFilePath('{"nodes": [], "relationships": []}')).toBe(false);
    expect(looksLikeFilePath('')).toBe(false);
    expect(looksLikeFilePath('   ')).toBe(false);
  });
});
