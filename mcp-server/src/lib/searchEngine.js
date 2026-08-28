// 검색 파이프라인 내부 알고리즘 (TECH-SPEC §6 정본의 구현).
// 3계층 시드 매칭 워터폴(§6.2.3) → k-hop 확장 + 시드 간 최단경로(§6.3 단계 3)
// → 1층 조립·상한·별칭(단계 4). 상한은 전부 코드 상수(§6.4).
import neo4j from 'neo4j-driver';
import { nameKey } from '@bibliomind/shared/normalize';
import { toJamoUnits, jamoEditDistance } from '@bibliomind/shared/hangul';

/** neo4j-driver의 정수 파라미터(LIMIT 등)는 Integer 타입 필요 — 얇은 래퍼로 격리 */
function neo4jInt(value) {
  return neo4j.int(value);
}

// §6.4 상한 표 — 코드 상수
export const KEYWORDS_MAX = 8;
export const SEEDS_PER_KEYWORD = 5;
export const SEEDS_TOTAL = 15;
export const HOPS_DEFAULT = 1;
export const HOPS_MAX = 2;
export const NODE_LIMIT_DEFAULT = 80;
export const NODE_LIMIT_MAX = 150;
export const REL_LIMIT_DEFAULT = 160;
export const REL_LIMIT_MAX = 300;
export const PATH_PAIRS_MAX = 10;
export const REL_SCAN_LIMIT = 2000;
export const SUMMARY_MAX_CHARS = 160;

// §6.3 단계 2 — T2 점수 하한. 그 키워드의 T2 1위 점수 대비 비율.
// 근거(2026-08-22 실측): 워터폴 실효 경로의 비교점 6개에서 자연 간극 39.2% ↔ 62.0%의 중앙.
// 재측정 조건: 슬라이스 2 규모에서 seedFloorCuts 관측 비교점 n≥30 확보 시.
export const SEEDS_MIN_SCORE_RATIO = 0.5;

// §6.2.3 앵커 복원 — 질문 원문 창과 키워드의 자모 편집거리 상한.
// 근거: 실측 손상 2건 모두 거리 1(종성 단일 치환). 거리 2 손상은 복원 시도 0건(의도된 보수성).
export const ANCHOR_MAX_JAMO_DISTANCE = 1;

// §6.2.3 앵커 복원 — 복원을 시도하는 키워드의 최소 글자 수.
// 근거: 2음절은 거리 1 이웃이 일상 한국어와 겹쳐 '손상이 아닌 별개 단어'를 바꿔치기한다
// (실측: 마음→마을, 이간→인간, 제갈→재갈). 3글자 이상에서 오복원 0건.
export const ANCHOR_MIN_KEYWORD_CHARS = 3;

const SYSTEM_PROPS = new Set(['name', 'name_key', 'kgid', 'reviewed_files', 'input_files']);

const PURE_HANGUL_PHRASE = /^[가-힣 ]+$/; // 한글 음절 + 공백만 (nameKey가 소문자화하므로 a-z 불요)
const RUN_BOUNDARY = /[^0-9a-z가-힣 ]+/; // 구두점을 창 경계로 — 문장 걸침 후보 배제

/**
 * 질문 원문을 앵커로 손상 키워드를 복원한다. 순수 함수 — DB 접근·부수효과 없음(§6.2.3).
 *
 * 설계 원칙: 앵커는 이 호출에 전달된 question 문자열이다. 시스템은 사용자를 교정하지 않고,
 * 후보 집합을 question의 부분 문자열로 봉쇄한다(그래프 쪽 추측 금지).
 *
 * 창 길이를 키워드와 같은 글자 수로 고정한 근거: 음절은 자모 2~3개이므로 거리 1로는
 * 음절 개수가 바뀔 수 없다 — 다른 길이 창은 계산 낭비이자 오탐 공간이다.
 * 어절 정렬을 좌측만 요구하는 근거: 한국어는 교착어라 명사 뒤에 조사가 붙는다("일륜도가").
 * 우측까지 경계를 요구하면 실사고 1(일륨도)이 복원되지 않는다(실측 확인).
 *
 * @param {string} keyword 워터폴 전 계층 미적중 키워드
 * @param {string | null | undefined} question 도구가 받은 질문 문자열
 * @returns {string | null} 복원 키워드(nameKey 표기) 또는 null(복원하지 않음)
 */
