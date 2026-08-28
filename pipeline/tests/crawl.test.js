// S1 크롤러 단위 테스트 (TECH-SPEC §1.5 · ROADMAP 슬라이스 3).
// 네트워크는 때리지 않는다(§1.13) — fetchPage·fetchRobots·wait를 주입해 결정적으로 검증한다.
import { describe, it, expect } from 'vitest';
import robotsParser from 'robots-parser';
import { parseJinaResponse, extractLinks, domainOf, robotsDisallows, CRAWL_DELAY_MS } from '../src/crawl/index.js';

// 2026-08-22 readians.com 실측 응답의 형태를 그대로 축약한 것
const JINA_SAMPLE = [
  'Title: SAP 전문 파트너, 리디안솔루션',
  '',
  'URL Source: https://readians.com/',
  '',
  'Markdown Content:',
  '[![Image 1: 로고](https://readians.com/img/logo.png)](https://readians.com/)',
  '',
  '*   [리디안솔루션](https://readians.com/company)',
  '*   [사업 현황](https://readians.com/company/business)',
  '*   [외부 링크](https://example.com/other)',
].join('\n');

describe('parseJinaResponse — 실측 응답 형식 (2026-08-22)', () => {
  it('#1 Title·URL Source·Markdown Content 세 블록을 분리한다', () => {
    const r = parseJinaResponse(JINA_SAMPLE);
    expect(r.title).toBe('SAP 전문 파트너, 리디안솔루션');
    expect(r.finalUrl).toBe('https://readians.com/');
    expect(r.markdown.startsWith('[![Image 1')).toBe(true);
  });

  it('#2 본문에 "Markdown Content:" 라는 글자가 또 있어도 첫 마커에서 자른다', () => {
    const r = parseJinaResponse('Title: T\n\nURL Source: https://a.com/\n\nMarkdown Content:\n본문 Markdown Content: 인용');
    expect(r.markdown).toBe('본문 Markdown Content: 인용');
  });

  it('#3 헤더가 없으면 전체를 본문으로 보고 title·finalUrl은 null', () => {
    const r = parseJinaResponse('그냥 본문');
    expect(r.title).toBeNull();
    expect(r.finalUrl).toBeNull();
    expect(r.markdown).toBe('그냥 본문');
  });

  it('#4 빈 입력·null도 죽지 않는다', () => {
    expect(parseJinaResponse(null).markdown).toBe('');
    expect(parseJinaResponse('').title).toBeNull();
  });

  it('#5 Title이 빈 값이면 null로 떨어진다 (빈 문자열 제목을 만들지 않는다)', () => {
    expect(parseJinaResponse('Title:   \n\nMarkdown Content:\n본문').title).toBeNull();
  });
});

describe('extractLinks — 링크 발견은 마크다운 파싱으로만 (§1.5)', () => {
  it('#6 링크를 절대 URL로 뽑고 등장 순서·중복 제거를 지킨다', () => {
    const { markdown } = parseJinaResponse(JINA_SAMPLE);
    expect(extractLinks(markdown, 'https://readians.com/')).toEqual([
      'https://readians.com/',
      'https://readians.com/company',
      'https://readians.com/company/business',
      'https://example.com/other',
    ]);
  });

  it('#7 **이미지는 제외한다** — 문서가 아니다', () => {
    const links = extractLinks('![alt](https://a.com/pic.png) 그리고 [글](https://a.com/post)', 'https://a.com/');
    expect(links).toEqual(['https://a.com/post']);
  });

  it('#7-b 이미지를 감싼 링크는 **바깥 href**를 뽑는다 — 2026-08-22 실측 결함 회귀', () => {
    // readians.com 로고가 이 형태였고, 초판 정규식은 이미지 URL(logo.png)을 링크로 오인했다.
    const links = extractLinks('[![로고](https://a.com/img/logo.png)](https://a.com/home)', 'https://a.com/');
    expect(links).toEqual(['https://a.com/home']);
  });

  it('#8 상대 경로를 base로 절대화한다', () => {
    expect(extractLinks('[a](/x) [b](y)', 'https://a.com/dir/page')).toEqual([
      'https://a.com/x',
      'https://a.com/dir/y',
    ]);
  });

  it('#9 http(s)가 아닌 스킴은 버린다 (mailto·tel·javascript)', () => {
    const links = extractLinks('[m](mailto:a@b.com) [t](tel:123) [j](javascript:alert(1)) [ok](https://a.com/)', 'https://a.com/');
    expect(links).toEqual(['https://a.com/']);
  });

  it('#10 제목 붙은 링크와 꺾쇠 링크도 URL만 뽑는다', () => {
    expect(extractLinks('[a](https://a.com/p "제목") [b](<https://a.com/q>)', 'https://a.com/')).toEqual([
      'https://a.com/p',
      'https://a.com/q',
    ]);
  });

  it('#11 빈 입력은 빈 배열', () => {
    expect(extractLinks('', 'https://a.com/')).toEqual([]);
    expect(extractLinks(null, 'https://a.com/')).toEqual([]);
  });
});

