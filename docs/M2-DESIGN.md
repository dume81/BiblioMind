# 비블리오마인드 유지보수 M2 — 구현 설계서 (확정본)

> 대상: `GraphRAG_1st` 저장소. 문제 A(거짓 부재) + 문제 B(거짓 시드) 동시 수정.
> 이 문서는 **그대로 코딩하는 설계 정본**이다. 여기 적힌 것 외에는 손대지 않는다(외과수술 원칙).
> 모든 수치는 오늘(2026-08-22) 실측으로 재검증했다 — 검증 방법은 §8에 적었다.

---

## 0. 확정 결론 요약 (한 화면)

| 항목 | 확정값 | 근거 |
|---|---|---|
| T2 점수 하한 | `SEEDS_MIN_SCORE_RATIO = 0.5` (그 **키워드의 T2 1위** 대비 비율) | 오너 확정 |
| 하한 판정식 | **곱셈형** `raw >= t2Top * RATIO` | 나눗셈형은 0점 입력에서 NaN → 두 렌즈의 테스트가 충돌 |
| 하한 적용 시점 | **tier 확정보다 먼저**, `if (kept.length > 0) { tier='T2'; … }` | 패널 경고(조용한 미적중) |
| 앵커 복원 방식 | 질문 원문(nameKey)에서 **키워드와 같은 글자 수** 슬라이딩 창 → 자모 편집거리 1인 후보 **1종일 때만** 복원 | 실측 |
| 자모 편집거리 상한 | `ANCHOR_MAX_JAMO_DISTANCE = 1` | K=2는 부정 대조를 실측으로 깬다 |
| 복원 최소 글자 수 | `ANCHOR_MIN_KEYWORD_CHARS = 3` | K=1·2글자에서 오복원 5종 실측(마음→마을 등), 3글자에서 **0종** |
| 창 위치 가드 | **어절 시작 정렬(좌측만)** — 창 앞 문자가 공백이거나 런 시작 | 양쪽 정렬은 한국어 조사 때문에 완료조건 1을 깬다(실측: 일륨도 복원 실패) |
| 복원어의 계층 | **T1 → T2(하한 적용)까지만. T3 CONTAINS 배제** (`allowT3: false`) | T3 역방향 절이 문제 B를 복원 경로에서 재생산 |
| 복원 배치 | 기존 워터폴이 **완전히 소진된 뒤**(`records.length === 0`)에만 | 완료조건 4를 코드 구조로 보장 |
| 교정 공개 조건 | `restoredFrom && matched.length > 0` | 전역 시드 절단(15)으로 근거가 0건인데 "교정했다"고 말하는 것 방지 |
| unmatched 값 | 복원 실패 시 **원 키워드** 보존 | 현행 표면 불변 |

**신규 파일 4 · 수정 파일 4(코드 3 + 스크립트 1) · 문서 3 · 신규 테스트 36케이스(248 → 284).**

---

## 1. 적대적 검증 반영 대장 (치명 2 + 중대 12 전건)

| # | 등급 | 지적 | 반영 |
|---|---|---|---|
| A1-1 | 치명 | 완료조건 3의 "정탐 3건"이 실제로는 **4건** | **반영** — MAINTENANCE-PLAN·테스트 단언을 4건으로 정정(§7 오너 결정 ②). 픽스처 재확인: 생존 4 kgid = `n_691d4dc82874a1c3`, `n_bf66ca5b78cc47f0`, `n_a45effd08fb519bd`, `n_1be68e8ea0ddbf02`, 탈락 1 = `n_69fdefdb99c1eb70`(0.3919) |
| A1-2 | 치명 | 복원 성공 판정이 전역 절단(15) 이전이라 "근거 0건인데 교정 보고" 발생 | **반영** — `restorationLines()`가 `matched.length > 0`을 요구(§3.4) |
| A2-1 | 치명 | `ANCHOR_MAX_JAMO_DISTANCE=2`가 부정 대조를 깬다 | **반영** — 1로 고정. 렌즈3의 (d=2·창±1·T3 허용·별도 모듈) 일체 폐기 |
| A2-2 | 치명 | `question`이 사용자 원문이라는 보장 없음(모델이 채움. 실기록에 '검증: 일륨도' 존재) | **반영** — ①describe에 "사용자가 입력한 문장 그대로, 요약·재작성 금지" 명시 ②사용자 노출 문구에서 "질문 원문과 대조" → "이 호출의 question과 대조"로 정직화 ③anchorText(직전 어시스턴트 텍스트) 확장은 **런타임 반입 금지**(M1 계측기 전용) |
| A2-3 | 치명 | 2음절 키워드에서 "손상이 아닌 별개 단어"가 바꿔치기됨 | **반영** — `ANCHOR_MIN_KEYWORD_CHARS = 3`. 실측: 42종×30질문에서 워터폴을 실제로 미적중하는 키워드의 오복원 **0건**(MIN=2에서는 5종) |
| A1-3 | 중대 | 하한 부작용으로 **일륜도 노드까지 1층에서 동반 소실** | **반영** — 완료조건 3 문구에 명시 + **오너 승인 항목**(§7 ①). 예시 KG 독립 시뮬레이션으로 재확인: S07 13n/21r→11n/18r, 제거 노드 `n_69fdefdb99c1eb70`·`n_acec44b628d14f03`, 제거 관계 `r_f3231bb8f522f448`·`r_91b308e4671e840c`·`r_f93a98f9c3db0d39` |
| A1-4 | 중대 | K=2·창±1 오탐 | **반영** — K=1, 창 길이 = 키워드 글자 수 고정 |
| A1-5 | 중대 | 복원 경로 T3 배제 미언급 | **반영** — `allowT3: false` |
| A1-6 | 중대 | 곱셈형 vs 나눗셈형 판정식 충돌 | **반영** — 곱셈형 통일. "0점 주입" 트랩 테스트는 **작성하지 않는다**(불가능 시나리오 — 코딩규칙 2). 대신 코드 형태(`if (kept.length > 0)`)를 §3.3 주석과 리뷰 체크로 강제 |
| A1-7 | 중대 | 골든이 S19/S20에만 question을 줘 조건 4의 오라클이 없음 | **반영** — 골든 캡처를 **2패스**로(패스 A = question 없음 / 패스 B = 25건 전건 question) |
| A1-8 | 중대 | `{ ...c, ...digest(r) }` 스프레드 때문에 S20이 바이트 동일일 수 없음 | **반영** — question을 `CASES`에 넣지 않고 별도 맵으로 분리. 대조 기준 = **digest 9필드**로 문서에 못박음 |
| A2-4 | 중대 | 교정 문구가 확정형 단언 | **반영** — 추정형 + 근거 노출(§3.4) |
| A2-5 | 중대 | 복원 성공 → 시드 증가 → 전역 상한 절단 상호작용 | **반영** — A1-2와 동일 가드. 절단 시 표시 결함은 **기존 결함**이므로 개선 큐 등재만(범위 밖) |
| A2-6 | 중대 | 임계 50%의 실효 근거는 n=20이 아니라 **비교점 6개** | **반영** — 문서 근거 문구 정직화 + `seedFloorCuts` 관측 로그 채택 + 재측정 조건 수치화 |
| A2-7 | 중대 | 완료조건 3 숫자 | A1-1과 동일 |
| A1-14 | 경미 | `matchKeyword` 모듈 스코프 ↔ `seedFloorCuts` 클로저 단절 | **반영** — 헬퍼가 `{ tier, records, floorCuts }`를 **반환**, 호출부가 수집 |
| A1-9 | 경미 | '탄지룸' 예시가 K=1로 복원 불가 | **반영** — 근거 예시를 **'탄지롬'**(d=1)으로 교체. 실측: `탄지룸↔탄지로 = 2`, `탄지롬↔탄지로 = 1` |
| A1-13 | 경미 | T2 쿼리에 `ORDER BY` 없음 | **반영** — `records[0]` 대신 명시적 max + 주석 1줄(쿼리 자체는 무수정) |
| A1-11 | 경미 | `check-keywords` 경로/확장자 | **M1 범위** — `GraphRAG_1st/scripts/check-keywords.js` 권고만 기록(M2에서 만들지 않음) |
| A1-12 | 경미 | `scripts/_tmp-m2-probe.mjs` 언급 | **삭제** — 저장소에 존재하지 않음을 확인(`scripts/`는 `capture-golden.js`·`setup.js` 둘뿐) |
| A1-10 | 경미 | "소규모라 미발현" 오기 | **반영** — MAINTENANCE-PLAN 문구 정정(§9) |
| A2-8 | 경미 | 복원 실패 사실을 unmatched에 병기 | **오너 결정으로 분리**(§7 ④). 기본은 현행 유지 |

### 미반영 항목과 이유

| 미반영 | 이유 |
|---|---|
| 렌즈3 `fakeGraphSession.js`(인메모리 페이크 세션) | 실 Aura를 재생하는 200줄급 병렬 오라클. 충실도가 갈리면 **거짓 안심**을 준다. 이미 `capture-golden.js`가 실 DB 오라클로 지정돼 있고 25케이스 결정론 2회 검증까지 한다. 저장소 관례상 `runSearch`는 단위 테스트 대상이 아니었다(slice05는 순수 함수만). **투기적 추상화 금지** 조항 적용 |
| 렌즈3 `partitionByScoreRatio` 헬퍼 추출 | 1회용 로직의 추상화. 대신 픽스처 기반 `seedFloor.test.js`(§5.3)가 같은 판정을 DB 없이 증명한다 |
| 렌즈3 `keyword-probes.json` / `check-keywords.js` | **M1 범위**(계측기). M2는 검색 정확도 수정만 |
| 적대검증2의 "어절 경계 **양쪽** 정렬" 가드 | **부분 채택**. 양쪽 정렬은 한국어 조사 결합("일륜도**가**") 때문에 완료조건 1을 즉시 깬다 — 실측: MIN3/양쪽정렬에서 `('일륨도','일륜도가 뭐야?') → null`. **좌측(어절 시작) 정렬만** 채택 |
| `last-searches.json`에 앵커 원문 durable 기록 | 스키마가 총감사 확정본. 범위 확대 |
| 전역 시드 절단(SEEDS_TOTAL)의 계층 무시 정렬 수정 | 계획서가 **범위 밖**으로 확정한 항목(패널 신규 발견 1). 문구 정정만 |
| `ANCHOR_MAX_QUESTION_CHARS` 등 방어 상수 | 불가능 시나리오 에러 처리 금지 |

