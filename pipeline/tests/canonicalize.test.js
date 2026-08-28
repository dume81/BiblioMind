// 정본 엔티티 정규화 (TECH-SPEC §2.3.2 v2.8).
//
// 이 사전의 위험은 **과병합**이다 — 잘못 합치면 서로 다른 대상이 한 노드가 되고,
// 그건 갈라진 것보다 고치기 어렵다(합쳐진 뒤엔 어느 관계가 어디서 왔는지 화면에서 안 보인다).
// 그래서 "합쳐지는가"보다 **"안 합쳐져야 할 것이 안 합쳐지는가"** 를 더 많이 시험한다.
import { describe, it, expect } from 'vitest';
import { buildCanonicalIndex, canonicalize } from '../src/inject/canonicalize.js';
import { mergeReviewed } from '../src/inject/index.js';

const ORG = (name) => ({ label: 'Organization', name });
const SCHEMA = {
  canonical_entities: [
    { canonical: ORG('리디안솔루션(주)'), variants: [ORG('리디안솔루션')] },
    {
      canonical: { label: 'Product', name: 'SAP GRC' },
      variants: [
        { label: 'Concept', name: 'SAP GRC' },
        { label: 'Object', name: 'SAP GRC' },
        { label: 'Concept', name: 'SAP Governance, Risk and Compliance' },
      ],
    },
  ],
};

const idx = () => buildCanonicalIndex(SCHEMA).index;

describe('buildCanonicalIndex', () => {
  it('#1 변형을 정본으로 잇는 색인을 만든다', () => {
    const { index, problems } = buildCanonicalIndex(SCHEMA);
    expect(problems).toEqual([]);
    expect(index.size).toBe(4);
  });

  it('#2 **연쇄를 거부한다** — A→B, B→C면 순서에 따라 결과가 갈려 멱등성이 깨진다', () => {
    const { problems } = buildCanonicalIndex({
      canonical_entities: [
        { canonical: ORG('B'), variants: [ORG('A')] },
        { canonical: ORG('C'), variants: [ORG('B')] }, // B가 정본이면서 변형
      ],
    });
    expect(problems.join(' ')).toMatch(/연쇄/);
  });

  it('#3 같은 변형이 두 정본에 등록되면 문제로 보고한다', () => {
    const { problems } = buildCanonicalIndex({
      canonical_entities: [
        { canonical: ORG('X'), variants: [ORG('공통')] },
        { canonical: ORG('Y'), variants: [ORG('공통')] },
      ],
    });
    expect(problems.join(' ')).toMatch(/중복 등록/);
  });

  it('#4 형식이 깨진 항목은 조용히 넘기지 않고 보고한다', () => {
    const { problems } = buildCanonicalIndex({
      canonical_entities: [{ canonical: { label: 'Organization' }, variants: [] }],
    });
    expect(problems).toHaveLength(1);
  });

  it('#5 사전이 없으면 빈 색인 — 정규화 없이 동작한다', () => {
    expect(buildCanonicalIndex({}).index.size).toBe(0);
  });
});

describe('canonicalize — 과병합 방지가 핵심', () => {
  it('#6 등록된 변형은 정본으로 바뀐다', () => {
    expect(canonicalize(idx(), 'Organization', '리디안솔루션'))
      .toEqual({ label: 'Organization', name: '리디안솔루션(주)', changed: true });
  });

  it('#7 **라벨이 다르면 바꾸지 않는다** — 이름만 같은 다른 대상을 지킨다', () => {
    expect(canonicalize(idx(), 'Concept', '리디안솔루션').changed).toBe(false);
  });

  it('#8 **사전에 없는 것은 손대지 않는다** — 비슷하다고 합치지 않는다', () => {
    expect(canonicalize(idx(), 'Organization', '리디안솔루션 자체 솔루션').changed).toBe(false);
    expect(canonicalize(idx(), 'Organization', '리디안').changed).toBe(false);
  });

  it('#9 라벨만 바뀌는 경우도 처리한다(이름 동일)', () => {
    expect(canonicalize(idx(), 'Concept', 'SAP GRC'))
      .toEqual({ label: 'Product', name: 'SAP GRC', changed: true });
  });

  it('#10 이름·라벨이 함께 바뀌는 경우', () => {
    expect(canonicalize(idx(), 'Concept', 'SAP Governance, Risk and Compliance'))
      .toEqual({ label: 'Product', name: 'SAP GRC', changed: true });
  });

  it('#11 정본 자신을 넣으면 그대로 나온다 (멱등)', () => {
    const once = canonicalize(idx(), 'Product', 'SAP GRC');
    const twice = canonicalize(idx(), once.label, once.name);
    expect(twice).toEqual({ label: 'Product', name: 'SAP GRC', changed: false });
  });

  it('#12 공백·대소문자 차이는 name_key 정규화가 흡수한다', () => {
    expect(canonicalize(idx(), 'Organization', '리디안솔루션  ').changed).toBe(true);
  });
});

describe('mergeReviewed와의 결합 — 갈라진 노드가 실제로 하나가 되는가', () => {
  const docA = {
    file: 'a.kg.json',
    doc: {
      nodes: [{ id: '0', label: 'Organization', properties: { name: '리디안솔루션', industry: 'SAP' } }],
      relationships: [],
    },
  };
  const docB = {
    file: 'b.kg.json',
    doc: {
      nodes: [{ id: '0', label: 'Organization', properties: { name: '리디안솔루션(주)', tel: '02' } }],
      relationships: [],
    },
  };

  it('#13 사전 없이는 2개로 갈라진다 (수리 전 상태 재현)', () => {
    const m = mergeReviewed([docA, docB]);
    expect(m.nodes).toHaveLength(2);
    expect(m.canonicalized).toBe(0);
  });

  it('#14 **사전을 주면 1개로 모이고 속성·출처가 합쳐진다**', () => {
    const m = mergeReviewed([docA, docB], idx());
    expect(m.nodes).toHaveLength(1);
    expect(m.canonicalized).toBe(1);
    expect(m.nodes[0].name).toBe('리디안솔루션(주)'); // 표시 이름은 정본
    expect(m.nodes[0].props).toMatchObject({ industry: 'SAP', tel: '02' });
    expect(m.nodes[0].reviewed_files).toEqual(['a.kg.json', 'b.kg.json']);
  });

  it('#15 관계의 양 끝도 정본 kgid를 향한다 — dangling이 생기지 않는다', () => {
    const doc = {
      file: 'c.kg.json',
      doc: {
        nodes: [
          { id: '0', label: 'Organization', properties: { name: '리디안솔루션' } },
          { id: '1', label: 'Concept', properties: { name: '고객가치' } },
        ],
        relationships: [{ type: 'RELATED_TO', start_node_id: '0', end_node_id: '1', properties: {} }],
      },
    };
    const m = mergeReviewed([doc, docB], idx());
    expect(m.nodes).toHaveLength(2); // 회사 1 + 개념 1
    const company = m.nodes.find((n) => n.name === '리디안솔루션(주)');
    expect(m.rels[0].fromKgid).toBe(company.kgid);
  });

  it('#16 정규화해도 멱등하다 — 같은 입력이면 같은 결과', () => {
    const a = mergeReviewed([docA, docB], idx());
    const b = mergeReviewed([docA, docB], idx());
    expect(a.nodes.map((n) => n.kgid)).toEqual(b.nodes.map((n) => n.kgid));
  });
});
