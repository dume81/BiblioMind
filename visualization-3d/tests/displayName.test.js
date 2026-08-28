import { describe, expect, it } from 'vitest';
import { getNodeDisplayName } from '../src/lib/displayName.js';

describe('getNodeDisplayName', () => {
  it('properties.name → title → label → node.id 우선순위를 따른다', () => {
    expect(getNodeDisplayName({ id: 'N1', properties: { name: '이름', title: '제목', label: '라벨' } })).toBe('이름');
    expect(getNodeDisplayName({ id: 'N1', properties: { title: '제목', label: '라벨' } })).toBe('제목');
    expect(getNodeDisplayName({ id: 'N1', properties: { label: '라벨' } })).toBe('라벨');
    expect(getNodeDisplayName({ id: 'N1', properties: {} })).toBe('N1');
  });

  it('빈 문자열은 건너뛴다', () => {
    expect(getNodeDisplayName({ id: 'N1', properties: { name: '  ', title: '제목' } })).toBe('제목');
  });

  it('원본 속성을 변경하지 않는다', () => {
    const node = Object.freeze({ id: 'N1', properties: Object.freeze({ name: '이름' }) });
    expect(getNodeDisplayName(node)).toBe('이름');
    expect(node.properties).toEqual({ name: '이름' });
  });
});
