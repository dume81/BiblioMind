// 원장 단위 테스트 (TECH-SPEC §2.4.4 · ROADMAP 슬라이스 3 완료 조건 "ledger 단위 테스트").
import { describe, it, expect } from 'vitest';
import {
  STATUS, LEDGER_VERSION, webKey, contentKey,
  getEntry, upsertEntry, shouldSkip, findByFinalHash,
} from '../src/ledger.js';

const empty = () => ({ version: LEDGER_VERSION, sources: {} });

describe('원장 키 (§2.4.4 — sha256 앞 16자)', () => {
  it('#1 웹 키는 **정규화 URL**의 해시다 — 추적 파라미터가 달라도 같은 키', () => {
    const a = webKey('https://Example.com/post/42?utm_source=x#frag');
    const b = webKey('https://example.com/post/42');
    expect(a.key).toBe(b.key);
    expect(a.normalized).toBe('https://example.com/post/42');
  });

  it('#2 키는 16자 16진수다', () => {
    expect(webKey('https://example.com/').key).toMatch(/^[0-9a-f]{16}$/);
    expect(contentKey('본문 내용')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('#3 다른 경로는 다른 키', () => {
    expect(webKey('https://example.com/a').key).not.toBe(webKey('https://example.com/b').key);
  });
});

describe('shouldSkip — 1차 스킵 판정 (요청을 보내기 전)', () => {
  it('#4 엔트리가 없으면 스킵하지 않는다', () => {
    expect(shouldSkip(null)).toEqual({ skip: false, reason: null });
  });

  it('#5 collected면 스킵한다 — "재실행 시 건너뛴다"의 체감 보장', () => {
    expect(shouldSkip({ status: STATUS.COLLECTED })).toEqual({ skip: true, reason: 'collected' });
  });

  it('#6 collected여도 --force면 다시 받는다', () => {
    expect(shouldSkip({ status: STATUS.COLLECTED }, { force: true })).toEqual({ skip: false, reason: null });
  });

  it('#7 failed는 자동 재시도 — 스킵하지 않는다 (PRD S1)', () => {
    expect(shouldSkip({ status: STATUS.FAILED, attempts: 3 })).toEqual({ skip: false, reason: null });
  });

  it('#8 **blocked는 --force를 이긴다** — 차단 해제는 명시적 명령으로만 (§2.4.4)', () => {
    expect(shouldSkip({ status: STATUS.BLOCKED }, { force: true })).toEqual({ skip: true, reason: 'blocked' });
  });
});

describe('upsertEntry — 기본값과 부분 병합', () => {
  it('#9 없는 키는 기본값으로 만들고 patch를 얹는다', () => {
    const l = empty();
    const e = upsertEntry(l, 'k1', { source: 'https://example.com/', status: STATUS.COLLECTED });
    expect(e.kind).toBe('web');
    expect(e.attempts).toBe(0);
    expect(e.reject_count).toBe(0);
    expect(e.status).toBe(STATUS.COLLECTED);
    expect(getEntry(l, 'k1')).toBe(e);
  });

  it('#10 기존 필드는 patch에 없으면 보존된다', () => {
    const l = empty();
    upsertEntry(l, 'k1', { file: 'a.md', reject_count: 2, attempts: 1 });
    const e = upsertEntry(l, 'k1', { attempts: 2 });
    expect(e.file).toBe('a.md');
    expect(e.reject_count).toBe(2);
    expect(e.attempts).toBe(2);
  });

  it('#11 없는 키 조회는 null', () => {
    expect(getEntry(empty(), 'nope')).toBeNull();
  });
});

describe('findByFinalHash — 2차 dedupe (리다이렉트로 같은 문서)', () => {
  it('#12 다른 진입 URL이 같은 final_hash면 그 키를 찾는다', () => {
    const l = empty();
    upsertEntry(l, 'entryA', { final_hash: 'ffff0000ffff0000', status: STATUS.COLLECTED, file: 'a.md' });
    expect(findByFinalHash(l, 'ffff0000ffff0000', 'entryB')).toBe('entryA');
  });

  it('#13 자기 자신은 제외한다 — --force 재수집이 자기와 중복 판정되면 안 된다', () => {
    const l = empty();
    upsertEntry(l, 'entryA', { final_hash: 'ffff0000ffff0000', status: STATUS.COLLECTED });
    expect(findByFinalHash(l, 'ffff0000ffff0000', 'entryA')).toBeNull();
  });

  it('#14 collected가 아닌 엔트리는 쌍둥이로 세지 않는다 — 실패분은 파일이 없다', () => {
    const l = empty();
    upsertEntry(l, 'entryA', { final_hash: 'ffff0000ffff0000', status: STATUS.FAILED });
    expect(findByFinalHash(l, 'ffff0000ffff0000', 'entryB')).toBeNull();
  });

  it('#15 final_hash가 없으면 null (수집 전 엔트리)', () => {
    expect(findByFinalHash(empty(), null, 'x')).toBeNull();
    expect(findByFinalHash(empty(), '', 'x')).toBeNull();
  });

  it('#16 **blocked 엔트리도 쌍둥이로 찾는다** — 새 진입 URL의 리다이렉트가 차단을 우회하면 안 된다 (v2.12)', () => {
    const l = empty();
    upsertEntry(l, 'entryA', { final_hash: 'ffff0000ffff0000', status: STATUS.BLOCKED, file: 'a.md' });
    expect(findByFinalHash(l, 'ffff0000ffff0000', 'entryB')).toBe('entryA');
  });
});
