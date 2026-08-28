import { describe, expect, it } from 'vitest';
import { toJsonSafe, propertiesToJsonSafe } from '../server/core/neo4jValues.js';

// neo4j-driver의 Integer와 동일한 인터페이스를 가진 테스트 대역.
class FakeInteger {
  constructor(stringValue, safe) {
    this.stringValue = stringValue;
    this.safe = safe;
  }
  toNumber() {
    return Number(this.stringValue);
  }
  inSafeRange() {
    return this.safe;
  }
  toString() {
    return this.stringValue;
  }
}

function fakeTemporal(str, fields) {
  return { ...fields, toString: () => str };
}

describe('toJsonSafe', () => {
  it('안전 범위 Integer는 number로 변환한다', () => {
    expect(toJsonSafe(new FakeInteger('42', true))).toBe(42);
  });

  it('안전 범위를 넘는 Integer는 10진 문자열로 변환한다', () => {
    expect(toJsonSafe(new FakeInteger('9007199254740993', false))).toBe('9007199254740993');
  });

  it('날짜·시간 값은 문자열로 변환한다', () => {
    const date = fakeTemporal('2024-05-01', { year: 2024, month: 5, day: 1 });
    expect(toJsonSafe(date)).toBe('2024-05-01');

    const time = fakeTemporal('13:45:00', { hour: 13, minute: 45, second: 0 });
    expect(toJsonSafe(time)).toBe('13:45:00');
  });

  it('기간(Duration)은 문자열로 변환한다', () => {
    const duration = fakeTemporal('P1M2DT3S', { months: 1, days: 2, seconds: 3, nanoseconds: 0 });
    expect(toJsonSafe(duration)).toBe('P1M2DT3S');
  });

  it('Point는 srid/x/y(z) 객체로 변환한다', () => {
    const point2d = { srid: new FakeInteger('4326', true), x: 12.5, y: 34.5 };
    expect(toJsonSafe(point2d)).toEqual({ srid: 4326, x: 12.5, y: 34.5 });

    const point3d = { srid: new FakeInteger('4979', true), x: 1, y: 2, z: 3 };
    expect(toJsonSafe(point3d)).toEqual({ srid: 4979, x: 1, y: 2, z: 3 });
  });

  it('배열과 map을 재귀적으로 변환한다', () => {
    const value = {
      list: [new FakeInteger('1', true), { nested: new FakeInteger('99999999999999999999', false) }],
      map: { deep: [fakeTemporal('2024-01-01', { year: 2024, month: 1, day: 1 })] },
    };
    expect(toJsonSafe(value)).toEqual({
      list: [1, { nested: '99999999999999999999' }],
      map: { deep: ['2024-01-01'] },
    });
  });

  it('원시 값과 null을 그대로 유지한다', () => {
    expect(toJsonSafe('text')).toBe('text');
    expect(toJsonSafe(true)).toBe(true);
    expect(toJsonSafe(3.14)).toBe(3.14);
    expect(toJsonSafe(null)).toBe(null);
    expect(toJsonSafe(undefined)).toBe(null);
  });

  it('BigInt는 문자열로 변환한다', () => {
    expect(toJsonSafe(123n)).toBe('123');
  });

  it('직렬화 불가능한 값(함수)은 null로 처리한다', () => {
    expect(toJsonSafe(() => {})).toBe(null);
  });
});

describe('propertiesToJsonSafe', () => {
  it('객체가 아닌 입력은 빈 객체로 처리한다', () => {
    expect(propertiesToJsonSafe(null)).toEqual({});
    expect(propertiesToJsonSafe(undefined)).toEqual({});
  });

  it('빈 properties는 빈 객체로 유지한다 (값을 임의로 채우지 않음)', () => {
    expect(propertiesToJsonSafe({})).toEqual({});
  });
});
