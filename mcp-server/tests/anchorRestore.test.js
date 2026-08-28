// 앵커 복원 단위 테스트 (유지보수 M2 · TECH-SPEC §6.2.3).
// pickAnchorCandidate는 순수 함수 — DB·네트워크 불요. 케이스 번호는 M2-DESIGN.md §5-2 표와 1:1 대응.
import { describe, it, expect } from 'vitest';
import { pickAnchorCandidate } from '../src/lib/searchEngine.js';
import { restorationLines } from '../src/tools/kgSearch.js';

describe('pickAnchorCandidate — 실사고 재현 (완료조건 1)', () => {
  it('#1 손상 키워드 일륨도가 질문 원문의 일륜도로 복원된다', () => {
    expect(pickAnchorCandidate('일륨도', '일륜도가 뭐야?')).toBe('일륜도');
  });
});

describe('pickAnchorCandidate — 2글자 키워드는 복원 대상이 아니다 (완료조건 2 · 가드3)', () => {
  it('#2 혐귀 + 혈귀가 뭐야? → null', () => {
    expect(pickAnchorCandidate('혐귀', '혈귀가 뭐야?')).toBeNull();
  });

  it('#3 혐귀 + 혈귀는 무엇이야? → null', () => {
    expect(pickAnchorCandidate('혐귀', '혈귀는 무엇이야?')).toBeNull();
  });

  it('#4 E1 실제 호출 재현 — 혐귀 + 무잔은 누구야? → null', () => {
    expect(pickAnchorCandidate('혐귀', '무잔은 누구야?')).toBeNull();
  });
});

describe('pickAnchorCandidate — question 부재 시 무해 폴백 (완료조건 5 · 가드1)', () => {
  it('#5 question이 null이면 복원하지 않는다', () => {
    expect(pickAnchorCandidate('일륨도', null)).toBeNull();
  });

  it('#6 question이 undefined면 복원하지 않는다', () => {
    expect(pickAnchorCandidate('일륨도', undefined)).toBeNull();
  });

  it('#7 question이 빈 문자열이면 복원하지 않는다', () => {
    expect(pickAnchorCandidate('일륨도', '')).toBeNull();
  });
});

describe('pickAnchorCandidate — 축자 존재는 손상이 아니다 (가드4)', () => {
  it('#8 그래프에 없는 정당 키워드는 질문에 그대로 있으면 복원하지 않는다', () => {
    expect(pickAnchorCandidate('무잔', '무잔은 누구야?')).toBeNull();
  });

  it('#9 사용자 본인이 오타를 쳤으면 교정하지 않는다 — 정답은 "없습니다"', () => {
    expect(pickAnchorCandidate('일륨도', '검증: 일륨도')).toBeNull();
  });
});

describe('pickAnchorCandidate — 형태 가드', () => {
  it('#10 한글 음절+공백이 아닌 키워드는 대상이 아니다 (가드2)', () => {
    expect(pickAnchorCandidate('api', 'api key가 뭐야?')).toBeNull();
  });

  it('#11 2글자 오복원 방어 — 마음이 마을로 바뀌지 않는다 (가드3)', () => {
    expect(pickAnchorCandidate('마음', '탄지로가 살던 마을은 어떻게 됐어?')).toBeNull();
  });

  it('#12 공백은 창 내부 문자로 취급된다 — 전집중 호흠 → 전집중 호흡', () => {
    expect(pickAnchorCandidate('전집중 호흠', '전집중 호흡이 뭐야?')).toBe('전집중 호흡');
  });

  it('#13 긴 키워드도 복원된다 — 우로코다키 사콘디 → 우로코다키 사콘지', () => {
    expect(pickAnchorCandidate('우로코다키 사콘디', '우로코다키 사콘지는 누구야?')).toBe('우로코다키 사콘지');
  });
});

describe('pickAnchorCandidate — 후보가 0건이거나 모호하면 복원하지 않는다', () => {
  it('#14 거리 1 후보가 2종이면 모호로 판정한다 (가드6)', () => {
    expect(pickAnchorCandidate('탄지로', '탄지루와 탄지도 중에 뭐야?')).toBeNull();
  });

  it('#15 질문에 후보가 없으면 복원하지 않는다', () => {
    expect(pickAnchorCandidate('일륨도', '그 칼 이름이 뭐였지?')).toBeNull();
  });

  it('#16 자모 거리 2 손상은 복원 시도하지 않는다 (K=1)', () => {
    expect(pickAnchorCandidate('호흄', '호흡이 뭐야?')).toBeNull();
  });

  it('#17 어절 중간에서 시작하는 창은 후보가 아니다 (가드5)', () => {
    expect(pickAnchorCandidate('네즈코', '하가네즈카 호타루는 누구야?')).toBeNull();
  });

  it('#18 구두점은 창 경계다 — 일륜도, 그게 뭐야? 에서도 복원된다', () => {
    expect(pickAnchorCandidate('일륨도', '일륜도, 그게 뭐야?')).toBe('일륜도');
  });
});

