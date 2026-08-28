import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { renderSchema, injectSchema, SCHEMA_PLACEHOLDER } from '../src/renderSchema.js';
import { PROMPT_TEMPLATE_FILE, SCHEMA_DEFAULT_FILE } from '../src/paths.js';

const schema = JSON.parse(fs.readFileSync(SCHEMA_DEFAULT_FILE, 'utf8'));
const template = fs.readFileSync(PROMPT_TEMPLATE_FILE, 'utf8');

describe('renderSchema (§2.1.5)', () => {
  it('3단계 절차 + 시드 16종 + 핵심 15종 + 명명·언어 규칙을 렌더한다', () => {
    const text = renderSchema(schema);
    expect(text).toContain('[작업 절차 — 반드시 이 순서로]');
    expect(text).toContain('기존 유형을 우선 재사용');
    expect(text).toContain('- Person(인물): 실존·가상 인물');
    expect(text).toContain('- Work(작품/문헌)');
    expect(text).toContain('- MEMBER_OF(소속)');
    expect(text).toContain('- RELATED_TO(기타 연관(최후 수단))');
    expect(text).toContain('[명명·언어 규칙]');
    expect(text).toContain('정식 명칭으로 통일');
  });

  it('자동 등재분(extended)도 관계 목록에 렌더된다', () => {
    const extended = {
      ...schema,
      extended_relationships: [{ type: 'POSTED_TO', origin: 'auto', first_seen: 'x' }],
    };
    expect(renderSchema(extended)).toContain('- POSTED_TO');
  });
});

describe('kg-generation.md 템플릿 계약', () => {
  it('플레이스홀더가 정확히 1회 존재한다', () => {
    expect(template.split(SCHEMA_PLACEHOLDER).length - 1).toBe(1);
  });

  it('폐쇄 목록 문구를 계승하지 않는다 (v1 정책 부활 금지)', () => {
    expect(template).not.toContain('유형만 사용');
  });

  it('meta 출력 금지 지시를 포함한다 (저장 주체 = 파이프라인, §2.5-3)', () => {
    expect(template).toContain('meta 필드는 출력하지 마세요');
  });

  it('injectSchema — 리터럴 1회 치환, 출력 예시 JSON의 중괄호는 보존', () => {
    const result = injectSchema(template, renderSchema(schema));
    expect(result).not.toContain(SCHEMA_PLACEHOLDER);
    expect(result).toContain('- Person(인물)');
    expect(result).toContain('{"nodes": [{"id": "0"'); // JSON 예시 원형 유지
  });

  it('플레이스홀더가 0회·2회면 오류', () => {
    expect(() => injectSchema('no placeholder', 'x')).toThrow();
    expect(() => injectSchema('{schema} {schema}', 'x')).toThrow();
  });
});
