// 정본 엔티티 정규화 — 갈라진 노드를 주입 단계에서 하나로 모은다 (TECH-SPEC §2.3.2 v2.8).
//
// **왜 생겼나 (2026-08-23 실측)**: 같은 회사가 `리디안솔루션`과 `리디안솔루션(주)` 두 노드로
// 갈라져, *"리디안솔루션은 무엇을 하는 회사야?"* 한 번에 **거짓 부재 2건**이 나왔다
// (설립 연도·고객사 명단이 그래프에 있는데 "없다"고 답했다). 검색도 챗도 정상이었고
// 데이터가 갈라진 것이 원인이었다.
//
// **왜 재생성이 아니라 사전인가**: `instructions_ko`에는 이미
// *"같은 대상은 반드시 같은 name으로 쓴다"* 가 있었고 **그런데도 갈라졌다.**
// §2.1.5가 *"지시문만으로 완전히 강제할 수 없다"* 고 예고했고, 같은 절이 유사 이름 쌍
// 리포트를 **"반복 검출 시 별칭 사전을 앞당기는 트리거"** 로 규정했다 — 그 트리거가 발동했다.
// 정규화는 결정론적이라 모델 비결정성에 좌우되지 않는다.
//
// **과병합 방지 (§2.3.2의 핵심 우려)**: 사전은 **사람이 명시한 항목만** 합친다.
// 이름이 비슷하다고 자동으로 합치지 않는다 — 그 판단은 여전히 유사 이름 쌍 리포트가
// 후보만 올리고 사람이 내린다.

import { nameKey } from '@bibliomind/shared/normalize';

/** 구분자 U+001F — 라벨·이름에 등장할 수 없어 키 충돌이 없다(§3.5와 같은 규약).
 *  소스에 제어문자를 그대로 두면 편집기·패치에서 깨지므로 이스케이프로 쓴다. */
const US = '\u001f';

/** @param {string} label @param {string} name */
const keyOf = (label, name) => `${label}${US}${nameKey(name)}`;

/**
 * 스키마의 `canonical_entities`를 조회용 색인으로 만든다.
 *
 * 형식:
 * ```json
 * { "canonical": { "label": "Organization", "name": "리디안솔루션(주)" },
 *   "variants": [{ "label": "Organization", "name": "리디안솔루션" }],
 *   "note": "법인 정식 명칭으로 통일" }
 * ```
 * @param {{ canonical_entities?: object[] }} schema
 * @returns {{ index: Map<string, {label: string, name: string}>, problems: string[] }}
 */
export function buildCanonicalIndex(schema) {
  const index = new Map();
  const problems = [];
  const canonicalKeys = new Set();

  for (const entry of schema?.canonical_entities ?? []) {
    const c = entry?.canonical;
    if (!c?.label || !c?.name) {
      problems.push(`canonical_entities 항목에 canonical.label/name이 없습니다: ${JSON.stringify(entry)}`);
      continue;
    }
    canonicalKeys.add(keyOf(c.label, c.name));
    for (const v of entry.variants ?? []) {
      if (!v?.label || !v?.name) {
        problems.push(`"${c.name}"의 variants 항목이 올바르지 않습니다: ${JSON.stringify(v)}`);
        continue;
      }
      const k = keyOf(v.label, v.name);
      if (k === keyOf(c.label, c.name)) continue; // 자기 자신 — 무해하므로 조용히 넘긴다
      if (index.has(k)) {
        problems.push(`변형 "${v.label}/${v.name}"이 두 정본에 중복 등록됐습니다.`);
        continue;
      }
      index.set(k, { label: c.label, name: c.name });
    }
  }

  // **연쇄 금지**: A→B, B→C 를 허용하면 순서에 따라 결과가 달라져 멱등성이 깨진다.
  // 정본이 다른 항목의 변형으로도 등록돼 있으면 사전 자체가 잘못된 것이다.
  for (const k of canonicalKeys) {
    if (index.has(k)) problems.push(`정본이 다른 항목의 변형으로도 등록됐습니다(연쇄): ${k.replace(US, '/')}`);
  }
  return { index, problems };
}

/**
 * (라벨, 이름)을 정본으로 바꾼다. 사전에 없으면 **그대로 돌려준다** — 모르는 것은 건드리지 않는다.
 * @param {Map<string, {label: string, name: string}>} index
 * @param {string} label
 * @param {string} name
 * @returns {{ label: string, name: string, changed: boolean }}
 */
export function canonicalize(index, label, name) {
  const hit = index.get(keyOf(label, name));
  if (!hit) return { label, name, changed: false };
  return { label: hit.label, name: hit.name, changed: true };
}
