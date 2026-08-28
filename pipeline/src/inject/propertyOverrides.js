// 속성 승자 사전 + 속성 충돌 가시화 (TECH-SPEC §2.3.2 v2.10 — Q10).
//
// **왜 생겼나 (2026-08-26 실측)**: `headquarters`가 p04(연혁)=삼봉로 57(설립 당시)·
// p07(현행)=새문안로 89로 갈렸는데, 병합의 "파일명 오름차순 선착 우선"이 과거 값을 채택했다.
// 파일명 접두는 승인 배치 시각이라 승인 순서의 권위는 있어도 **내용 시점의 권위가 없다** —
// 병합이 그것을 시간 권위로 쓴 것이 결함이다.
//
// **선택 장치이지 발명 장치가 아니다**: 사전 값은 Reviewed/가 실제로 제시한 관측값 중에서만
// 고를 수 있다. 미관측(사전이 낡음)·대상 부재는 중단이 아니라 **미적용 + 전량 보고**다 —
// 하드 스톱으로 하면 반려·source_remove의 자동 재빌드가 지속 실패에 빠져 PRD 성공 기준 7
// ("반려하면 챗 지시만으로 DB 복원")을 깬다(2026-08-26 반박 패널 실측). 중단
// (invalid_property_overrides)은 사전 **내부 모순**에만 발동한다 — Q6 철학과 같다.

import { nameKey } from '@bibliomind/shared/normalize';
import { RESERVED_PROPS } from '@bibliomind/shared/kgSchemaValidate';
import { canonicalize } from './canonicalize.js';

/** 구분자 U+001F — 라벨·이름·속성명에 등장할 수 없어 키 충돌이 없다(§3.5 규약). */
const US = '\u001f';

/** 사전 등재 거부 속성명 — name 교정은 canonical_entities 소관, 나머지는 시스템 소유. */
const FORBIDDEN_PROPS = new Set(['name', ...RESERVED_PROPS]);

/** 값 정규화 — 문자열은 NFC+trim, 배열은 요소별. 관측·비교·적용이 전부 같은 정규화를 쓴다. */
export function normalizePropValue(value) {
  if (typeof value === 'string') return value.normalize('NFC').trim();
  if (Array.isArray(value)) return value.map(normalizePropValue);
  return value;
}

/**
 * 값 동등성 키 — 정규화 후 JSON 직렬화. 배열은 **순서 보존** 비교(순서를 의미로 취급 —
 * 순서 무시 비교는 목록형 정보를 지운다). 숫자·문자열은 타입 구분(2016 ≠ "2016" —
 * 타입 통합은 과병합 방지 원칙상 하지 않는다).
 */
export function propValueKey(value) {
  return JSON.stringify(normalizePropValue(value));
}

const isPrimitive = (v) => ['string', 'number', 'boolean'].includes(typeof v);

/** 허용 값 타입 — 문자열·숫자·불리언·동종 원시 배열(스키마 지시문 §2.1.5와 같은 규칙). */
function isAllowedValue(value) {
  if (isPrimitive(value)) return true;
  if (Array.isArray(value)) return value.every((x) => isPrimitive(x) && typeof x === typeof value[0]);
  return false;
}

/** 관측 수집에서 제외할 속성 — name은 entry가 따로 소유, 예약 속성은 시스템이 덮어쓴다. */
export function isObservableProp(key) {
  return !FORBIDDEN_PROPS.has(key);
}

/**
 * `schema.property_overrides`를 조회용 색인으로 만든다.
 *
 * 중복 검사는 **canonicalize + name_key 적용 후** 키로 한다 — 변형·정본 이중 등재로
 * 가드를 우회하면 최종 값이 배열 순서에 좌우된다(canonical_entities의 연쇄 금지와 동형 함정,
 * 2026-08-26 반박 패널 실측).
 *
 * @param {{ property_overrides?: object[] }} schema
 * @param {Map<string, {label: string, name: string}>} [canonIndex] 정본 엔티티 사전 색인
 * @returns {{ index: Map<string, {label:string,name:string,property:string,value:*,note:string|null}>,
 *             problems: string[] }}
 */