export function pickAnchorCandidate(keyword, question) {
  if (typeof question !== 'string' || question.length === 0) return null; // 가드1 — 앵커 부재
  const kw = nameKey(keyword);
  if (!PURE_HANGUL_PHRASE.test(kw)) return null; // 가드2 — 한글 음절+공백만
  const kwChars = [...kw];
  if (kwChars.length < ANCHOR_MIN_KEYWORD_CHARS) return null; // 가드3 — 짧은 키워드 제외
  const q = nameKey(question);
  if (q.includes(kw)) return null; // 가드4 — 축자 존재 = 손상 아님
  const kwUnits = toJamoUnits(kw);
  const found = new Set();
  for (const run of q.split(RUN_BOUNDARY)) {
    const chars = [...run];
    for (let i = 0; i + kwChars.length <= chars.length; i += 1) {
      const cand = chars.slice(i, i + kwChars.length).join('');
      if (cand === kw) return null; // 가드4 이중 안전망
      if (cand.trim() !== cand) continue; // 앞뒤 공백 창 배제
      if (!PURE_HANGUL_PHRASE.test(cand)) continue;
      if (i > 0 && chars[i - 1] !== ' ') continue; // 가드5 — 어절 시작 정렬(좌측)
      const d = jamoEditDistance(kwUnits, toJamoUnits(cand), ANCHOR_MAX_JAMO_DISTANCE);
      if (d >= 1 && d <= ANCHOR_MAX_JAMO_DISTANCE) found.add(cand);
    }
  }
  return found.size === 1 ? [...found][0] : null; // 가드6 — 0건·모호(2종 이상)면 복원 안 함
}

/**
 * Lucene 특수문자 이스케이프 — 순수 텀만 전달(쿼리 주입 차단, §6.2.3).
 * @param {string} term
 */
export function escapeLucene(term) {
  return term.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, (m) => '\\' + m);
}

/** 노드 하나가 챗으로 내보낼 수 있는 속성 개수 상한 — 넘으면 **숨기지 않고 개수를 보고**한다. */
export const FACT_MAX_PROPS = 24;

/**
 * 노드의 사실 속성을 챗 페이로드로 만든다 (§4.3-12 v2.9).
 *
 * **왜 `pickSummary`를 대체했나 (2026-08-23 실측)**: 옛 규칙은 *"문자열 속성 중 최장값 1개"* 였다.
 * 그 결과 회사 노드가 가진 속성 **17개 중 챗에 도달한 것은 `description` 하나**였고,
 * `founded_year: 2016`은 **숫자라서 원천 배제**됐다. 그래서 답변이 *"설립 연도는 그래프에 없다"* 고
 * 했다 — 도구가 주지 않은 것을 말할 수는 없으므로 **챗 입장에서는 정직한 보고**였다.
 * 즉 *"노드가 된 사실은 보이고 속성으로 남은 사실은 안 보이는"* 상태였다.
 *
 * **경량화 계약(§6.3)과의 균형은 실측으로 정했다**: 138노드 전량 기준 5.9KB → 10.7KB(**1.8배**).
 * 노드당 속성 수 중앙값이 1이라 대부분의 노드는 그대로이고, 정보가 실제로 몰린 소수 노드만 커진다.
 *
 * @param {Record<string, unknown>} props
 * @param {{ maxValueChars?: number, maxProps?: number }} [options]
 * @returns {{ facts: Record<string, string|number|boolean>, omitted: number }}
 */