---

## 2. 신규 파일 ①: `shared/src/hangul.js`

**절대경로**: `C:\Users\DUME\Desktop\Claude Code Workspace\GraphRAG_1st\shared\src\hangul.js`
**분량**: 약 60행. **import 0개**(순수). 부수효과·stdout·throw 없음. 전 함수 JSDoc.

> 파일 머리 주석에 반드시 넣을 것:
> `// 정규화·kgid는 shared/src/normalize.js 단독 책임 — 이 모듈에 추가 금지.`
> `// 이 모듈은 한글 조합형 분해와 자모 편집거리만 다룬다(정규화 안 함 — 호출자 책임).`

### 모듈 상수 (export 불필요)

```js
const HANGUL_FIRST = 0xac00;      // '가'
const HANGUL_LAST  = 0xd7a3;      // '힣'
const JONGSEONG_COUNT = 28;       // 종성 없음(0) 포함
const JUNGSEONG_COUNT = 21;
const SYLLABLE_BLOCK  = JUNGSEONG_COUNT * JONGSEONG_COUNT; // 588
```

### export 1 — `decomposeSyllable(ch)`

```js
/**
 * 한글 완성형 음절 1자 → 초·중·종성 인덱스. 음절이 아니면 null.
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
```

**실측 검증값(테스트에 그대로 쓸 것)**
| 글자 | 코드포인트 | {cho, jung, jong} |
|---|---|---|
| 륜 | U+B95C | {5, 17, **4**} |
| 륨 | U+B968 | {5, 17, **16**} |
| 혈 | U+D608 | {18, 6, **8**} |
| 혐 | U+D610 | {18, 6, **16**} |

→ 두 사고 모두 **초·중성 보존, 종성만 치환(→16=ㅁ)**. 과업 명세와 완전 일치.

### export 2 — `toJamoUnits(text)`

```js
/**
 * 문자열 → 자모 토큰 배열. 음절은 'L<초성>','V<중성>','T<종성>'(종성 0이면 T 생략),
 * 비음절 문자(공백·영문·숫자·기호)는 그 문자 자체를 1토큰으로 편다.
 * 접두 L/V/T가 자모 인덱스와 리터럴 문자의 충돌을 막는다.
 * @param {string} text
 * @returns {string[]}
 */
export function toJamoUnits(text) {
  const out = [];
  for (const ch of String(text)) {
    const parts = decomposeSyllable(ch);
    if (parts === null) { out.push(ch); continue; }
    out.push('L' + parts.cho);
    out.push('V' + parts.jung);
    if (parts.jong !== 0) out.push('T' + parts.jong);
  }
  return out;
}
```

실측: `일륜도` → `[L11,V20,T8, L5,V17,T4, L3,V8]` / `일륨도` → `[…,T16,…]` / `혈귀` → `[L18,V6,T8, L0,V16]` / `혐귀` → `[L18,V6,T16, L0,V16]`.

### export 3 — `jamoEditDistance(a, b, maxDistance)`

**정의**: `toJamoUnits` 산출 **토큰 배열 위의 Levenshtein 거리**(삽입·삭제·치환 각 비용 1).
인자는 **이미 편 토큰 배열**을 받는다(창마다 키워드를 재분해하지 않기 위함).
상한 초과 시 즉시 `maxDistance + 1`을 반환하는 밴드 DP.

```js
/**
 * 자모 토큰 배열 두 개의 편집거리(밴드 DP). maxDistance를 넘으면 maxDistance+1을 반환한다.
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
  for (let j = 0; j <= lb; j += 1) prev[j] = j <= maxDistance ? j : inf;  // ← 밴드 초기화(중요)
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
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[lb];
}
```

**검증 완료**: 무작위 60,000쌍 × maxDistance∈{1,2,3} = **180,000 비교에서 무제한 Levenshtein과 불일치 0건**.

**위치 근거**: `shared/`에 두는 이유 — ①정규화가 아니라 순수 텍스트 유틸이라 `normalize.js` 단일 구현 원칙과 충돌하지 않는다(이 모듈은 import 0개) ②M1의 `scripts/check-keywords.js`도 같은 구현을 써야 하므로 워크스페이스 공용 위치가 맞다 ③`@bibliomind/shared`의 exports map `"./*": "./src/*.js"`가 `@bibliomind/shared/hangul`을 해석하고, `mcp-server/package.json`이 이미 `@bibliomind/shared`를 의존한다(확인함).

---

## 3. 수정 파일 ①: `mcp-server/src/lib/searchEngine.js`

**절대경로**: `C:\Users\DUME\Desktop\Claude Code Workspace\GraphRAG_1st\mcp-server\src\lib\searchEngine.js`

### 3-1. L5 뒤 — import 1줄 추가

```js
import { toJamoUnits, jamoEditDistance } from '@bibliomind/shared/hangul';
```

### 3-2. L24 뒤 (§6.4 상한 표 상수 블록 끝) — 상수 3개 신설

```js
// §6.3 단계 2 — T2 점수 하한. 그 키워드의 T2 1위 점수 대비 비율.
// 근거(2026-08-22 실측): 워터폴 실효 경로의 비교점 6개에서 자연 간극 39.2% ↔ 62.0%의 중앙.
// 재측정 조건: 슬라이스 2 규모에서 seedFloorCuts 관측 비교점 n≥30 확보 시.
export const SEEDS_MIN_SCORE_RATIO = 0.5;

// §6.2.3 앵커 복원 — 질문 원문 창과 키워드의 자모 편집거리 상한.
// 근거: 실측 손상 2건 모두 거리 1(종성 단일 치환). 거리 2 손상은 복원 시도 0건(의도된 보수성).
export const ANCHOR_MAX_JAMO_DISTANCE = 1;

// §6.2.3 앵커 복원 — 복원을 시도하는 키워드의 최소 글자 수.
// 근거: 2음절은 거리 1 이웃이 일상 한국어와 겹쳐 '손상이 아닌 별개 단어'를 바꿔치기한다
// (실측: 마음→마을, 이간→인간, 제갈→재갈 …). 3글자 이상에서 오복원 0건.
export const ANCHOR_MIN_KEYWORD_CHARS = 3;
```

그리고 파일 하단(§SYSTEM_PROPS 근처, 다른 모듈 상수와 같은 자리)에:

```js
const PURE_HANGUL_PHRASE = /^[가-힣 ]+$/;      // 한글 음절 + 공백만 (nameKey가 소문자화하므로 a-z 불요)
const RUN_BOUNDARY = /[^0-9a-z가-힣 ]+/;        // 구두점을 창 경계로 — 문장 걸침 후보 배제
```

### 3-3. L34(`escapeLucene`) 뒤 — 순수 함수 `pickAnchorCandidate` 신설

```js
/**
 * 질문 원문을 앵커로 손상 키워드를 복원한다. 순수 함수 — DB 접근·부수효과 없음.
 *
 * 설계 원칙: **앵커는 이 호출에 전달된 question 문자열이다.** 시스템은 사용자를 교정하지
 * 않고, 후보 집합을 question의 부분 문자열로 봉쇄한다(그래프 쪽 추측 금지).
 *
 * @param {string} keyword 워터폴 전 계층 미적중 키워드
 * @param {string | null | undefined} question 도구가 받은 질문 문자열
 * @returns {string | null} 복원 키워드(nameKey 표기) 또는 null(복원하지 않음)
 */
export function pickAnchorCandidate(keyword, question) {
  if (typeof question !== 'string' || question.length === 0) return null;   // 가드1 — 앵커 부재
  const kw = nameKey(keyword);
  if (!PURE_HANGUL_PHRASE.test(kw)) return null;                            // 가드2 — 한글 음절+공백만
  const kwChars = [...kw];
  if (kwChars.length < ANCHOR_MIN_KEYWORD_CHARS) return null;               // 가드3 — 짧은 키워드 제외
  const q = nameKey(question);
  if (q.includes(kw)) return null;                                          // 가드4 — 축자 존재 = 손상 아님
  const kwUnits = toJamoUnits(kw);
  const found = new Set();
  for (const run of q.split(RUN_BOUNDARY)) {
    const chars = [...run];
    for (let i = 0; i + kwChars.length <= chars.length; i += 1) {
      const cand = chars.slice(i, i + kwChars.length).join('');
      if (cand === kw) return null;                       // 가드4 이중 안전망
      if (cand.trim() !== cand) continue;                 // 앞뒤 공백 창 배제
      if (!PURE_HANGUL_PHRASE.test(cand)) continue;
      if (i > 0 && chars[i - 1] !== ' ') continue;        // 가드5 — 어절 시작 정렬(좌측)
      const d = jamoEditDistance(kwUnits, toJamoUnits(cand), ANCHOR_MAX_JAMO_DISTANCE);
      if (d >= 1 && d <= ANCHOR_MAX_JAMO_DISTANCE) found.add(cand);
    }
  }
  return found.size === 1 ? [...found][0] : null;         // 가드6 — 0건·모호(2종 이상)면 복원 안 함
}
```

