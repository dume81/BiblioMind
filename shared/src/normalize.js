// 정규화·식별자 단일 구현 (TECH-SPEC §2.3.2·§3.5).
// 병합 키·kgid·검색 T1이 전부 이 한 파일을 import한다 — 다른 곳에 재구현 금지.
import { createHash } from 'node:crypto';

/** kgid 해시 구분자 U+001F — 이름·라벨에 등장할 수 없는 제어 문자 (TECH-SPEC §3.5). */
const US = '\u001f';

/**
 * 표시 이름 → 병합 키(name_key). **노드 name 전용이다** —
 * 라벨·관계 유형에 적용하면 소문자화가 PascalCase 명명 규칙과 kgid의
 * 라벨 성분(원형 유지)을 깨뜨린다 (전문가 패널 지적 — 적용 금지).
 * 순서 고정: NFC → trim → 연속 공백 축약 → 소문자화. NFKC는 배제(과병합 방지 — §2.3.2).
 * @param {string} name
 * @returns {string}
 */
export function nameKey(name) {
  return String(name)
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * sha256(UTF-8) 16진수 앞 16자.
 *
 * 원장 키(§2.4.4 — 정규화 URL·파일 내용 해시)도 같은 방식이므로 **export한다**
 * (2026-08-22 슬라이스 3). 프로젝트 철칙상 정규화·해시는 이 모듈의 단일 구현만
 * import하며 재구현하지 않는다.
 * @param {string} text
 * @returns {string}
 */
export function sha16(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 노드 kgid — 콘텐츠 안정 식별자. label은 **원형 표시 라벨**(소문자화 금지).
 * @param {string} label 표시 라벨 (예: "Person")
 * @param {string} key nameKey() 산출값
 * @returns {string} 예: "n_bcfe481dc38bafcd"
 */
export function nodeKgid(label, key) {
  return 'n_' + sha16(label + US + key);
}

/**
 * 관계 kgid — 방향성 보존(start/end 교환 시 다른 값).
 * @param {string} startKgid 시작 노드 kgid
 * @param {string} type 관계 유형 (예: "MEMBER_OF")
 * @param {string} endKgid 끝 노드 kgid
 * @returns {string} 예: "r_6bb0fff48ffddc38"
 */
export function relKgid(startKgid, type, endKgid) {
  return 'r_' + sha16(startKgid + US + type + US + endKgid);
}