export function buildPropertyOverrideIndex(schema, canonIndex = new Map()) {
  const index = new Map();
  const problems = [];
  for (const entry of schema?.property_overrides ?? []) {
    const { node, property, value, note } = entry ?? {};
    if (!node?.label || !node?.name || !property || value === undefined) {
      problems.push(`property_overrides 항목에 node.label/node.name/property/value가 필요합니다: ${JSON.stringify(entry)}`);
      continue;
    }
    if (FORBIDDEN_PROPS.has(property)) {
      problems.push(property === 'name'
        ? `"${node.name}"의 property "name"은 등재 대상이 아닙니다 — 이름 교정은 canonical_entities 소관입니다.`
        : `"${node.name}"의 property "${property}"는 시스템 예약 속성이라 등재할 수 없습니다.`);
      continue;
    }
    if (!isAllowedValue(value)) {
      problems.push(`"${node.name}".${property}의 value 타입이 허용 범위(문자열·숫자·불리언·동종 원시 배열) 밖입니다: ${JSON.stringify(value)}`);
      continue;
    }
    const canon = canonicalize(canonIndex, node.label, node.name);
    const key = `${canon.label}${US}${nameKey(canon.name)}${US}${property}`;
    if (index.has(key)) {
      problems.push(`"${canon.name}".${property}가 중복 등재됐습니다(변형 표기 이중 등재 포함) — 정본 기준으로 하나만 남기세요.`);
      continue;
    }
    index.set(key, {
      label: canon.label, name: canon.name, property,
      value: normalizePropValue(value), note: note ?? null,
    });
  }
  return { index, problems };
}

/**
 * 병합 결과에 사전을 적용하고 미해결 충돌을 집계한다. 순수 함수 계열 — DB 접근 없음.
 * `merged.nodes`의 props를 제자리에서 교정한다(주입 직전 단계이므로 사본을 만들지 않는다).
 *
 * @param {{ nodes: object[], observations?: Map<string, Map<string, Map<string, {value:*, files:Set<string>|string[]}>>> }} merged
 * @param {Map<string, object>} overrideIndex buildPropertyOverrideIndex().index
 * @returns {{ applied: object[], unapplied: object[], conflicts: object[], conflictTotal: number }}
 */
export function resolvePropertyOverrides(merged, overrideIndex = new Map()) {
  const { nodes, observations = new Map() } = merged;
  const nodeByKey = new Map(nodes.map((n) => [`${n.label}${US}${n.name_key}`, n]));
  const applied = [];
  const unapplied = [];
  const resolvedKeys = new Set();

  for (const [key, o] of overrideIndex) {
    const mergeKey = key.slice(0, key.lastIndexOf(US));
    const base = { label: o.label, name: o.name, property: o.property, value: o.value };
    const node = nodeByKey.get(mergeKey);
    if (!node) {
      unapplied.push({ ...base, reason: '대상 노드가 병합 결과에 없습니다', observed: [] });
      continue;
    }
    const valueMap = observations.get(mergeKey)?.get(o.property);
    if (!valueMap || valueMap.size === 0) {
      unapplied.push({ ...base, reason: '대상 속성이 어떤 승인 파일에도 없습니다', observed: [] });
      continue;
    }
    const observed = observedList(valueMap);
    if (!valueMap.has(propValueKey(o.value))) {
      unapplied.push({ ...base, reason: '지정 값이 관측값에 없습니다(사전이 낡았을 수 있음) — 발명하지 않습니다', observed });
      continue;
    }
    node.props[o.property] = o.value;
    applied.push(base);
    resolvedKeys.add(`${mergeKey}${US}${o.property}`);
  }

  const conflicts = [];
  for (const [mergeKey, propMap] of observations) {
    for (const [property, valueMap] of propMap) {
      if (valueMap.size < 2 || resolvedKeys.has(`${mergeKey}${US}${property}`)) continue;
      const node = nodeByKey.get(mergeKey);
      if (!node) continue;
      conflicts.push({
        label: node.label, name: node.name, name_key: node.name_key,
        property, values: observedList(valueMap),
      });
    }
  }
  conflicts.sort((a, b) => a.label.localeCompare(b.label)
    || a.name_key.localeCompare(b.name_key)
    || a.property.localeCompare(b.property));
  return { applied, unapplied, conflicts, conflictTotal: conflicts.length };
}

/** 값 집합 → 결정적 순서(값 키 정렬)의 보고용 목록. */
function observedList(valueMap) {
  return [...valueMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, e]) => ({ value: e.value, files: [...e.files].sort() }));
}