export function nodeFacts(props, { maxValueChars = SUMMARY_MAX_CHARS, maxProps = FACT_MAX_PROPS } = {}) {
  const clip = (text) => (text.length > maxValueChars ? text.slice(0, maxValueChars) : text);
  const scalar = (value) => {
    // 드라이버 설정에 따라 정수가 Integer 객체로 올 수 있다 — 그대로 두면 {low,high}로 직렬화된다.
    if (neo4j.isInt(value)) return value.inSafeRange() ? value.toNumber() : value.toString();
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') return clip(value);
    return null;
  };

  const entries = [];
  // 키를 정렬해 **호출마다 같은 순서**가 나오게 한다 — Neo4j는 속성 순서를 보장하지 않는다.
  for (const key of Object.keys(props ?? {}).sort()) {
    if (SYSTEM_PROPS.has(key)) continue;
    const raw = props[key];
    if (Array.isArray(raw)) {
      const joined = raw.map(scalar).filter((v) => v !== null).join(', ');
      if (joined) entries.push([key, clip(joined)]);
      continue;
    }
    const value = scalar(raw);
    if (value !== null && value !== '') entries.push([key, value]);
  }

  const kept = entries.slice(0, maxProps);
  return { facts: Object.fromEntries(kept), omitted: entries.length - kept.length };
}

/**
 * 1층 조립 — kgid 중복 제거, 상한 절단(우선순위: 시드 → 최단경로 → 1홉 → 2홉),
 * dangling 관계 제거, truncated 판정 (§6.3 단계 4).
 * 순수 함수 — 테스트 대상.
 * @param {{ nodes: Array<{kgid: string, name: string, label: string, props: object, priority: number, score: number}>,
 *           rels: Array<{kgid: string, type: string, from: string, to: string}>,
 *           limitNodes: number }} input
 */
export function assembleLayer1({ nodes, rels, limitNodes }) {
  const nodeMap = new Map();
  for (const node of nodes) {
    const existing = nodeMap.get(node.kgid);
    if (!existing || node.priority < existing.priority) nodeMap.set(node.kgid, node);
  }
  const ordered = [...nodeMap.values()].sort(
    (a, b) => a.priority - b.priority || b.score - a.score,
  );
  const relCap = limitNodes > NODE_LIMIT_DEFAULT ? REL_LIMIT_MAX : REL_LIMIT_DEFAULT;
  let truncated = false;
  let kept = ordered;
  if (ordered.length > limitNodes) {
    kept = ordered.slice(0, limitNodes);
    truncated = true;
  }
  const keptIds = new Set(kept.map((n) => n.kgid));
  const relMap = new Map();
  for (const rel of rels) {
    if (!relMap.has(rel.kgid) && keptIds.has(rel.from) && keptIds.has(rel.to)) {
      relMap.set(rel.kgid, rel);
    }
  }
  let keptRels = [...relMap.values()];
  if (keptRels.length > relCap) {
    keptRels = keptRels.slice(0, relCap);
    truncated = true;
  }
  return { nodes: kept, rels: keptRels, truncated };
}

/**
 * 별칭 부여(n1…/r1…) — §6.3 단계 4. 순수 함수.
 * @param {ReturnType<typeof assembleLayer1>} layer1
 */
export function assignAliases(layer1) {
  const nodeAlias = new Map(); // kgid → alias
  const nodes = layer1.nodes.map((node, index) => {
    const a = `n${index + 1}`;
    nodeAlias.set(node.kgid, a);
    return { a, ...node };
  });
  const rels = layer1.rels.map((rel, index) => ({ a: `r${index + 1}`, ...rel }));
  return { nodes, rels, nodeAlias };
}

const NODE_RETURN = `elementId(n) AS eid, n.kgid AS kgid, n.name AS name,
       [l IN labels(n) WHERE l <> 'RKEntity'][0] AS label, properties(n) AS props`;

let fulltextAvailable = null; // lazy 판정 캐시 (graceful degradation — §6.2.3)