**설계 주석(코드에 남길 것)**
- 창 길이를 키워드와 **같은 글자 수로 고정**한 근거: 음절은 자모 2~3개이므로 거리 1로는 음절 개수가 바뀔 수 없다 → 다른 길이 창은 계산 낭비이자 오탐 공간.
- 가드5가 **좌측만**인 근거: 한국어는 교착어라 명사 뒤에 조사가 붙는다("일륜도**가**"). 우측까지 경계를 요구하면 실사고 1이 복원되지 않는다(실측 확인).

**실측 검증 (오늘 전수 시뮬레이션)**

| 시험 | 결과 |
|---|---|
| 노드 이름·판정 키워드 중 3자 이상 25종의 **초·중·종성 단일 치환 d=1 변형 전수 × 질문 5종 = 47,450 조합** | 회복 **100.00%**, 엉뚱 복원 **0** |
| 그래프에 없는 정당 키워드 42종 × 현실 질문 30종 = 1,260 조합 중 **워터폴을 실제로 미적중하는 것만** | 복원 발화 **0건** (MIN=2였다면 5종 오복원: 마음→마을·이간→인간·제갈→재갈·나이→다이·기요→기유) |
| 정상 키워드 16종 × 질문 16종 = 256 조합 | 발화 **0건** |
| 거리 2 손상(호흄·탄지룸 등) | 복원 시도 **0건** |
| E1 실제 호출 `('혐귀', '무잔은 누구야?')` | **null** |

### 3-4. L156~193 → 헬퍼 `matchKeyword` 추출 + T2 하한 삽입

현재 루프 몸통(L157~193)을 **문자 그대로** 모듈 스코프 async 헬퍼로 옮긴다. `fulltextAvailable`은 모듈 스코프 변수라 헬퍼 안에서도 그대로 대입된다(graceful degradation 의미 무변경 — `ftOk`는 현행대로 루프 **전에** 1회 판정한 값을 계속 넘긴다).

```js
/**
 * 키워드 1개의 시드 워터폴(T1 → T2 → T3). runSearch 루프 몸통을 그대로 옮긴 것.
 * @param {import('neo4j-driver').Session} session
 * @param {string} keyword
 * @param {boolean} ftOk full-text 가용 여부(루프 전 1회 판정값)
 * @param {{ allowT3?: boolean }} [options] allowT3=false면 T3 CONTAINS 폴백을 건너뛴다(앵커 복원 재조회 전용)
 * @returns {Promise<{ tier: string|null, records: import('neo4j-driver').Record[], floorCuts: object[] }>}
 */
async function matchKeyword(session, keyword, ftOk, { allowT3 = true } = {}) {
  const kwNorm = nameKey(keyword);
  let tier = null;
  let records = [];
  const floorCuts = [];

  const t1 = await session.run(
    `MATCH (n:RKEntity) WHERE n.name_key = $kw RETURN ${NODE_RETURN}, 1.0 AS score LIMIT $lim`,
    { kw: kwNorm, lim: neo4jInt(SEEDS_PER_KEYWORD) },
  );
  if (t1.records.length > 0) {
    tier = 'T1';
    records = t1.records;
  } else if (ftOk) {
    try {
      const t2 = await session.run(
        `CALL db.index.fulltext.queryNodes('kg_fulltext', $q) YIELD node, score
         WITH node AS n, score RETURN ${NODE_RETURN}, score LIMIT $lim`,
        { q: escapeLucene(kwNorm), lim: neo4jInt(SEEDS_PER_KEYWORD) },
      );
      // 점수 하한 — 그 키워드의 T2 1위 대비 비율(§6.3 단계 2).
      // tier 확정보다 **먼저** 적용해 kept가 비면 T3로 자연 강등되게 한다.
      // 1위는 records[0]이 아니라 명시적 max로 구한다 — 프로시저의 정렬 보장에 의존하지 않기 위함.
      // ※ 상위 5건 절단(LIMIT)은 여전히 프로시저 반환 순서에 의존한다. 6건 이상 반환하는
      //   키워드가 생기면 ORDER BY 명시를 검토할 것(슬라이스 2 관찰 항목).
      const t2Top = t2.records.reduce((max, r) => Math.max(max, Number(r.get('score'))), 0);
      const floor = t2Top * SEEDS_MIN_SCORE_RATIO;
      const kept = [];
      for (const r of t2.records) {
        const raw = Number(r.get('score'));
        if (raw >= floor) {
          kept.push(r);
        } else {
          floorCuts.push({
            keyword,
            name: r.get('name'),
            kgid: r.get('kgid'),
            score: raw,
            topScore: t2Top,
            ratio: Number((raw / t2Top).toFixed(4)),
          });
        }
      }
      // 비율 하한에서는 1위 자신의 비율이 1.0이라 kept가 비지 않는다. 이 분기 형태는
      // **절대 하한으로 바꾸는 순간 발화**하는 T3 폴백 보존 장치다 — 형태를 바꾸지 말 것.
      if (kept.length > 0) {
        tier = 'T2';
        records = kept;
      }
    } catch {
      fulltextAvailable = false; // 인덱스 소실 등 — T3 폴백으로 강등
    }
  }
  if (records.length === 0 && allowT3) {
    const t3 = await session.run(
      `MATCH (n:RKEntity)
       WHERE n.name_key CONTAINS $kw OR ($rev AND $kw CONTAINS n.name_key)
       RETURN ${NODE_RETURN}, 0.5 AS score LIMIT $lim`,
      { kw: kwNorm, rev: kwNorm.length >= 4, lim: neo4jInt(SEEDS_PER_KEYWORD) },
    );
    if (t3.records.length > 0) {
      tier = 'T3';
      records = t3.records;
    }
  }
  return { tier, records, floorCuts };
}
```

- **경계는 `>=`** — 정확히 50%인 항목은 유지된다(현 그래프 최근접값 0.5425).
- `t2.records`가 0건이면 `t2Top = 0`, 루프 미실행, `kept = []` → 현행과 완전히 동일하게 T3로 낙하하고 잘못된 cut 항목도 남지 않는다.

### 3-5. L147 — `runSearch` 시그니처에 `question` 추가

```js
/**
 * 검색 실행 — 시드 워터폴 + 앵커 복원 + k-hop + 최단경로 + 1층 조립 + 별칭 (§6.3 단계 2~4).
 * @param {import('neo4j-driver').Session} session 읽기 전용 세션
 * @param {{ keywords: string[], question?: string|null, hops?: number, limitNodes?: number }} args
 *   question: 도구가 받은 질문 문자열. 미전달이면 앵커 복원이 동작하지 않는다(현행 동작).
 */
export async function runSearch(session, { keywords, question, hops = HOPS_DEFAULT, limitNodes = NODE_LIMIT_DEFAULT }) {
```

### 3-6. L153~203 — 단계 2 루프 본문 교체 (순수 가산)

```js
  // ── 단계 2: 시드 매칭 (키워드별 워터폴, 상위 계층 매칭 시 하위 생략) ──
  const seedsByKeyword = [];
  const unmatched = [];
  const seedFloorCuts = [];          // 하한에 잘린 T2 후보 관측 로그(§6.3 단계 2)
  for (const keyword of kws) {
    let effective = keyword;
    let restoredFrom = null;
    let { tier, records } = await matchKeyword(session, keyword, ftOk);
    // ↑ floorCuts를 함께 받아야 하므로 실제로는 아래 형태로 쓴다:
    //   const first = await matchKeyword(session, keyword, ftOk);
    //   let { tier, records } = first;
    //   seedFloorCuts.push(...first.floorCuts);
    if (records.length === 0) {
      // 앵커 복원 — 기존 워터폴이 **완전히 소진된 뒤에만** 실행(무개입 보장).
      const anchored = pickAnchorCandidate(keyword, question);
      if (anchored) {
        const retry = await matchKeyword(session, anchored, ftOk, { allowT3: false });
        seedFloorCuts.push(...retry.floorCuts.map((c) => ({ ...c, restoredFrom: keyword })));
        if (retry.records.length > 0) {
          effective = anchored;
          restoredFrom = keyword;
          tier = retry.tier;
          records = retry.records;
        }
      }
    }
    if (records.length === 0) {
      unmatched.push(keyword);       // 실패 시 **원 키워드** 보존
    } else {
      seedsByKeyword.push({
        keyword: effective,
        tier,
        restoredFrom,
        nodes: records.map((r) => recordToNode(r, 0, Number(r.get('score')))),
      });
    }
  }
```

정확한 최종 형태(구조 분해 + floorCuts 수집을 한 번에):

```js
  for (const keyword of kws) {
    let effective = keyword;
    let restoredFrom = null;
    const first = await matchKeyword(session, keyword, ftOk);
    seedFloorCuts.push(...first.floorCuts);
    let { tier, records } = first;
    …
  }
```

- **루프 내부(2차 패스 아님)에 두는 이유**: `seedsByKeyword` 순서 = 입력 키워드 순서가 유지되어 별칭 부여·최단경로 쌍 구성의 결정론이 보존된다.
- `KEYWORDS_MAX` 절단(`kws`)은 무수정.

### 3-7. L287~291 — `seedsReport`

```js
  const seedsReport = seedsByKeyword.map((s) => ({
    keyword: s.keyword,
    tier: s.tier,
    ...(s.restoredFrom ? { restoredFrom: s.restoredFrom } : {}),
    matched: s.nodes.map((n) => nodeAlias.get(n.kgid)).filter(Boolean),
  }));
```

**복원이 없으면 키 자체가 없다** — 골든 대조 바이트 동일 보장.

### 3-8. L293~300 — 반환에 `seedFloorCuts` 추가

