import { describe, it, expect } from 'vitest';
import { nameKey, nodeKgid, relKgid } from '../src/normalize.js';

describe('nameKey — NFC → trim → 공백 축약 → 소문자화 (§2.3.2)', () => {
  it('기본 한글 이름은 그대로', () => {
    expect(nameKey('카마도 탄지로')).toBe('카마도 탄지로');
  });

  it('양끝 공백 제거 + 내부 연속 공백·탭 축약', () => {
    expect(nameKey('  카마도   탄지로\t')).toBe('카마도 탄지로');
  });

  it('NBSP·전각 공백도 축약된다', () => {
    expect(nameKey('카마도 탄지로')).toBe('카마도 탄지로');
    expect(nameKey('카마도　탄지로')).toBe('카마도 탄지로');
  });

  it('NFD 분해 입력은 NFC 결합으로 통일된다', () => {
    expect(nameKey('카마도 탄지로'.normalize('NFD'))).toBe(nameKey('카마도 탄지로'));
  });

  it('NFKC 미적용 — 전각 영문은 반각으로 폴딩되지 않는다 (과병합 방지)', () => {
    expect(nameKey('Ａpple')).toBe('ａpple'); // 전각 Ａ → 전각 ａ (소문자화만)
    expect(nameKey('Ａpple')).not.toBe('apple');
  });

  it('영문 소문자화, 한글 무영향', () => {
    expect(nameKey('Demon Slayer')).toBe('demon slayer');
  });

  it('멱등성: nameKey(nameKey(x)) === nameKey(x)', () => {
    for (const input of ['카마도 탄지로', '  A  B  ', 'Ａpple', 'Demon Slayer']) {
      expect(nameKey(nameKey(input))).toBe(nameKey(input));
    }
  });
});

describe('kgid — 콘텐츠 안정 식별자 (§3.5)', () => {
  it('노드 kgid 형식·결정성', () => {
    const kgid = nodeKgid('Person', nameKey('카마도 탄지로'));
    expect(kgid).toMatch(/^n_[0-9a-f]{16}$/);
    expect(nodeKgid('Person', nameKey('카마도 탄지로'))).toBe(kgid); // 재계산 동일
  });

  it('실측 벡터 (전문가 패널 Node 실행 확정값)', () => {
    const tanjiro = nodeKgid('Person', nameKey('카마도 탄지로'));
    const corps = nodeKgid('Organization', nameKey('귀살대'));
    expect(tanjiro).toBe('n_bcfe481dc38bafcd');
    expect(corps).toBe('n_94e28cbc43bb5264');
    expect(relKgid(tanjiro, 'MEMBER_OF', corps)).toBe('r_6bb0fff48ffddc38');
    expect(relKgid(corps, 'MEMBER_OF', tanjiro)).toBe('r_7e80d2a8b99fd3bc');
  });

  it('관계 kgid는 방향성을 보존한다', () => {
    const a = nodeKgid('Person', 'a');
    const b = nodeKgid('Person', 'b');
    expect(relKgid(a, 'KNOWS', b)).not.toBe(relKgid(b, 'KNOWS', a));
  });

  it('name은 name_key 경유 — 대소문자만 다르면 같은 kgid', () => {
    expect(nodeKgid('Person', nameKey('Kim'))).toBe(nodeKgid('Person', nameKey('kim')));
  });

  it('라벨은 원형 사용 — 소문자화 금지 (라벨이 다르면 다른 kgid)', () => {
    expect(nodeKgid('Person', 'kim')).not.toBe(nodeKgid('PERSON', 'kim'));
  });

  it('US 구분자가 경계 충돌을 막는다: ("AB","c") ≠ ("A","Bc")', () => {
    expect(nodeKgid('AB', 'c')).not.toBe(nodeKgid('A', 'Bc'));
  });
});
