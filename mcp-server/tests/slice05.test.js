// 슬라이스 0.5 단위 테스트 — 순수 로직(검증·조립·별칭·요약 선정)과 파일 롤링·무-throw 계약.
// 네트워크(Neo4j·허브)를 실제로 때리는 테스트는 만들지 않는다(§1.12 — 실연동은 수동 스모크).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyCitations } from '../src/tools/kgCite.js';
import { assembleLayer1, assignAliases, nodeFacts, escapeLucene } from '../src/lib/searchEngine.js';
import { recordSearch, getSearch, latestSearch } from '../src/lib/lastSearches.js';
import { pushToHub } from '../src/vizClient.js';

describe('verifyCitations — 교집합 검증 (§6.5.4)', () => {
  const entry = {
    nodes: { n1: { kgid: 'n_aaa' }, n2: { kgid: 'n_bbb' } },
    rels: { r1: { kgid: 'r_xxx', from: 'n_aaa', to: 'n_bbb' } },
  };

  it('통과 관계의 양 끝 노드가 2층에 자동 포함된다', () => {
    const v = verifyCitations(entry, [], ['r1']);
    expect(v.status).toBe('verified');
    expect(v.layer2.relIds).toEqual(['r_xxx']);
    expect(new Set(v.layer2.nodeIds)).toEqual(new Set(['n_aaa', 'n_bbb']));
  });

  it('없는 별칭은 해당 항목만 탈락(partial)', () => {
    const v = verifyCitations(entry, ['n1', 'n9'], ['r1']);
    expect(v.status).toBe('partial');
    expect(v.accepted).toBe(2);
    expect(v.dropped).toEqual([{ a: 'n9', reason: '검색 결과에 없는 별칭' }]);
  });

  it('빈 인용·전건 탈락은 none', () => {
    expect(verifyCitations(entry, [], []).status).toBe('none');
    expect(verifyCitations(entry, ['n9'], []).status).toBe('none');
  });
});

describe('assembleLayer1 — 상한·우선순위·dangling (§6.3 단계 4)', () => {
  it('kgid 중복 제거 + 우선순위 낮은(시드) 것이 살아남는다', () => {
    const out = assembleLayer1({
      nodes: [
        { kgid: 'a', priority: 2, score: 0 },
        { kgid: 'a', priority: 0, score: 1 },
        { kgid: 'b', priority: 1, score: 0 },
      ],
      rels: [],
      limitNodes: 80,
    });
    expect(out.nodes.map((n) => n.kgid)).toEqual(['a', 'b']);
    expect(out.nodes[0].priority).toBe(0);
    expect(out.truncated).toBe(false);
  });

  it('노드 상한 절단 시 truncated + 잔존 노드 사이 관계만 유지(dangling 제거)', () => {
    const nodes = Array.from({ length: 5 }, (_, i) => ({ kgid: `k${i}`, priority: i, score: 0 }));
    const rels = [
      { kgid: 'r1', from: 'k0', to: 'k1' },
      { kgid: 'r2', from: 'k0', to: 'k4' }, // k4는 절단됨
    ];
    const out = assembleLayer1({ nodes, rels, limitNodes: 3 });
    expect(out.nodes.length).toBe(3);
    expect(out.truncated).toBe(true);
    expect(out.rels.map((r) => r.kgid)).toEqual(['r1']);
  });
});

describe('assignAliases — n1…/r1… (§6.3 단계 4)', () => {
  it('순서대로 별칭을 부여하고 kgid→별칭 맵을 만든다', () => {
    const { nodes, rels, nodeAlias } = assignAliases({
      nodes: [{ kgid: 'x' }, { kgid: 'y' }],
      rels: [{ kgid: 'z', from: 'x', to: 'y' }],
    });
    expect(nodes.map((n) => n.a)).toEqual(['n1', 'n2']);
    expect(rels[0].a).toBe('r1');
    expect(nodeAlias.get('y')).toBe('n2');
  });
});