/** 테스트용 캐시 리셋. */
export function resetFulltextCache() {
  fulltextAvailable = null;
}

/** @param {import('neo4j-driver').Session} session */
async function checkFulltext(session) {
  if (fulltextAvailable !== null) return fulltextAvailable;
  try {
    const res = await session.run(
      "SHOW INDEXES YIELD name, state WHERE name = 'kg_fulltext' RETURN state",
    );
    fulltextAvailable = res.records[0]?.get('state') === 'ONLINE';
  } catch {
    fulltextAvailable = false;
  }
  return fulltextAvailable;
}

/** @param {import('neo4j-driver').Record} record */
function recordToNode(record, priority, score) {
  return {
    eid: record.get('eid'),
    kgid: record.get('kgid'),
    name: record.get('name'),
    label: record.get('label') ?? 'Node',
    props: record.get('props'),
    priority,
    score,
  };
}

/**
 * 키워드 1개의 시드 워터폴(T1 → T2 → T3) — §6.2.3.
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

/**
 * 검색 실행 — 시드 워터폴 + 앵커 복원 + k-hop + 최단경로 + 1층 조립 + 별칭 (§6.3 단계 2~4).
 * @param {import('neo4j-driver').Session} session 읽기 전용 세션
 * @param {{ keywords: string[], question?: string|null, hops?: number, limitNodes?: number }} args
 *   question: 도구가 받은 질문 문자열. 미전달이면 앵커 복원이 동작하지 않는다(현행 동작).
 */