describe('pickAnchorCandidate — 적중 경로 무개입 (완료조건 4)', () => {
  /** 골든 픽스처 S01~S16의 단일 키워드 — 전부 워터폴에서 실제로 적중하는 정상 표기. */
  const NORMAL_KEYWORDS = [
    '귀살대', '우로코다키 사콘지', '일륜도', '전집중 호흡',
    '다이쇼 시대', '탄지로', '네즈코', '기유',
    '호타루', '최종선별', '사비토', '마코모',
    '카마도 가족', '재갈', '도깨비', '사부로 영감',
  ];

  /** 판정 21문의 실제 질문 원문(A군 5 · B군 5 · C군 5 · E1). */
  const REAL_QUESTIONS = [
    '귀살대는 어떤 조직이야?',
    '우로코다키 사콘지는 누구야?',
    '일륜도가 뭐야?',
    '전집중 호흡은 뭐야?',
    '다이쇼 시대에 무슨 일이 있었어?',
    '탄지로는 어디 소속이야?',
    '네즈코는 어떻게 도깨비가 됐어?',
    '기유가 한 일을 알려줘',
    '호타루는 무엇을 다루는 사람이야?',
    '최종선별이 뭐야?',
    '탄지로와 귀살대는 무슨 관계야?',
    '사비토와 마코모는 무슨 관계야?',
    '카마도 가족에게 무슨 일이 일어났어?',
    '네즈코와 재갈은 무슨 관련이 있어?',
    '우로코다키와 탄지로 사이에 무슨 일이 있었어?',
    '무잔은 누구야?',
  ];

  it('#19 정상 키워드 16종 × 실제 질문 16종 = 256조합에서 복원이 한 번도 발화하지 않는다', () => {
    const fired = [];
    for (const keyword of NORMAL_KEYWORDS) {
      for (const question of REAL_QUESTIONS) {
        const restored = pickAnchorCandidate(keyword, question);
        if (restored !== null) fired.push(`${keyword} + "${question}" → ${restored}`);
      }
    }
    expect(fired).toEqual([]);
    expect(NORMAL_KEYWORDS.length * REAL_QUESTIONS.length).toBe(256);
  });
});

describe('restorationLines — 교정 사실 공개 문구 (완료조건 1·4)', () => {
  it('#20 복원이 0건이면 빈 배열 — 기존 요약 문구가 바이트 단위로 동일하다', () => {
    expect(restorationLines([])).toEqual([]);
    expect(restorationLines([{ keyword: '탄지로', tier: 'T2', matched: ['n1', 'n2'] }])).toEqual([]);
  });

  it('#21 복원이 있고 근거가 남아 있을 때만 2줄을 반환하고, 두 표기를 모두 밝힌다', () => {
    const lines = restorationLines([{ keyword: '일륜도', restoredFrom: '일륨도', matched: ['n1'] }]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('일륨도');
    expect(lines[0]).toContain('일륜도');
    expect(lines[0]).toContain('자동 추정');
    expect(lines[1]).toContain('답변 본문');
    // 전역 시드 절단(SEEDS_TOTAL)으로 근거가 0건이 된 복원은 보고하지 않는다.
    expect(restorationLines([{ keyword: '일륜도', restoredFrom: '일륨도', matched: [] }])).toEqual([]);
  });
});

// ── 판별력 살해 케이스 (2026-08-22 A1 — 뮤테이션 실측으로 확보) ──
// 아래 2건은 "기존 21케이스가 통과시켜 버린 뮤턴트"를 죽이기 위한 입력이다.
// 기존 #8·#9(가드4)와 #16(거리 2)이 왜 판별력이 없었는지:
//   #8 '무잔'·#16 '호흄'은 둘 다 2글자라 가드3(최소 3글자)에서 먼저 걸러진다 —
//      가드4나 거리 상한을 꺼도 결과가 null로 같아서 뮤턴트를 구분하지 못한다.
//   #9 '일륨도' + '검증: 일륨도'는 질문 속 후보가 거리 0(자기 자신)이라
//      거리 정확히 1 조건에서 이미 탈락한다 — 역시 가드4를 꺼도 null이다.
// 살해 케이스는 **가드를 껐을 때 null이 아닌 값이 나오는** 입력이어야 한다.
describe('pickAnchorCandidate — 가드 제거를 실제로 검출하는 살해 케이스 (A1)', () => {
  it('#22 질문에 정상 표기와 손상 표기가 함께 있어도, 정상 키워드를 손상어로 바꿔치기하지 않는다 (가드4 판별력)', () => {
    // 가드4를 끄면 '일륨도'(자모 거리 1)가 후보로 잡혀 사용자가 실제로 물은
    // 정상 키워드를 손상어로 되돌려 놓는다 — 검색이 조용히 빗나간다.
    expect(pickAnchorCandidate('일륜도', '일륨도 말고 일륜도')).toBeNull();
  });

  it('#23 3글자 이상에서도 자모 거리 2는 복원하지 않는다 (K=1 판별력)', () => {
    // 두 어절이 각각 1자모씩 손상된 합계 거리 2. 상한을 2로 올리면 복원이 발화한다.
    // 가드3에 걸리지 않는 길이(6자)라 거리 상한만을 단독으로 시험한다.
    expect(pickAnchorCandidate('전집준 호흠', '전집중 호흡은 뭐야?')).toBeNull();
  });
});
