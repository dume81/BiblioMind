import { describe, expect, it } from 'vitest';
import {
  buildKgidIndex,
  resolveQueryHighlight,
  nodeHighlightState,
  linkHighlightState,
  brightenColor,
  citationPhrase,
  coverageNotice,
} from '../src/lib/queryHighlight.js';

// 렌더 데이터 표본: kgid가 있는 요소와 없는 요소(주입 전 데이터)를 섞는다.
const renderData = {
  nodes: [
    { id: 'e1', properties: { kgid: 'n_aaaa', name: '카마도 탄지로' } },
    { id: 'e2', properties: { kgid: 'n_bbbb', name: '귀살대' } },
    { id: 'e3', properties: { kgid: 'n_cccc', name: '일륜도' } },
    { id: 'e4', properties: { name: 'kgid 없음' } },
  ],
  links: [
    { id: 'r1', properties: { kgid: 'r_1111' } },
    { id: 'r2', properties: { kgid: 'r_2222' } },
    { id: 'r3', properties: {} },
  ],
};

function message(overrides = {}) {
  return {
    type: 'highlight.set',
    ts: '2026-08-21T15:45:31+09:00',
    searchId: 's-test-01',
    question: '탄지로는 어디 소속이야?',
    truncated: false,
    layer1: { nodeIds: ['n_aaaa', 'n_bbbb'], relIds: ['r_1111'] },
    layer2: { nodeIds: ['n_aaaa'], relIds: ['r_1111'] },
    citation: { status: 'pending', submitted: 0, accepted: 0 },
    ...overrides,
  };
}

describe('buildKgidIndex — kgid 색인 (§7.4)', () => {
  it('properties.kgid로 노드·링크 렌더 id를 색인한다', () => {
    const index = buildKgidIndex(renderData);
    expect(index.nodes.get('n_aaaa')).toBe('e1');
    expect(index.nodes.get('n_cccc')).toBe('e3');
    expect(index.links.get('r_2222')).toBe('r2');
  });

  it('kgid가 없는 요소는 색인에서 빠진다 (주입 전 데이터 매칭 불가)', () => {
    const index = buildKgidIndex(renderData);
    expect(index.nodes.size).toBe(3);
    expect(index.links.size).toBe(2);
  });

  it('null 렌더 데이터는 빈 색인을 돌려준다', () => {
    const index = buildKgidIndex(null);
    expect(index.nodes.size).toBe(0);
    expect(index.links.size).toBe(0);
  });
});

describe('resolveQueryHighlight — 3상태 집합과 N/M (§5.4·§7.6)', () => {
  it('kgid 매칭으로 렌더 id 집합을 만들고 N(수신 총수)/M(매칭 수)을 계산한다', () => {
    const resolved = resolveQueryHighlight(message(), renderData);
    expect(resolved.active).toBe(true);
    expect(resolved.total).toBe(3); // layer1 노드 2 + 관계 1
    expect(resolved.matched).toBe(3);
    expect(resolved.layer1NodeIds).toEqual(new Set(['e1', 'e2']));
    expect(resolved.layer1LinkIds).toEqual(new Set(['r1']));
    expect(resolved.layer2NodeIds).toEqual(new Set(['e1']));
    expect(resolved.layer2LinkIds).toEqual(new Set(['r1']));
  });

  it('렌더 집합에 없는 kgid는 M에서 빠진다 (필터·미로드 요소)', () => {
    const resolved = resolveQueryHighlight(
      message({ layer1: { nodeIds: ['n_aaaa', 'n_zzzz'], relIds: ['r_9999'] } }),
      renderData,
    );
    expect(resolved.total).toBe(3);
    expect(resolved.matched).toBe(1);
    expect(resolved.active).toBe(true);
  });

  it('매칭 0건이면 비활성 — 전체 dim을 걸지 않는다 (kgid 없는 수동 로드 그래프)', () => {
    const resolved = resolveQueryHighlight(
      message({ layer1: { nodeIds: ['n_zzzz'], relIds: ['r_9999'] } }),
      renderData,
    );
    expect(resolved.total).toBe(2);
    expect(resolved.matched).toBe(0);
    expect(resolved.active).toBe(false);
    expect(resolved.emptyResult).toBe(false);
    expect(nodeHighlightState(resolved, 'e1')).toBeNull(); // dim 없음
  });

  it('빈 layer1(시드 0건)은 비활성 + emptyResult — 화면을 dim하지 않는다', () => {
    const resolved = resolveQueryHighlight(
      message({ layer1: { nodeIds: [], relIds: [] }, layer2: { nodeIds: [], relIds: [] } }),
      renderData,
    );
    expect(resolved.active).toBe(false);
    expect(resolved.emptyResult).toBe(true);
    expect(resolved.total).toBe(0);
  });

  it('layer 필드가 없어도 안전하다 (방어적 해석)', () => {
    const resolved = resolveQueryHighlight({ type: 'highlight.set' }, renderData);
    expect(resolved.active).toBe(false);
    expect(resolved.emptyResult).toBe(true);
    expect(resolved.citation.status).toBe('pending');
  });

  it('질문·truncated·citation을 그대로 보존한다', () => {
    const resolved = resolveQueryHighlight(
      message({ truncated: true, citation: { status: 'partial', submitted: 4, accepted: 3 } }),
      renderData,
    );
    expect(resolved.question).toBe('탄지로는 어디 소속이야?');
    expect(resolved.truncated).toBe(true);
    expect(resolved.citation.status).toBe('partial');
  });
});

