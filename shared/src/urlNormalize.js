// URL 정규화 — S1 수집 멱등 스킵 키의 기술 기반 (TECH-SPEC §2.4.4).
// 규칙 순서: scheme·host 소문자 → 기본 포트 제거 → fragment 제거 →
// 추적 파라미터 제거 후 잔여 쿼리 키 정렬 → 경로 끝 `/` 제거(루트 제외) →
// 퍼센트 인코딩 대문자 통일. 경로의 대소문자는 보존한다(서버가 구분할 수 있음).

/** 접두 utm_* 외에 제거하는 추적 파라미터 명시 목록 (코드 상수 — §1.9 원칙). */
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'yclid',
  'igshid', 'mc_cid', 'mc_eid', 'ref_src', 'spm',
]);

/**
 * URL을 결정적 정규형으로 변환한다. 멱등: normalizeUrl(normalizeUrl(u)) === normalizeUrl(u).
 * WHATWG URL을 쓰므로 IDN 호스트는 퓨니코드 형태가 정규형이다.
 * 루트 경로의 정규형은 슬래시 유지("https://x.com/").
 * @param {string} raw
 * @returns {string} 정규화된 절대 URL
 */
export function normalizeUrl(raw) {
  const url = new URL(String(raw).trim());
  // scheme·host 소문자화와 기본 포트(:80/:443) 제거는 URL 파서가 수행한다.
  url.hash = '';
  for (const key of new Set(url.searchParams.keys())) {
    if (/^utm_/i.test(key) || TRACKING_PARAMS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort(); // 키 정렬 — 동일 키의 값 순서는 보존된다.
  if (url.pathname !== '/' && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  // 퍼센트 인코딩 대문자 통일 — 디코딩은 하지 않는다(이중 인코딩·의미 변화 방지).
  return url.href.replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase());
}
