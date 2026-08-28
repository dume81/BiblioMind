// 시각 표기 단일 구현 (TECH-SPEC §2.4.3 — 프론트매터·원장·산출물 meta 공통 규약).
//
// 같은 함수가 crawl·extract·generate·review 네 곳에 복사돼 있던 것을 여기로 모았다.
// 복사본이 늘면 한 곳만 고쳐진 채 표기가 갈라진다 — normalize.js를 단일 구현으로 두는 것과 같은 이유다.

/**
 * ISO 8601 +09:00(한국 표준시) 문자열. 실행 환경의 표준시와 무관하게 항상 +09:00으로 적는다.
 * @param {Date} [now]
 * @returns {string} 예: "2026-08-23T14:30:12+09:00"
 */
export function isoKst(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const kst = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60000);
  return `${kst.getFullYear()}-${p(kst.getMonth() + 1)}-${p(kst.getDate())}`
    + `T${p(kst.getHours())}:${p(kst.getMinutes())}:${p(kst.getSeconds())}+09:00`;
}