// 2026-08-23: `pickSummary`(문자열 최장값 1개)를 `nodeFacts`(사실 속성 전부)로 **대체**했다.
// 옛 명제("문자열 중 최장값")는 시험을 통과했지만 **그 규칙 자체가 결함**이었다 —
// 숫자 속성을 원천 배제해 `founded_year: 2016`이 챗에 도달하지 못했고, 답변이
// "설립 연도는 그래프에 없다"는 거짓 부재를 냈다. 시험이 옳았는데 코드가 틀린 것이 아니라,
// **시험이 지키고 있던 규칙이 틀렸다.**
describe('nodeFacts — 사실 속성 전달 규칙 (§4.3-12 v2.9)', () => {
  it('#1 **숫자 속성이 전달된다** — 옛 pickSummary가 원천 배제하던 것(거짓 부재 회귀)', () => {
    const { facts } = nodeFacts({ name: '리디안솔루션(주)', founded_year: 2016, description: '설명' });
    expect(facts.founded_year).toBe(2016);
  });

  it('#2 시스템 속성은 제외한다', () => {
    const { facts } = nodeFacts({
      name: '탄지로', kgid: 'n_x', name_key: '탄지로', reviewed_files: ['a'], input_files: ['b'], role: '주인공',
    });
    expect(Object.keys(facts)).toEqual(['role']);
  });

  it('#3 **속성을 하나만 고르지 않는다** — 여러 사실이 함께 간다', () => {
    const { facts } = nodeFacts({ role: '주인공', description: '누이를 인간으로 되돌리려는 검사', age: 15 });
    expect(Object.keys(facts).sort()).toEqual(['age', 'description', 'role']);
  });

  it('#4 배열은 쉼표로 이어 붙인다', () => {
    const { facts } = nodeFacts({ services: ['컨설팅', '운영', '자문'] });
    expect(facts.services).toBe('컨설팅, 운영, 자문');
  });

  it('#5 긴 값은 160자로 자른다 (경량화 계약 §6.3)', () => {
    const { facts } = nodeFacts({ long: 'a'.repeat(500) });
    expect(facts.long).toHaveLength(160);
  });

  it('#6 키 순서는 **호출마다 같다** — Neo4j는 속성 순서를 보장하지 않는다', () => {
    const a = nodeFacts({ b: 1, a: 2, c: 3 });
    const b = nodeFacts({ c: 3, a: 2, b: 1 });
    expect(Object.keys(a.facts)).toEqual(Object.keys(b.facts));
  });

  it('#7 상한을 넘으면 **숨기지 않고 개수를 보고한다**', () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${String(i).padStart(2, '0')}`, i]));
    const { facts, omitted } = nodeFacts(many, { maxProps: 24 });
    expect(Object.keys(facts)).toHaveLength(24);
    expect(omitted).toBe(6);
  });

  it('#8 사실 속성이 없으면 빈 객체 — 노드 이름만으로 충분한 경우', () => {
    expect(nodeFacts({ name: '탄지로', kgid: 'n_x' })).toEqual({ facts: {}, omitted: 0 });
    expect(nodeFacts(null)).toEqual({ facts: {}, omitted: 0 });
  });

  it('#9 불리언도 전달한다', () => {
    expect(nodeFacts({ active: true }).facts.active).toBe(true);
  });
});

describe('escapeLucene — 순수 텀 강제 (§6.2.3)', () => {
  it('연산자 문자를 이스케이프한다', () => {
    expect(escapeLucene('a+b')).toBe('a\\+b');
    expect(escapeLucene('탄지로')).toBe('탄지로');
  });
});

describe('lastSearches — 롤링 5건·원자적 쓰기 (§6.3 단계 4)', () => {
  it('5건 초과 시 오래된 것이 밀려나고, 최신/ID 조회가 동작한다', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-ls-'));
    const env = { ...process.env, KG_DATA_DIR: tmp };
    for (let i = 1; i <= 6; i += 1) {
      recordSearch({ searchId: `s-${i}`, nodes: {}, rels: {} }, env);
    }
    const file = JSON.parse(fs.readFileSync(path.join(tmp, 'runtime', 'last-searches.json'), 'utf8'));
    expect(file.searches.map((s) => s.searchId)).toEqual(['s-2', 's-3', 's-4', 's-5', 's-6']);
    expect(latestSearch(env).searchId).toBe('s-6');
    expect(getSearch('s-3', env).searchId).toBe('s-3');
    expect(getSearch('s-1', env)).toBeNull();
    expect(getSearch(undefined, env).searchId).toBe('s-6');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('pushToHub — 무-throw 계약 (§5.5 v2.2)', () => {
  it('연결 거부에도 throw하지 않고 hubUp=false를 반환한다', async () => {
    const original = process.env.VIZ_SERVER_URL;
    process.env.VIZ_SERVER_URL = 'http://127.0.0.1:59999'; // 미사용 포트
    try {
      const out = await pushToHub('/api/highlight', { type: 'highlight.clear', ts: 'x' });
      expect(out.hubUp).toBe(false);
      expect(out.delivered).toBe(false);
      expect(out.note).toContain('dev:all');
    } finally {
      if (original === undefined) delete process.env.VIZ_SERVER_URL;
      else process.env.VIZ_SERVER_URL = original;
    }
  }, 15000);
});