```js
  return {
    nodes,
    rels,
    truncated: layer1.truncated,
    seeds: seedsReport,
    unmatched,
    seedFloorCuts,
    ftWarning: …,
  };
```

기존 소비자(`kgSearch.js`, `capture-golden.js`의 `digest()`)는 화이트리스트 방식이라 무영향.

---

## 4. 수정 파일 ②: `mcp-server/src/tools/kgSearch.js`

**절대경로**: `C:\Users\DUME\Desktop\Claude Code Workspace\GraphRAG_1st\mcp-server\src\tools\kgSearch.js`

### 4-1. L7 — import에 상수 1개 추가

```js
import { runSearch, pickSummary, SEEDS_MIN_SCORE_RATIO, NODE_LIMIT_DEFAULT, NODE_LIMIT_MAX, HOPS_DEFAULT, HOPS_MAX } from '../lib/searchEngine.js';
```

### 4-2. L72 — `question` describe 개정 (신뢰 경계 명문화)

```js
        question: z.string().optional().describe(
          '사용자가 입력한 문장 그대로 — 요약·재작성·번역·접두어 부착 금지. '
          + '키워드 손상 자동 재검색의 유일한 대조 기준이자 3D 앱 상태 표시·로그에 쓰인다. 가급적 항상 전달하라.',
        ),
```

### 4-3. L96~100 — `question`을 `runSearch`로 전달

```js
        result = await runSearch(session, {
          keywords,
          question,
          hops: hops ?? HOPS_DEFAULT,
          limitNodes: limitNodes ?? NODE_LIMIT_DEFAULT,
        });
```

> 확인 완료: `data/runtime/last-searches.json`에 question 필드가 실제 기록되고 있다("카마도 가족에게 무슨 일이 일어났어?" 등). 앵커는 이미 도구에 도달해 있고 `runSearch`에만 안 넘어가고 있었다.

### 4-4. 파일 하단 — 순수 export `restorationLines(seeds)` 신설 (테스트 가능한 공개 문구)

```js
/**
 * 교정(재검색) 사실 공개 줄. **전역 시드 절단으로 근거가 0건이 된 복원은 보고하지 않는다.**
 * 순수 함수 — 테스트 대상.
 * @param {Array<{ keyword: string, restoredFrom?: string, matched: string[] }>} seeds
 * @returns {string[]}
 */
export function restorationLines(seeds) {
  const restored = seeds.filter((s) => s.restoredFrom && s.matched.length > 0);
  if (restored.length === 0) return [];
  const detail = restored
    .map((s) => `'${s.restoredFrom}'는 그래프에 없어, 이 호출의 question에서 자모 1개만 다른 '${s.keyword}'로 다시 검색함`)
    .join(' / ');
  return [
    `키워드 자동 재검색 ${restored.length}건: ${detail} (자동 추정 — 확정된 오타 판정이 아니다)`,
    '답변 본문에 이 재검색 사실을 밝혀라 — 추출한 키워드가 질문 표기와 달라 질문 쪽 표기로 다시 검색했다. 사용자가 실제로 쓴 표기와 다르면 그렇게 지적하라.',
  ];
}
```

**문구 설계 근거**: 알고리즘이 실제로 아는 것은 "①원 키워드가 세 계층 모두 미적중 ②question 안에 자모 1개만 다른 문자열이 유일하게 하나 있었다"뿐이다. "교정했다 / 질문 원문과 대조해 복원"이라는 확정형 단언은 이 지식을 넘어선다(적대 검증 A2-4). 위 문구는 정확히 아는 것만 말한다.

### 4-5. L169~172 — lines 조립

```js
      const seedCount = result.seeds.reduce((sum, s) => sum + s.matched.length, 0);
      const lines = [
        `시드 ${seedCount}건(${result.seeds.map((s) => `${s.keyword}:${s.tier}`).join(', ') || '없음'}) · 1층 노드 ${result.nodes.length}·관계 ${result.rels.length}`,
        ...restorationLines(result.seeds),          // ← 신규 (복원 0건이면 빈 배열 = 현행과 바이트 동일)
      ];
      if (result.unmatched.length > 0) lines.push(…);   // 이하 무수정
```

복원 성공 시 해당 키워드는 `unmatched`에서 빠지므로 두 줄이 모순되지 않는다.
`status`도 `seedCount` 0→1로 '부분 성공'→'성공'이 되어 **A3가 자동 반전**된다.

### 4-6. L119 뒤(`const ts = …` 다음, `recordSearch` 호출 전) — stderr 관측 로그

```js
      if (result.seedFloorCuts.length > 0) {
        console.error('[bibliomind] seed-floor ' + JSON.stringify({
          searchId, ratio: SEEDS_MIN_SCORE_RATIO, cuts: result.seedFloorCuts,
        }));
      }
```

`console.log` 금지 철칙 준수(stderr 전용). 한 줄 JSON이라 `grep 'seed-floor' | sed 's/^.*seed-floor //' | jq`로 재조정 데이터셋을 바로 뽑을 수 있다. 잘린 항목 0건이면 한 바이트도 출력하지 않는다.

### 4-7. L152(`unmatched: result.unmatched,` 다음) — data 조건부 필드

```js
        ...(result.seedFloorCuts.length > 0 ? { seedFloorCuts: result.seedFloorCuts } : {}),
```

`data.seeds[i].restoredFrom`은 `seeds: result.seeds`를 그대로 싣고 있으므로 **추가 코드 0줄**로 기계 판독 채널에 실린다.

### 4-8. 건드리지 않는 것

`CITE_INSTRUCTIONS`(L12~34)는 **무수정**. 항목 9 신설은 드문 사건을 위해 모든 호출에 상시 비용을 지우는 것이라, 발생했을 때만 나타나는 조건부 lines가 더 외과적이다.

---

## 5. 신규 테스트 (36케이스, 기존 248은 파일 무수정)

### 5-1. `shared/tests/hangul.test.js` — **14케이스(작성 완료 · 커밋 59ed6a3)**

**절대경로**: `C:\Users\DUME\Desktop\Claude Code Workspace\GraphRAG_1st\shared\tests\hangul.test.js`

| # | 케이스 | 기대 |
|---|---|---|
| 1 | `decomposeSyllable('륜'/'륨'/'혈'/'혐')` | `{5,17,4}` / `{5,17,16}` / `{18,6,8}` / `{18,6,16}` |
| 2 | 비음절 `'a' '1' ' ' 'ㄱ' ''` | 전부 `null` |
| 3 | `toJamoUnits('도')` | `['L3','V8']` (종성 0 → T 토큰 생략) |
| 4 | `toJamoUnits('a 1')` | `['a',' ','1']` (비한글은 문자 그대로) |
| 5 | `toJamoUnits('일륨도')` | `['L11','V20','T8','L5','V17','T16','L3','V8']` |
| 6 | `jamoEditDistance(u('일륜도'), u('일륨도'), 1)` | `1` |
| 7 | `jamoEditDistance(u('혈귀'), u('혐귀'), 1)` | `1` |
| 8 | `탄지로↔탄지롬 = 1`, `탄지로↔탄지룸 = 2` | 종성 없는 음절의 d=1 손상은 종성 부가뿐임을 고정 |
| 9 | `호흡↔호흄 = 2` | K=1이 배제해야 하는 중성+종성 동시 손상 |
| 10 | 상한 초과 시 `maxDistance + 1` 반환 | `jamoEditDistance(u('호흡'), u('호흄'), 1) === 2` |
| 11 | 빈 배열 / 길이차 큰 쌍 | `([],[],1)===0`, `(u('가'), u('가나다라'), 1) === 2` |

### 5-2. `mcp-server/tests/anchorRestore.test.js` — 21케이스

**절대경로**: `C:\Users\DUME\Desktop\Claude Code Workspace\GraphRAG_1st\mcp-server\tests\anchorRestore.test.js`
`import { pickAnchorCandidate } from '../src/lib/searchEngine.js'` · `import { restorationLines } from '../src/tools/kgSearch.js'`

| # | 입력 | 기대 | 검증하는 가드/조건 |
|---|---|---|---|
| 1 | `('일륨도','일륜도가 뭐야?')` | `'일륜도'` | 실사고 1 (조건 1) |
| 2 | `('혐귀','혈귀가 뭐야?')` | `null` | 가드3 (조건 2) |
| 3 | `('혐귀','혈귀는 무엇이야?')` | `null` | 가드3 (조건 2) |
| 4 | `('혐귀','무잔은 누구야?')` | `null` | E1 실제 호출 재현 (조건 2) |
| 5 | `('일륨도', null)` | `null` | 가드1 (조건 5) |
| 6 | `('일륨도', undefined)` | `null` | 가드1 (조건 5) |
| 7 | `('일륨도','')` | `null` | 가드1 (조건 5) |
| 8 | `('무잔','무잔은 누구야?')` | `null` | 가드4 |
| 9 | `('일륨도','검증: 일륨도')` | `null` | 가드4 — 사용자 본인 오타는 '없습니다'가 정답 |
| 10 | `('api','api key가 뭐야?')` | `null` | 가드2 |
| 11 | `('마음','탄지로가 살던 마을은 어떻게 됐어?')` | `null` | 가드3 — 오복원 방어(A2-3) |
| 12 | `('전집중 호흠','전집중 호흡이 뭐야?')` | `'전집중 호흡'` | 공백은 창 내부 문자 |
| 13 | `('우로코다키 사콘디','우로코다키 사콘지는 누구야?')` | `'우로코다키 사콘지'` | 긴 키워드 |
| 14 | `('탄지로','탄지루와 탄지도 중에 뭐야?')` | `null` | 가드6 — 모호(후보 2종) |
| 15 | `('일륨도','그 칼 이름이 뭐였지?')` | `null` | 후보 0건 |
| 16 | `('호흄','호흡이 뭐야?')` | `null` | K=1 |
| 17 | `('네즈코','하가네즈카 호타루는 누구야?')` | `null` | 가드5 — 어절 중간 창 배제 |
| 18 | `('일륨도','일륜도, 그게 뭐야?')` | `'일륜도'` | 구두점 런 분할 |
| 19 | 정상 키워드 16종 × 질문 16종 = 256조합 | 전부 `null` | 조건 4 (무개입) |
| 20 | `restorationLines([])` | `[]` | 조건 4 — 복원 0건이면 lines 바이트 동일 |
| 21 | `restorationLines([{keyword:'일륜도',restoredFrom:'일륨도',matched:['n1']}])` → 2줄, 두 표기 모두 포함 / `matched:[]`이면 `[]` | 조건 1 + A1-2 절단 가드 |