export async function runSearch(session, { keywords, question, hops = HOPS_DEFAULT, limitNodes = NODE_LIMIT_DEFAULT }) {
  const k = Math.min(Math.max(1, hops), HOPS_MAX);
  const limit = Math.min(Math.max(1, limitNodes), NODE_LIMIT_MAX);
  const kws = keywords.slice(0, KEYWORDS_MAX);
  const ftOk = await checkFulltext(session);

  // ── 단계 2: 시드 매칭 (키워드별 워터폴, 상위 계층 매칭 시 하위 생략) ──
  const seedsByKeyword = [];
  const unmatched = [];
  const seedFloorCuts = []; // 하한에 잘린 T2 후보 관측 로그(§6.3 단계 2)
  for (const keyword of kws) {
    let effective = keyword;
    let restoredFrom = null;
    const first = await matchKeyword(session, keyword, ftOk);
    seedFloorCuts.push(...first.floorCuts);
    let { tier, records } = first;
    if (records.length === 0) {
      // 앵커 복원 — 기존 워터폴이 완전히 소진된 뒤에만 실행한다(적중 경로 무개입 보장).
      // 복원어는 T1→T2까지만 재조회한다(T3 CONTAINS는 복원어에 허용하지 않음 — 추측의 중첩 금지).
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
      unmatched.push(keyword); // 실패 시 원 키워드를 보존한다
    } else {
      seedsByKeyword.push({
        keyword: effective,
        tier,
        restoredFrom,
        nodes: records.map((r) => recordToNode(r, 0, Number(r.get('score')))),
      });
    }
  }

  // 전체 시드 상한 15 (점수순 절단 — §6.3 단계 2)
  const allSeeds = seedsByKeyword.flatMap((s) => s.nodes);
  const seedCut = new Set(
    [...allSeeds].sort((a, b) => b.score - a.score).slice(0, SEEDS_TOTAL).map((n) => n.kgid),
  );
  for (const group of seedsByKeyword) {
    group.nodes = group.nodes.filter((n) => seedCut.has(n.kgid));
  }
  const seeds = seedsByKeyword.flatMap((s) => s.nodes);

  const collectedNodes = [...seeds];
  const collectedRels = [];

  // ── 단계 3a: k-hop 확장 (elementId는 내부 커서 전용) ──
  let frontier = seeds.map((s) => s.eid);
  for (let hop = 1; hop <= k && frontier.length > 0; hop += 1) {
    const res = await session.run(
      `MATCH (s:RKEntity)-[r]-(m:RKEntity)
       WHERE elementId(s) IN $frontierIds
       RETURN r.kgid AS relKgid, type(r) AS relType,
              startNode(r).kgid AS fromKgid, endNode(r).kgid AS toKgid,
              elementId(m) AS eid, m.kgid AS kgid, m.name AS name,
              [l IN labels(m) WHERE l <> 'RKEntity'][0] AS label, properties(m) AS props
       LIMIT $relScanLimit`,
      { frontierIds: frontier, relScanLimit: neo4jInt(REL_SCAN_LIMIT) },
    );
    const seen = new Set(collectedNodes.map((n) => n.kgid));
    const nextFrontier = [];
    for (const record of res.records) {
      if (record.get('relKgid')) {
        collectedRels.push({
          kgid: record.get('relKgid'),
          type: record.get('relType'),
          from: record.get('fromKgid'),
          to: record.get('toKgid'),
        });
      }
      const kgid = record.get('kgid');
      if (!seen.has(kgid)) {
        seen.add(kgid);
        collectedNodes.push(recordToNode(record, 1 + hop, 0));
        nextFrontier.push(record.get('eid'));
      }
    }
    frontier = nextFrontier;
  }

  // ── 단계 3b: 시드 간 최단경로 보강 (키워드별 1위 시드 쌍, 최대 10쌍, 길이≤4) ──
  const topSeeds = seedsByKeyword
    .map((s) => s.nodes[0])
    .filter(Boolean)
    .filter((node, index, arr) => arr.findIndex((x) => x.kgid === node.kgid) === index);
  const pairs = [];
  for (let i = 0; i < topSeeds.length && pairs.length < PATH_PAIRS_MAX; i += 1) {
    for (let j = i + 1; j < topSeeds.length && pairs.length < PATH_PAIRS_MAX; j += 1) {
      pairs.push([topSeeds[i], topSeeds[j]]);
    }
  }
  for (const [a, b] of pairs) {
    const res = await session.run(
      `MATCH (a:RKEntity), (b:RKEntity)
       WHERE elementId(a) = $ea AND elementId(b) = $eb
       MATCH p = shortestPath((a)-[*..4]-(b))
       RETURN [n IN nodes(p) | { eid: elementId(n), kgid: n.kgid, name: n.name,
                label: [l IN labels(n) WHERE l <> 'RKEntity'][0], props: properties(n) }] AS pathNodes,
              [r IN relationships(p) | { kgid: r.kgid, type: type(r),
                from: startNode(r).kgid, to: endNode(r).kgid }] AS pathRels`,
      { ea: a.eid, eb: b.eid },
    );
    for (const record of res.records) {
      for (const node of record.get('pathNodes')) {
        collectedNodes.push({ ...node, priority: 1, score: 0 });
      }
      for (const rel of record.get('pathRels')) {
        collectedRels.push(rel);
      }
    }
  }

  // ── 단계 4: 1층 조립 + 별칭 ──
  const layer1 = assembleLayer1({ nodes: collectedNodes, rels: collectedRels, limitNodes: limit });
  const { nodes, rels, nodeAlias } = assignAliases(layer1);
  // 복원이 없으면 restoredFrom 키 자체가 없다 — 개선 전 골든 픽스처와 바이트 동일을 보장한다.
  const seedsReport = seedsByKeyword.map((s) => ({
    keyword: s.keyword,
    tier: s.tier,
    ...(s.restoredFrom ? { restoredFrom: s.restoredFrom } : {}),
    matched: s.nodes.map((n) => nodeAlias.get(n.kgid)).filter(Boolean),
  }));

  return {
    nodes,
    rels,
    truncated: layer1.truncated,
    seeds: seedsReport,
    unmatched,
    seedFloorCuts,
    ftWarning: ftOk ? null : 'full-text(cjk) 인덱스를 사용할 수 없어 T1+T3만으로 검색했습니다',
  };
}