describe('domainOf — 등록 도메인(eTLD+1) 경계와 파일명 대표 이름', () => {
  it('#12 서브도메인이 있어도 등록 도메인은 하나다', () => {
    expect(domainOf('https://blog.readians.com/a').registrable).toBe('readians.com');
    expect(domainOf('https://readians.com/').registrable).toBe('readians.com');
  });

  it('#13 대표 이름은 eTLD+1의 첫 라벨', () => {
    expect(domainOf('https://readians.com/').mainName).toBe('readians');
    expect(domainOf('https://www.bbc.co.uk/news').mainName).toBe('bbc');
  });

  it('#14 다단 접미사(co.uk)를 한 라벨로 착각하지 않는다', () => {
    expect(domainOf('https://www.bbc.co.uk/news').registrable).toBe('bbc.co.uk');
  });
});

describe('예절 상수 (§1.5)', () => {
  it('#15 Jina 호출 간 최소 간격은 1초다', () => {
    expect(CRAWL_DELAY_MS).toBe(1000);
  });
});

describe('robotsDisallows — 정규화가 차단 규칙을 우회하지 못한다 (2026-08-22 실사고 회귀)', () => {
  // 실사고: robots가 `Disallow: /api/` 인데 normalizeUrl이 끝 슬래시를 지워 `/api` 로 큐에 들어갔고,
  // robots-parser가 매칭하지 못해 **사이트가 막은 경로에 실제로 요청을 보냈다.**
  const ROBOTS = 'User-Agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /api/\n';
  const make = () => robotsParser('https://site.test/robots.txt', ROBOTS);

  it('#16 끝 슬래시가 지워진 /api 도 차단한다', () => {
    expect(robotsDisallows(make(), 'https://site.test/api')).toBe(true);
  });

  it('#17 원래 형태 /api/ 는 당연히 차단한다', () => {
    expect(robotsDisallows(make(), 'https://site.test/api/')).toBe(true);
  });

  it('#18 하위 경로도 차단한다', () => {
    expect(robotsDisallows(make(), 'https://site.test/admin/users')).toBe(true);
  });

  it('#19 허용 경로는 차단하지 않는다 — 과잉 차단 방지', () => {
    expect(robotsDisallows(make(), 'https://site.test/company')).toBe(false);
    expect(robotsDisallows(make(), 'https://site.test/')).toBe(false);
  });

  it('#20 접두만 같고 다른 경로(/apiary)는 차단하지 않는다', () => {
    expect(robotsDisallows(make(), 'https://site.test/apiary')).toBe(false);
  });

  it('#21 robots가 없으면(수신 실패) 차단하지 않는다 — 규칙 없음으로 간주(§1.5)', () => {
    expect(robotsDisallows(null, 'https://site.test/api')).toBe(false);
  });
});