(20·21은 `it` 2개로 쪼갠다 — 표의 21행 = `it` 21개.)

### 5-3. `mcp-server/tests/seedFloor.test.js` — 4케이스

**절대경로**: `C:\Users\DUME\Desktop\Claude Code Workspace\GraphRAG_1st\mcp-server\tests\seedFloor.test.js`
골든 픽스처의 `t2RawScores`(개선 전 실측 원점수)에 상수를 적용해 판정한다. DB 불요.
경로는 `new URL('../fixtures/golden-searches.json', import.meta.url)` (cwd 기준 경로 금지).

| # | 케이스 | 기대 |
|---|---|---|
| 1 | 상수 노출 | `SEEDS_MIN_SCORE_RATIO === 0.5` |
| 2 | `t2RawScores['네즈코']`에 하한 적용 | 생존 **4건** = `[n_691d4dc82874a1c3, n_bf66ca5b78cc47f0, n_a45effd08fb519bd, n_1be68e8ea0ddbf02]`, 탈락 **1건** = `n_69fdefdb99c1eb70`(하가네즈카 호타루, ratio 0.3919). **개수가 아니라 kgid 집합으로 단언** |
| 3 | 전 키워드 불변식 | hits가 1건 이상인 모든 키워드에서 `kept.length >= 1` (1위 자신의 ratio가 1.0 → 비율 하한에서 kept가 비는 경로 없음) |
| 4 | '재갈' 함정 | `t2RawScores['재갈'].wouldCutAt50`이 비어 있지 않지만, 골든 S14의 `seeds[0].tier === 'T1'` → **T2 하한이 도달 불가**. 워터폴 단락 구조를 픽스처로 고정 |

---

## 6. 수정 파일 ③: `scripts/capture-golden.js` (제품 코드 아님 — 게이트 불요)

**절대경로**: `C:\Users\DUME\Desktop\Claude Code Workspace\GraphRAG_1st\scripts\capture-golden.js`

### 6-1. L23 — 출력 경로에 `--out` 옵션

```js
const outArg = process.argv.indexOf('--out');
const FIXTURE_FILE = outArg > -1
  ? path.resolve(REPO, process.argv[outArg + 1])          // REPO 기준 — cwd 기준 경로 금지
  : path.join(REPO, 'mcp-server', 'fixtures', 'golden-searches.json');
```

M4 재캡처가 개선 전 기준선을 덮어쓰지 않게 하는 유일한 장치.

### 6-2. L57 뒤 — 앵커 패스용 질문 맵 (CASES에는 넣지 않는다)

```js
/** 손상 프로브의 실사고 재현 문장. CASES에 넣으면 픽스처 케이스 객체가 바뀌므로 분리한다. */
const PROBE_QUESTIONS = {
  S19: '일륜도가 뭐야?',
  S20: '혈귀가 뭐야?',
};

/** 앵커 패스 질문 — 손상 프로브는 실사고 문장, 나머지는 키워드를 축자 포함(가드4로 복원 무발화). */
function anchorQuestion(c) {
  return PROBE_QUESTIONS[c.id] ?? `${c.keywords.join('와 ')}에 대해 알려줘.`;
}
```

### 6-3. L66 `digest()` — restoredFrom 조건부 스프레드

```js
    seeds: result.seeds.map((s) => ({
      keyword: s.keyword,
      tier: s.tier,
      ...(s.restoredFrom ? { restoredFrom: s.restoredFrom } : {}),
      matched: [...s.matched].sort(),
    })),
```

미복원 케이스의 JSON은 **한 글자도 바뀌지 않는다**.

### 6-4. main() — 2패스 구조

- **패스 A (기존, 무수정)**: `runSearch(session, { keywords: c.keywords })` — question 없음. 결정론 2회 검증도 현행 그대로. → 픽스처의 `cases` 필드.
- **패스 B (신규)**: 25건 **전건**에 question 부여.

```js
    // ── (B-2) 앵커 패스: 전건 question 부여 (완료조건 4의 오라클) ──
    const anchoredPass = [];
    for (const c of CASES) {
      const q = anchorQuestion(c);
      const r = await runSearch(session, { keywords: c.keywords, question: q });
      anchoredPass.push({ id: c.id, question: q, ...digest(r) });
    }
    // 결정론 2회차도 패스 A와 동일 방식으로 수행해 drift에 합산한다.
```

픽스처 최상위에 `anchoredCases: anchoredPass` 신규 필드 추가(`cases`와 `t2RawScores`는 위치·내용 무변경).

**왜 2패스인가(A1-7)**: 운영 경로는 항상 question을 넘기는데 골든이 23건을 question 없이 재면 "복원이 unmatched 분기 밖으로 새는 버그"가 있어도 전건 '동일'로 찍힌다 — 조건 4의 증거가 구조상 생성되지 않는다. 패스 A는 조건 5(부재 폴백)를, 패스 B는 조건 4(무개입)를 각각 증명한다.

### 6-5. 대조 기준 (문서에 못박을 것)

**비교 대상 = digest 9필드만**: `seeds[].{keyword,tier,restoredFrom?,matched}` · `unmatched` · `layer1.{nodeCount,relCount,truncated,nodeKgids,relKgids}` · `ftWarning`.
**비교 제외**: 파일 메타(`capturedStamp`·`determinism`·`graphSnapshot`·`comparison`)와 케이스 메타(`id`·`note`·`question`).
→ 이 규정 없이는 S20이 "바이트 동일"일 수 없다(A1-8).

M4 대조 명령(PowerShell, 저장소 루트에서):

```powershell
node --input-type=commonjs -e "const fs=require('fs');const r=p=>JSON.parse(fs.readFileSync(p,'utf8'));const a=r('mcp-server/fixtures/golden-searches.json'),b=r('mcp-server/fixtures/golden-searches-postM2.json');const D=x=>JSON.stringify({seeds:x.seeds,unmatched:x.unmatched,layer1:x.layer1,ftWarning:x.ftWarning});for(const k of ['cases','anchoredCases']){console.log('##',k);const m=new Map(b[k].map(c=>[c.id,c]));for(const c of a[k])console.log(c.id, D(c)===D(m.get(c.id))?'동일':'★변화');}"
```

### 6-6. M2 수용 판정표 (재캡처 후 이 표와 대조)

| 패스 | 케이스 | 개선 전 | 개선 후 기대 | 조건 |
|---|---|---|---|---|
| A·B | S01·S02·S03·S04·S05·S11·S12·S13·S14·S15·S16·S17·S18·S20·M02·M04·S06·S08·S09·S10·M01 | — | **바이트 동일(21건)** | 4·5 |
| A·B | **S07** | 5시드 / 13n·21r | 4시드 / **11n·18r**, 제거 노드 `n_69fdefdb99c1eb70`·`n_acec44b628d14f03`, 제거 관계 `r_f3231bb8f522f448`·`r_91b308e4671e840c`·`r_f93a98f9c3db0d39` | 3 |
| A·B | **M03** | 13n·21r | **11n·18r**, `재갈:T1[n5]` 불변, 제거 집합 S07과 동일 | 3 |
| A·B | **M05** | 15n·23r | **13n·20r**, `도깨비:T1[n5]` 불변, 제거 집합 S07과 동일 | 3 |
| A | S19 | seeds `[]` / unmatched `['일륨도']` / 0n·0r | **불변** (question 없음 → 복원 무발화) | 5 |
| B | **S19** | seeds `[]` / 0n·0r | `seeds=[{keyword:'일륜도',tier:'T1',restoredFrom:'일륨도',matched:['n1']}]` · `unmatched=[]` · **3n·2r**, nodeKgids `[n_69fdefdb99c1eb70, n_acec44b628d14f03, n_bcfe481dc38bafcd]`, relKgids `[r_f93a98f9c3db0d39, r_fed8ce82e1407251]` — **골든 S03의 layer1과 완전 동일** | 1 |
| A·B | **S20** | seeds `[]` / unmatched `['혐귀']` / 0n·0r | **완전 불변** | 2 |
| — | 결정론 | 2회 일치 | 2회 일치 유지 | — |

**추가 불변식(회귀 판정에 쓸 것)**: 델타 미선언 케이스는 `nodeKgids`·`relKgids`가 개선 전의 **부분집합**이어야 한다. 하한과 복원은 "제거" 또는 "새 키워드 그룹 추가"만 하므로, 선언되지 않은 kgid **추가**는 무조건 설계 결함이다.

---

## 7. 완료 조건 6개 ↔ 증명 1:1 매핑

