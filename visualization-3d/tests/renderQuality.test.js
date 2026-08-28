import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 렌더링 품질 개선(DPR 반영·라벨 텍스처 해상도·구체 분할 수)의 소스 수준 회귀 검사.
// Graph3D.jsx는 WebGL 의존성 때문에 node 환경에서 import하지 않고 소스 텍스트로 검사한다.
const source = readFileSync(
  fileURLToPath(new URL('../src/components/Graph3D.jsx', import.meta.url)),
  'utf8',
);

describe('렌더링 품질 상수', () => {
  it('MAX_PIXEL_RATIO가 2로 정의되고 setPixelRatio 상한에 사용된다', () => {
    expect(source).toContain('export const MAX_PIXEL_RATIO = 2;');
    expect(source).toContain('Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO)');
  });

  it('SPRITE_TEXT_FONT_SIZE가 기본(90)보다 높게 정의된다', () => {
    const match = source.match(/export const SPRITE_TEXT_FONT_SIZE = (\d+);/);
    expect(match).not.toBeNull();
    expect(Number(match[1])).toBeGreaterThan(90);
  });

  it('NODE_SPHERE_RESOLUTION이 base JSX의 nodeResolution에 적용된다', () => {
    expect(source).toContain('export const NODE_SPHERE_RESOLUTION = 16;');
    expect(source).toContain('nodeResolution={NODE_SPHERE_RESOLUTION}');
  });
});

describe('SpriteText 생성 지점 전수 적용', () => {
  it('모든 SpriteText 생성 지점에 fontSize가 설정된다 (누락 방지)', () => {
    const spriteCreations = (source.match(/new SpriteText\(/g) || []).length;
    const fontSizeAssignments = (source.match(/sprite\.fontSize = SPRITE_TEXT_FONT_SIZE;/g) || []).length;
    expect(spriteCreations).toBeGreaterThan(0);
    expect(fontSizeAssignments).toBe(spriteCreations);
  });
});

describe('DPR 재적용 경로', () => {
  it('renderer와 postProcessingComposer 모두에 배율을 반영한다', () => {
    expect(source).toContain('renderer.setPixelRatio(ratio)');
    expect(source).toContain('composer?.setPixelRatio?.(ratio)');
  });

  it('devicePixelRatio 변경(matchMedia resolution) 리스너가 있다', () => {
    expect(source).toContain("'(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)'");
  });
});
