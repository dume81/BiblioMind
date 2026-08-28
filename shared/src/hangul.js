// 한글 조합형 분해와 자모 편집거리 (TECH-SPEC §6.2.3 질문 원문 앵커 복원의 계산 기반).
// 정규화·kgid는 shared/src/normalize.js 단독 책임 — 이 모듈에 추가 금지.
// 이 모듈은 한글 조합형 분해와 자모 편집거리만 다룬다(정규화 안 함 — 호출자 책임).
// import 0개 · 부수효과 없음 · stdout 출력 없음 · throw 없음.

const HANGUL_FIRST = 0xac00; // '가'
const HANGUL_LAST = 0xd7a3; // '힣'
const JONGSEONG_COUNT = 28; // 종성 없음(0) 포함
const JUNGSEONG_COUNT = 21;
const SYLLABLE_BLOCK = JUNGSEONG_COUNT * JONGSEONG_COUNT; // 588

/**
 * 한글 완성형 음절 1자를 초·중·종성 인덱스로 분해한다. 음절이 아니면 null.
 * @param {string} ch 한 글자
 * @returns {{ cho: number, jung: number, jong: number } | null}
 */
export function decomposeSyllable(ch) {
  const code = String(ch).codePointAt(0);
  if (code === undefined || code < HANGUL_FIRST || code > HANGUL_LAST) return null;
  const index = code - HANGUL_FIRST;
  return {
    cho: Math.floor(index / SYLLABLE_BLOCK),
    jung: Math.floor((index % SYLLABLE_BLOCK) / JONGSEONG_COUNT),
    jong: index % JONGSEONG_COUNT,
  };
}

/**
 * 문자열을 자모 토큰 배열로 편다.
 * 음절은 'L<초성>','V<중성>','T<종성>'(종성 0이면 T 생략), 비음절 문자는 그 문자 자체를 1토큰으로 둔다.
 * 접두 L/V/T가 자모 인덱스와 리터럴 문자의 충돌을 막는다.
 * @param {string} text
 * @returns {string[]}
 */
export function toJamoUnits(text) {
  const out = [];
  for (const ch of String(text)) {
    const parts = decomposeSyllable(ch);
    if (parts === null) {
      out.push(ch);
      continue;
    }
    out.push(`L${parts.cho}`);
    out.push(`V${parts.jung}`);
    if (parts.jong !== 0) out.push(`T${parts.jong}`);
  }
  return out;
}

/**
 * 자모 토큰 배열 두 개의 Levenshtein 거리(삽입·삭제·치환 각 비용 1)를 밴드 DP로 구한다.
 * maxDistance를 넘는 것이 확정되면 즉시 maxDistance + 1을 반환한다(정확한 값이 아님 — 초과 신호).
 * 인자는 이미 toJamoUnits로 편 토큰 배열이다(창마다 재분해하지 않기 위함).
 * @param {string[]} a
 * @param {string[]} b
 * @param {number} maxDistance
 * @returns {number}
 */
export function jamoEditDistance(a, b, maxDistance) {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > maxDistance) return maxDistance + 1;
  const inf = maxDistance + 1;
  let prev = new Array(lb + 1);
  let cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j += 1) prev[j] = j <= maxDistance ? j : inf;
  for (let i = 1; i <= la; i += 1) {
    cur[0] = i <= maxDistance ? i : inf;
    const lo = Math.max(1, i - maxDistance);
    const hi = Math.min(lb, i + maxDistance);
    for (let j = 1; j < lo; j += 1) cur[j] = inf;
    let rowMin = cur[0];
    for (let j = lo; j <= hi; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j - 1] + cost, prev[j] + 1, cur[j - 1] + 1);
      if (v > inf) v = inf;
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    for (let j = hi + 1; j <= lb; j += 1) cur[j] = inf;
    if (rowMin > maxDistance) return inf;
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[lb];
}