| 조건 | 증명 수단 (1차) | 증명 수단 (2차·배선) |
|---|---|---|
| **1. `['일륨도']`+question '일륜도' → 시드 1건(일륜도:T1) + 교정 사실 공개** | `anchorRestore.test.js` #1 (`pickAnchorCandidate` → '일륜도') + #21 (`restorationLines`가 2줄 반환, 원본·복원어 포함) | 골든 **패스 B S19** digest === 골든 S03 layer1 + `restoredFrom:'일륨도'` + `unmatched: []` (실 Aura) |
| **2. `['혐귀']`+question '혈귀' → 여전히 시드 0건** | `anchorRestore.test.js` #2·#3·#4 (전부 `null` — `ANCHOR_MIN_KEYWORD_CHARS=3` 가드) | 골든 **S20** 패스 A·B 모두 개선 전과 완전 동일. 보강 증거: **S18('혈귀' 정상 표기)도 before/after 모두 unmatched** = "복원해도 그래프에 없다"의 직접 증거 |
| **3. `['네즈코']` → 하가네즈카 호타루 탈락, 정탐 **4건** 유지** | `seedFloor.test.js` #2 (생존 kgid 4개 집합 / 탈락 1개 집합) + #3 (1위 항상 생존) + #4 (재갈 함정) | 골든 **S07·M03·M05**: 시드 5→4, 13n·21r→11n·18r (M05는 15/23→13/20) |
| **4. 무개입 회귀 (적중 키워드 시드 계층·1층 규모 동일)** | `anchorRestore.test.js` #19 (정상 키워드 16 × 질문 16 = 256조합 전부 `null`) + #20 (`restorationLines([]) === []` → lines 바이트 동일) | 골든 **패스 B에서 21케이스 바이트 동일**(S07·M03·M05·S19 4건만 변화). 특히 S06·M01·M04(탄지로 T2)·S01·S02·S04가 깨지면 "복원이 unmatched 분기 밖에서 동작" 또는 "하한이 T1 침범"의 직접 증거 |
| **5. question 부재 시 현행 동작 무해 폴백** | `anchorRestore.test.js` #5·#6·#7 (`null`/`undefined`/`''` → `null`) | 골든 **패스 A 25케이스 전건**(question 미전달)에서 변화가 S07·M03·M05 3건뿐, **S19는 여전히 unmatched** |
| **6. 기존 248케이스 무수정 통과** | `npm test` (248 → 284). 기존 테스트 파일은 **한 줄도 건드리지 않는다** | 구조적 근거: `slice05.test.js`가 searchEngine에서 import하는 것은 `assembleLayer1`·`assignAliases`·`pickSummary`·`escapeLucene` 4개뿐이고 **네 개 모두 무수정**. `runSearch`·`kg_search`를 참조하는 기존 테스트는 0건(grep 전수), visualization-3d 183케이스는 searchEngine을 import하지 않음. `npm run lint` 클린 유지(신규 파일 전부 `.js`) |

---

## 8. 구현 순서 (각 단계의 `→ 확인:` 포함)

> 철칙: **문서가 코드보다 먼저.** 0단계 없이 1단계로 가지 않는다.

**0단계 — 문서 개정 + 게이트**
`TECH-SPEC.md` 4곳(§11의 문안 그대로) + `MAINTENANCE-PLAN.md` 정정(§9) + `DECISIONS.md` ADR 초안 + §10 오너 결정 회신.
→ 확인: 문서 diff 검토, 오너 승인 4건 수령.

**1단계 — 계측 공백 먼저 메우기 (코드 변경 전에!)**
`capture-golden.js`에 `--out`·`PROBE_QUESTIONS`/`anchorQuestion`·digest restoredFrom·앵커 패스 추가. **아직 searchEngine/kgSearch는 손대지 않은 상태**로 실행.
```powershell
Copy-Item mcp-server/fixtures/golden-searches.json mcp-server/fixtures/golden-searches.pre1.json
node scripts/capture-golden.js
```
→ 확인: ①새 파일의 `cases` 9필드가 `golden-searches.pre1.json`과 **전건 동일**(계측 확장이 기준선을 오염시키지 않았다는 자체 증명) ②`anchoredCases` 25건 신규 생성, S19가 여전히 `unmatched:['일륨도']`(복원 미구현이므로 당연) ③결정론 2회 일치. 확인 후 `.pre1.json` 삭제.

**2단계 — `shared/src/hangul.js` + `shared/tests/hangul.test.js`**
```powershell
npm test -w @bibliomind/shared
```
→ 확인: shared 50 → **64** 통과(2026-08-22 실측).

**3단계 — `searchEngine.js` 상수 3개 + `pickAnchorCandidate`(순수만) + `anchorRestore.test.js`의 #1~#19**
```powershell
npm test -w @bibliomind/mcp-server ; npm run lint
```
→ 확인: mcp-server 13 → 32 통과. **아직 runSearch는 미수정** — 골든 재캡처하면 변화 0건이어야 한다(선택 검증).

**4단계 — `matchKeyword` 추출 + T2 하한 + `seedFloorCuts` + 루프 교체 + `seedsReport`**
```powershell
npm test ; npm run lint
```
→ 확인: 전 워크스페이스 통과. `seedFloor.test.js` 4케이스 추가 후 재실행.

**5단계 — `kgSearch.js`** (question 전달 · describe · `restorationLines` · stderr · data) + `anchorRestore.test.js` #20·#21
```powershell
npm test ; npm run lint ; npm run mcp:smoke
```
→ 확인: **287케이스** 통과(현재 262 + anchorRestore 21 + seedFloor 4), lint 클린, tools/list 정상 응답(stdout 오염 없음).

**6단계 — 개선 후 캡처와 대조 (M2 수용 판정)**
```powershell
node scripts/capture-golden.js --out mcp-server/fixtures/golden-searches-postM2.json
```
→ 확인: §6-5의 대조 명령 실행 → **§6-6 판정표와 완전 일치**. 특히 `cases` 21건 동일 / `anchoredCases` 21건 동일, 변화는 S07·M03·M05(+패스 B의 S19)뿐.

**7단계 — 사람이 보는 문구 1회 육안 확인**
판정 창(GraphRAG_1st 루트)에서 `kg_search(keywords:['일륨도'], question:'일륜도가 뭐야?')` 1회 → 요약에 다음 4줄이 뜨는지 확인.
```
[bibliomind] kg_search 결과 — 상태: 성공
시드 1건(일륜도:T1) · 1층 노드 3·관계 2
키워드 자동 재검색 1건: '일륨도'는 그래프에 없어, 이 호출의 question에서 자모 1개만 다른 '일륜도'로 다시 검색함 (자동 추정 — 확정된 오타 판정이 아니다)
답변 본문에 이 재검색 사실을 밝혀라 — …
```
→ 확인: 상태가 '부분 성공'→'성공'으로 반전(= A3 반전). **판정 오염 방지 프로토콜 준수**(동시 1개 클라이언트, 판정 문항 사이 프로브 금지).

**8단계 — M2 게이트 보고** → 승인 후 M3.

---

## 9. `MAINTENANCE-PLAN.md` 정정 문안 (0단계에서 적용)

**(a) M2 완료조건 3** — 현재 "하가네즈카 호타루(0.6402) **시드 탈락**, 정탐 3건(1.6334/1.3561/1.0123) 유지"

> 3. `keywords=['네즈코']` → 시드 **5건 → 4건**. 탈락은 하가네즈카 호타루(0.6402 = 1위 대비 39.19%) **1건뿐**이고, 잔존 4건은 카마도 네즈코(1.6334) · 네즈코의 도깨비화(1.3561) · 네즈코의 탄지로 공격(1.3561) · 기유가 네즈코에게 재갈을 물린 사건(1.0123)이다. *(1.3561이 서로 다른 두 노드에 중복 부여돼 있어 이전 문구의 "3건"은 서로 다른 점수값의 개수였다 — 2026-08-22 픽스처 대조로 정정.)*
>    **동반 효과(오너 승인 항목)**: 하가네즈카 호타루가 시드에서 빠지면 그 1홉 이웃인 **일륜도 노드(`n_acec44b628d14f03`)도 1층에서 함께 사라진다**(하가네즈카 경유 1홉이 유일 경로였음 — 카마도 탄지로→일륜도는 네즈코 시드 기준 2홉이라 hops=1에서 도달 불가). 실측 델타: S07 13n·21r → **11n·18r**, M03 13n·21r → **11n·18r**, M05 15n·23r → **13n·20r**. 회귀로 오인하지 말 것.

**(b) 패널 신규 발견 1** — "소규모라 미발현, 슬라이스 2 규모 리허설에서 즉시 발현"

> → "**토큰 조합에 따라 현 29노드 규모에서도 발현 확인(2026-08-22 실측)**. 8키워드 조합에서 이론 시드합 26 → 절단 후 23건이 되며, 이때 '기유'의 1위 시드(토미오카 기유 1.1295)가 절단되고 하위 시드만 남는 사례를 재현했다. 원인은 동일 kgid가 여러 키워드 그룹에 중복 등장해 상위 15 슬롯을 잠식하기 때문. M2의 앵커 복원은 미적중 키워드를 시드 공급자로 바꾸므로 이 압력을 키운다. **이번 범위 밖** — 개선 큐에 '전역 절단 시 계층 무시 정렬 + kgid 중복 슬롯 소비' 2항목으로 등재."

**(c) M1 실행 명령** — `tools/check-keywords.mjs` → `scripts/check-keywords.js`

> 근거: `GraphRAG_1st`에 `tools/` 디렉터리는 없고(전수 확인), 루트 lint 범위는 `eslint shared pipeline mcp-server scripts`다. 게다가 `eslint.config.js`의 globals 블록이 `files: ['**/*.js']`로 한정돼 `.mjs`에는 node 전역이 주입되지 않아 `process`·`console`이 `no-undef`로 걸린다. 저장소 관례(`scripts/capture-golden.js`·`scripts/setup.js`)에 맞춰 `scripts/check-keywords.js`로 확정한다.

**(d) 임계값 근거 문구 정직화** (오너 결정 표 ① 옆 주석)