describe('3상태 우선순위 판정 (§7.4 — 2층 > 1층 > 밖)', () => {
  const resolved = resolveQueryHighlight(message(), renderData);

  it('노드: layer2 소속이 layer1보다 우선한다', () => {
    expect(nodeHighlightState(resolved, 'e1')).toBe('layer2'); // 1층·2층 모두 소속
    expect(nodeHighlightState(resolved, 'e2')).toBe('layer1');
    expect(nodeHighlightState(resolved, 'e3')).toBe('out');
    expect(nodeHighlightState(resolved, 'e4')).toBe('out');
  });

  it('관계: layer2 > layer1 > 밖', () => {
    expect(linkHighlightState(resolved, 'r1')).toBe('layer2');
    expect(linkHighlightState(resolved, 'r3')).toBe('out');
  });

  it('비활성(null·emptyResult)이면 null — 기존 시각 상태를 건드리지 않는다', () => {
    expect(nodeHighlightState(null, 'e1')).toBeNull();
    const empty = resolveQueryHighlight(message({ layer1: { nodeIds: [], relIds: [] } }), renderData);
    expect(nodeHighlightState(empty, 'e1')).toBeNull();
    expect(linkHighlightState(empty, 'r1')).toBeNull();
  });
});

describe('brightenColor — 1층 은은한 강조 (§7.4)', () => {
  it('#rrggbb를 흰색 방향으로 올린다', () => {
    expect(brightenColor('#000000', 0.35)).toBe('rgb(89, 89, 89)');
    expect(brightenColor('#ffffff', 0.35)).toBe('rgb(255, 255, 255)');
  });

  it('형식이 다르면 원색을 그대로 돌려준다', () => {
    expect(brightenColor('rgba(1,2,3,0.5)')).toBe('rgba(1,2,3,0.5)');
    expect(brightenColor(undefined)).toBeUndefined();
  });
});

describe('citationPhrase — v2.2 문구 정직화 (§7.6)', () => {
  it('4개 상태의 문구', () => {
    expect(citationPhrase({ status: 'pending' })).toBe('1층만 표시 중 (인용 검증 대기)');
    expect(citationPhrase({ status: 'none' })).toBe('1층만 표시 중 (인용 없음)');
    expect(citationPhrase({ status: 'partial', submitted: 5, accepted: 3 }))
      .toBe('인용 5건 중 3건이 검색 결과에 존재 (일부 탈락)');
    expect(citationPhrase({ status: 'verified' }))
      .toBe('인용 전건이 검색 결과에 존재 — 의미 일치는 화면에서 직접 확인');
  });

  it('citation이 없으면 검증 대기로 취급한다', () => {
    expect(citationPhrase(undefined)).toBe('1층만 표시 중 (인용 검증 대기)');
  });
});

describe('coverageNotice — N/M 표시와 원인별 힌트 (§5.4)', () => {
  it('M < N이면 개수와 힌트를 안내한다', () => {
    const partial = resolveQueryHighlight(
      message({ layer1: { nodeIds: ['n_aaaa', 'n_zzzz'], relIds: [] } }),
      renderData,
    );
    expect(coverageNotice(partial, false)).toBe('검색 결과 2개 중 1개 표시 중 — 그래프 새로고침 권장');
    expect(coverageNotice(partial, true)).toBe('검색 결과 2개 중 1개 표시 중 — 필터 해제 권장');
  });

  it('매칭 0건(비활성)이어도 N/M 안내는 유지된다 — 원인 힌트가 화면에 남아야 한다', () => {
    const none = resolveQueryHighlight(
      message({ layer1: { nodeIds: ['n_zzzz'], relIds: [] } }),
      renderData,
    );
    expect(coverageNotice(none, false)).toBe('검색 결과 1개 중 0개 표시 중 — 그래프 새로고침 권장');
  });

  it('전부 표시 중·빈 결과·null이면 null', () => {
    expect(coverageNotice(resolveQueryHighlight(message(), renderData), false)).toBeNull();
    expect(coverageNotice(resolveQueryHighlight(message({ layer1: { nodeIds: [], relIds: [] } }), renderData), false)).toBeNull();
    expect(coverageNotice(null, false)).toBeNull();
  });
});
