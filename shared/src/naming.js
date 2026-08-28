// 파일명 규칙 v2 · Windows sanitize (TECH-SPEC §1.13-4·5, §2.4.2).
// 원제목은 절대 여기서 보존하지 않는다 — 무손실 보존은 프론트매터(original_file/title) 몫.

/** Windows 파일명 금지 문자 9종 — 백슬래시 포함(스펙 표의 `\|`는 마크다운 이스케이프, 실제는 \ 와 | 둘 다 금지). */
const FORBIDDEN_RE = /[<>:"/\\|?*]/g;

/** 제어 문자 0x00–0x1F — 치환이 아니라 제거한다. */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f]/g;

/** Windows 예약 이름 — 대소문자 무시 (TECH-SPEC §1.13-4). */
const RESERVED_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/**
 * 파일명 "메인이름"을 Windows 안전 문자열로 정리한다.
 * 규칙 순서: NFC → 제어문자 제거 → 금지문자 9종 `_` 치환 → trim →
 * 코드포인트 기준 절단(기본 80자 — MAX_PATH 260 대응, §1.13-5) →
 * 끝 공백·마침표 제거(절단 후 재검사) → 빈 문자열 폴백 → 예약 이름 회피(`_` 접미).
 * @param {string} raw
 * @param {{ maxCodePoints?: number }} [options]
 * @returns {string}
 */
export function sanitizeWindowsName(raw, { maxCodePoints = 80 } = {}) {
  let name = String(raw)
    .normalize('NFC')
    .replace(CONTROL_RE, '')
    .replace(FORBIDDEN_RE, '_')
    .trim();
  const points = Array.from(name);
  if (points.length > maxCodePoints) name = points.slice(0, maxCodePoints).join('');
  name = name.replace(/[. ]+$/, '');
  if (name === '') name = 'untitled';
  if (RESERVED_RE.test(name)) name = name + '_';
  return name;
}

/**
 * Input 파일 stem 조립 — `yyyymmddhhmmss_메인이름_pNN` (TECH-SPEC §2.4.2).
 * 배치 타임스탬프는 배치 시작 시 1회 고정해 전달한다(파일마다 새로 만들지 않는다).
 * @param {string} batchTimestamp 예: "20260821143012"
 * @param {string} mainName sanitizeWindowsName() 통과 값
 * @param {number} pageNumber 1부터
 * @returns {string} 예: "20260821143012_bibliomind_p01"
 */
export function buildStem(batchTimestamp, mainName, pageNumber) {
  const nn = String(pageNumber).padStart(2, '0');
  return `${batchTimestamp}_${mainName}_p${nn}`;
}

/**
 * stem → 산출물 파일명 파생 (1:1 고정 — TECH-SPEC 정본표).
 * @param {string} stem
 * @returns {string} 예: "20260821143012_bibliomind_p01.kg.json"
 */
export function kgFileName(stem) {
  return `${stem}.kg.json`;
}

/**
 * stem → 반려 파일명 파생 (N = 원장 reject_count 회차 — TECH-SPEC §2.4.2).
 * @param {string} stem
 * @param {number} rejectCount 1부터
 * @returns {string} 예: "20260821143012_bibliomind_p01.kg.rej2.json"
 */
export function rejectedFileName(stem, rejectCount) {
  return `${stem}.kg.rej${rejectCount}.json`;
}