> "20종 전수 실측"은 표본을 과대표시한다. **워터폴에서 T2에 실제로 도달하는 키워드는 5종**이고, ratio<1.0인 비교점을 만드는 것은 3종·**비교점 6개**(0.8302×3, 0.6197×2, 0.3919)다. 임계 50%의 실효 근거는 이 6점 위의 자연 간극(39.2% ↔ 62.0%)이다. **재측정 조건**: `seedFloorCuts` 관측 로그로 비교점 **n ≥ 30** 확보 시 재검토.

**(e) 오픈 질문에서 `scripts/_tmp-m2-probe.mjs` 항목 삭제** — 저장소에 존재하지 않음(전수 확인).

---

## 10. 오너 결정 4건 — **2026-08-22 전건 마감 (다시 묻지 말 것)**

> **회신 결과**: ① 일륜도 동반 소실 **승인** · ② 정탐 3건→4건 정정 **승인** · ③ 두 글자 키워드 복원 제외(MIN=3) **승인** · ④ 복원 실패 표기 **안 함(현행 유지)**.
> 근거·미채택 대안은 `DECISIONS.md` 2026-08-22 M2 항목. 아래 원문은 판단 근거 보존용이며 **재질의 대상이 아니다.**

### (원문 — 결정 근거 보존용)

> 이사님, 아래 4건만 결정해 주시면 M2 착수합니다. 나머지는 전부 설계에서 확정했습니다.

### ① "네즈코" 질문에서 **일륜도**가 그림에서 사라집니다 — 승인하시겠습니까?

지금은 "네즈코"로 검색하면 **하가네즈카 호타루**(대장장이)가 우연히 이름 글자가 겹쳐서 딸려 나옵니다. 이번에 그 오탐을 끊습니다. 그런데 그 대장장이를 통해서만 이어져 있던 **일륜도(칼)**도 화면에서 같이 빠집니다. "네즈코가 쓰는 칼" 같은 질문은 오늘은 답이 되지만 개선 후에는 근거를 잃습니다.

- **A안(권고)**: 승인. 오탐 제거가 목적이고, 일륜도는 "탄지로"로 물으면 그대로 나옵니다.
- **B안**: 임계값을 낮춰 대장장이를 남긴다 → 오탐이 그대로 남습니다(이번 개선의 목적이 사라집니다).

### ② 계획서의 숫자 오기 정정 — "정탐 3건"이 실제로는 **4건**입니다

계획서에는 "정탐 3건 유지"라고 적혀 있는데, 실제 기준선 파일을 다시 세어 보니 **4건**입니다(1.3561점이 서로 다른 두 노드에 똑같이 붙어 있어 점수 종류 3개를 건수 3개로 잘못 적은 것입니다). 이대로 두면 정상 구현이 시험에서 헛되이 실패하고, 그것을 맞추려다 오너님이 확정하신 **50% 기준 자체가 무너집니다**(1.0123을 자르려면 62%를 넘겨야 합니다).

- **권고**: 계획서 문구를 "5건 → 4건, 탈락은 하가네즈카 호타루 1건"으로 정정 승인.

### ③ **두 글자 키워드**는 자동 재검색 대상에서 빼겠습니다 — 승인하시겠습니까?

모델이 글자를 망가뜨렸을 때 질문 원문을 보고 되살리는 기능인데, **두 글자짜리는 위험**합니다. 실측해 보니 "마음"을 "마을"로, "이간"을 "인간"으로 바꿔치기합니다. 사용자가 진짜로 "마음"을 물었는데 시스템이 멋대로 "마을"로 바꿔 검색하고 "교정했습니다"라고 보고하는 일이 생깁니다 — 오너님이 확정하신 "그래프에 없으면 없다가 정답" 원칙이 정면으로 깨집니다.

- **A안(권고)**: 세 글자 이상만 되살린다. 실측 결과 잘못된 되살림이 **5종 → 0종**이 되고, 세 글자 이상 이름은 **47,450가지 손상을 100% 되살립니다**. 대신 "마을·인간·재갈" 같은 두 글자 노드는 손상되면 못 고칩니다(→ "없습니다"라고 답합니다. 지금과 같습니다).
- **B안**: 두 글자도 되살린다 → 위 오작동을 감수.

### ④ 되살리기에 **실패**했을 때, 그 사실을 사용자에게 알릴까요?

예: 모델이 "혐귀"라고 썼고 질문에는 "혈귀"가 있었지만, 그래프에는 "혈귀"라는 이름 자체가 없습니다. 지금 설계는 **조용히** "그래프에 없는 키워드: 혐귀"라고만 답합니다.

- **A안(권고)**: 지금대로 조용히. 이유 — 이 문구는 이미 통과한 판정 문항(E1)의 비교 기준이라, 문구를 바꾸면 다음 재판정에서 "같은 결과인지" 대조하기 어려워집니다.
- **B안**: "혐귀(질문의 '혈귀'로도 찾지 못함)"처럼 더 자세히. 시드 수·결과는 전혀 안 바뀌고 문장만 바뀝니다.

---

## 11. TECH-SPEC 개정 문안 (4곳) — §12 참조

`techspec_amendments` 필드에 전문을 담았다. 요약: §6.2.3에 앵커 복원 절차 절 신설 / §6.3 단계 2에 점수 하한 문장 + §6.4 상한 표 3행 추가 / §4.3-13 과잉 인용 경고 문구 서술형 전환 / §1.14 가정표 7행 신설.

---

## 12. 구현자 체크리스트 (커밋 전 자가 점검)

- [ ] `if (kept.length > 0) { tier = 'T2'; records = kept; }` **형태**로 썼는가(빈 records로 tier를 굳히지 않았는가)
- [ ] 하한을 **곱셈형** `raw >= t2Top * SEEDS_MIN_SCORE_RATIO`로 썼는가(나눗셈·NaN 비교 금지)
- [ ] `t2Top`을 `records[0]`이 아니라 명시적 `reduce(max)`로 구했는가
- [ ] `pickAnchorCandidate` 호출이 **`records.length === 0` 분기 안에만** 있는가
- [ ] 복원 재조회에 `{ allowT3: false }`를 넘겼는가
- [ ] `unmatched.push(keyword)` — 복원어가 아니라 **원 키워드**인가
- [ ] `seedsReport`의 `restoredFrom`이 **조건부 스프레드**인가
- [ ] `restorationLines`가 `matched.length > 0`을 요구하는가
- [ ] `console.log` 0건 · 진단은 전부 `console.error`인가
- [ ] 신규 파일이 전부 `.js`인가(`.mjs`는 lint를 깬다)
- [ ] `new URL(..., import.meta.url)` — cwd 기준 경로 0건인가
- [ ] TypeScript 0줄 · 신규 의존성 0개 · 기존 테스트 파일 diff 0줄인가


---

# 부록 — TECH-SPEC 개정 문안 초안

## TECH-SPEC 개정 문안 초안 (M0 요구 4곳 + §6.4 상한 표)

---

### 개정 ① — §6.2.3 「확정: 3계층 시드 매칭 워터폴 (A+B 하이브리드)」 말미, graceful degradation bullet **다음**에 신설

> **질문 원문 앵커 복원 (v2.3 — 유지보수 M2, 2026-08-22 신설)**
>
> 워터폴 세 계층이 **모두 미적중한 키워드에 한해**, 도구가 받은 `question` 문자열을 앵커로 삼아 1회만 복원을 시도한다. 챗 LLM이 한글 키워드를 자모 수준에서 손상시키는 현상(2026-08-22 실측 2/37 토큰 = 5.4%, Wilson 95% CI 1.5~17.7%. 일륜→일륨 U+B95C→U+B968 / 혈→혐 U+D608→U+D610, 둘 다 초·중성 보존·종성만 치환)이 **거짓 부재**(그래프에 있는 자료를 "없습니다"라고 답함)를 만들기 때문이다.
>
> **절차** (`searchEngine.js`의 순수 함수 `pickAnchorCandidate(keyword, question)`)
> 1. `question`이 문자열이 아니거나 빈 문자열이면 복원하지 않는다(현행 동작 폴백).
> 2. 키워드를 `nameKey()`로 정규화한다. 한글 음절+공백 이외의 문자가 있으면 복원하지 않는다.
> 3. 키워드가 `ANCHOR_MIN_KEYWORD_CHARS`(=3) 글자 미만이면 복원하지 않는다.
> 4. 정규화한 `question`에 키워드가 **축자 존재하면 복원하지 않는다** — 손상이 아니라 사용자 본인의 표기이므로 "그래프에 없습니다"가 정답이다(오너 확정 '공백 가시화' 원칙).
> 5. `question`을 구두점으로 런 분할한 뒤, **키워드와 같은 글자 수**의 슬라이딩 창을 뽑는다. 창은 **어절 시작에 정렬**되어야 한다(창 앞 문자가 공백이거나 런의 시작). 한국어는 교착어라 우측에는 조사가 붙으므로 우측 경계는 요구하지 않는다.
> 6. 각 창과 키워드의 **자모 편집거리**(`shared/src/hangul.js` — 음절을 초·중·종성 토큰으로 편 배열 위의 Levenshtein)가 1 이상 `ANCHOR_MAX_JAMO_DISTANCE`(=1) 이하인 창을 후보로 모은다.
> 7. 후보가 **정확히 1종일 때만** 복원한다. 0건이거나 2종 이상(모호)이면 복원하지 않는다.
> 8. 복원어는 **T1 → T2(점수 하한 적용)까지만** 재조회한다. **T3 CONTAINS는 타지 않는다** — 복원은 이미 신뢰도가 한 단계 낮은 경로이므로 가장 느슨한 부분일치 계층을 더하지 않는다(T3 역방향 절은 4자 이상 복원어가 짧은 노드를 끌어오는 통로다).
> 9. 재조회가 0건이면 아무 흔적도 남기지 않는다 — `unmatched`에는 **원 키워드**가 그대로 남고, 교정 안내도 출력하지 않는다.
>
> **안전성 근거 4중**
> - **후보 봉쇄**: 후보는 오직 `question`의 부분 문자열이다. 시스템이 문자열을 만들어내는 경로가 없다(종성 전수 치환 후 DB 조회 같은 '그래프 쪽 추측'은 명시적으로 기각).
> - **동일 워터폴 재사용**: 복원어도 T1/T2라는 기존 매칭 규칙을 통과해야만 시드가 된다. 유사도 조회 같은 신규 매칭 규칙은 없다.
> - **거리 1 + 3글자 하한**: 2음절은 자모 거리 1 이웃이 일상 한국어와 겹쳐 '손상이 아닌 별개 단어'를 바꿔치기한다(실측 5종). 3글자 이상에서 오복원 0종, 3자 이상 이름의 단일 자모 손상 47,450 변형 회복률 100%.
> - **순수 가산 배치**: 복원 호출은 `records.length === 0` 분기 안에만 존재하므로 적중 경로에 무개입이다.
>
> **신뢰 경계**: `question`은 챗 LLM이 채우는 자유 문자열이며 사용자 원문이라는 보장이 없다(실기록에 '검증: 일륜도' 같은 비-사용자 문자열 확인). 따라서 ①도구 스키마 설명문이 "사용자가 입력한 문장 그대로 — 요약·재작성·번역·접두어 부착 금지"를 요구하고 ②사용자 노출 문구는 "질문 원문"이 아니라 "이 호출의 question"이라고 말하며 ③직전 어시스턴트 텍스트로 앵커를 확장하는 것은 **오프라인 계측기 전용**이고 런타임에 반입하지 않는다.
>
> **재측정 조건**: 손상 표본 n=2로 세운 "종성→ㅁ" 가설은 확정이 아니다. 슬라이스 2 규모에서 손상 표본 n≥10 확보 시 거리 상한·글자 수 하한을 재검토한다.

---

### 개정 ② — §6.3 「단계 2 — 시드 매칭」 첫 bullet 아래에 2문장 추가

기존:
> - 키워드별로 §6.2.3 워터폴 실행. **키워드당 상위 5개, 전체 시드 15개** 상한(점수순 절단).

개정 후:
> - 키워드별로 §6.2.3 워터폴 실행. **키워드당 상위 5개, 전체 시드 15개** 상한(점수순 절단).
> - **T2 점수 하한(v2.3 — 유지보수 M2, 2026-08-22 신설)**: T2는 추가로 **그 키워드의 T2 1위 점수 대비 비율 하한**(`SEEDS_MIN_SCORE_RATIO = 0.5`, 판정식 `raw >= top × ratio`, 경계 포함)을 통과한 것만 시드로 승격한다. **하한은 tier 확정보다 먼저 적용하며, 통과 항목이 0건이면 tier를 굳히지 않고 T3로 강등된다** — 빈 records로 `tier='T2'`를 확정하면 T3 폴백을 건너뛰는 조용한 미적중이 생긴다. 기준점이 **키워드별 1위**인 이유: Lucene 원점수는 쿼리 간 비교가 불가능하다(idf·길이 정규화가 쿼리마다 다르다 — 같은 그래프에서 정답 1위 점수가 1.1295~6.7828로 6배 벌어진다). 전역 1위 기준은 실측에서 12조합 중 6조합의 결과를 바꾸고 3조합에서 한 키워드의 T2를 전멸시켜 기각했다. T1(리터럴 1.0)·T3(리터럴 0.5)는 모든 행의 비율이 1.0이므로 하한 대상이 아니다.
> - 하한에 잘린 후보는 `seedFloorCuts`(키워드·이름·kgid·점수·1위점수·비율)로 반환해 관측한다. 임계값 재조정의 유일한 근거 데이터이므로 **stderr NDJSON 1줄**로도 남긴다(stdout은 JSON-RPC 전용). 잘린 항목이 0건이면 아무것도 출력하지 않는다.
> - **임계 0.5의 근거와 재측정 조건**: 근거는 2026-08-22 골든 픽스처의 **워터폴 실효 경로 3키워드·비교점 6개**(0.8302×3, 0.6197×2, 0.3919)에 나타난 자연 간극(39.2% ↔ 62.0%)의 중앙이다("20종 전수"가 아니다 — T2에 실제로 도달하는 키워드는 5종뿐이다). `seedFloorCuts` 관측으로 **비교점 n ≥ 30**이 쌓이면 재측정한다.
> - **알려진 부작용**: 시드가 빠지면 그 시드를 경유해서만 도달하던 1홉 이웃도 1층에서 함께 사라진다(실측: '네즈코' 질의에서 하가네즈카 호타루 탈락 → 일륜도 동반 소실, 13n·21r → 11n·18r). 회귀가 아니라 설계된 결과이며, 골든 픽스처의 예상 델타에 kgid 단위로 선언한다.

**§6.4 상한 기본값 요약표에 3행 추가**

| 항목 | 기본값 | 상한 | 선정 근거 |
|---|---|---|---|
| T2 점수 하한 비율 | 0.5 | — | 그 키워드의 T2 1위 대비. 실효 비교점 6개의 자연 간극(39.2%↔62.0%) 중앙. 슬라이스 2에서 n≥30 확보 시 재측정 |
| 앵커 복원 자모 편집거리 | 1 | — | 실측 손상 2건 모두 거리 1(종성 단일 치환). 거리 2는 복원 시도 0건(의도된 보수성) |
| 앵커 복원 최소 키워드 글자 수 | 3 | — | 2음절은 거리 1 이웃이 일상 한국어와 겹쳐 오복원(마음→마을 등). 3글자 이상에서 오복원 0종 |

---

### 개정 ③ — §4.3-13 `kg_cite` 「과잉 인용 경고」 문장 교체

기존:
> **과잉 인용 경고(v2.2 총감사 반영)**: 제출 별칭 수가 해당 검색 1층의 50%를 초과하면 요약에 "과잉 인용 의심 — 2층의 변별력이 낮습니다" 1줄을 동봉한다(존재성 검증의 한계 보완 — §6.5.1).

개정 후:
> **인용 밀도 안내(v2.3 — 유지보수 M3에서 문구 정직화, 2026-08-22)**: 제출 별칭 수가 해당 검색 1층의 50%를 초과하면 요약에 **"1층의 n건 중 m건을 인용했습니다 — 2층이 1층과 거의 같아 강조 대비가 낮습니다"** 1줄을 동봉한다. **비난형("과잉 인용 의심")이 아니라 서술형**으로 쓴다: 스파이크 21문에서 이 경고는 **4회 전부 오탐**이었다(A4 1층 3건 중 2건 / A2 9건 중 5건 / B3 13건 중 7건 — 질문이 "그가 한 일 전부"였으므로 1층 대부분이 실제 근거였다 / E3). 즉 이 신호는 "인용이 잘못됐다"가 아니라 "이 검색은 1층이 작아 2층 대비가 안 난다"는 **화면 가독성 정보**다. 모델이 정당한 인용을 철회하도록 유도해서는 안 된다. 1층 최소 규모 문턱(예: 10건 미만이면 억제)은 실측 오탐 3건 중 B3(13건)을 못 잡으므로 **도입하지 않는다** — 문구 수정만으로 처리한다.

---

### 개정 ④ — §1.14 「미검증 가정 총괄과 검증 시점」 표에 **7행** 신설

| # | 가정 | 틀렸을 때의 파급 | 검증 계획 |
|---|---|---|---|
| 7 | (v2.3 신설 — 유지보수 M2 반영) 챗 LLM이 도구 인자로 넘기는 **한글 키워드의 표기 무결성** — 즉 모델이 질문에 등장한 이름을 자모 수준에서 손상시키지 않고 그대로 전달한다는 가정 | **거짓 부재**: 그래프에 있는 자료를 "없습니다"라고 답한다. 시스템(정규화·저장·검색)은 무결한데 결과만 틀리므로 원인이 "정규화 결함"으로 오귀인되기 쉽다(2026-08-22 A3·B4에서 실제 발생) | **반증 완료(2026-08-22) — 가정은 거짓이다.** 실측 손상률 **2/37 토큰 = 5.4%**(Wilson 95% CI 1.5~17.7%), 발생 모델 Opus·Fable 양쪽. 사례: 일륜→일륨(U+B95C→U+B968, 종성 4→16) / 혈→혐(U+D608→U+D610, 종성 8→16) — 둘 다 초·중성 보존, 종성만 ㅁ으로 치환(n=2, "종성→ㅁ" 기전은 미확정). 결정적 반증 실행: 동일 서버에 "일륜도"(정상 표기) 검색 시 `시드 1건(일륜도:T1)` 적중, "일륨도"만 0건. **대책** = §6.2.3 질문 원문 앵커 복원(런타임) + `scripts/check-keywords.js`(오프라인 계측기 — 판정 기록의 keywords↔질문을 자모 편집거리로 대조해 기 발생 2건을 재현 검출, 정상 토큰은 무경보). **재측정**: 슬라이스 2 규모에서 손상 표본 n≥10을 모아 손상률·손상 유형(초성/중성/종성) 분포를 갱신하고, 앵커 복원의 거리 상한·글자 수 하한을 재검토한다. **한계 명시**: 앵커 복원은 손상어와 정상 표기가 **같은 호출의 question 안에** 있을 때만 성립한다. E1처럼 정상 표기가 모델 자신의 답변에만 등장한 경우는 런타임 복원 불가이며, 이는 계측기로만 검출한다(그래프에 대상 자체가 없으므로 결과에는 무영향) |

