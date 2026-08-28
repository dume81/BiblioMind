// loadEnv 파싱 회귀 시험 — 2026-08-28 사고: `KEY= # 주석` 줄에서 주석이 값으로 로드되어
// Jina Authorization 헤더에 한글이 실려 fetch가 ByteString 오류로 전량 실패했다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnv } from '../src/env.js';

/** 임시 .env 파일을 만들어 loadEnv로 파싱한 결과 env 객체를 돌려준다. */
function parseEnvText(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-env-'));
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, text, 'utf8');
  const env = {};
  try {
    loadEnv({ envPath, env });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return env;
}

describe('loadEnv 값 파싱', () => {
  it('값 없이 인라인 주석만 있는 줄은 빈 값이 된다 (KEY= # 주석)', () => {
    const env = parseEnvText('JINA_API_KEY= # 무료 키 — 발급 절차는 README 참고\n');
    expect(env.JINA_API_KEY).toBe('');
  });

  it('값 뒤 인라인 주석을 제거한다 (KEY=value # 주석)', () => {
    const env = parseEnvText('A=value # 주석\n');
    expect(env.A).toBe('value');
  });

  it('따옴표로 감싼 값 안의 " #"는 보존한다', () => {
    const env = parseEnvText('A="a # b"\n');
    expect(env.A).toBe('a # b');
  });

  it('공백 없이 붙은 #는 값의 일부다 (KEY=a#b)', () => {
    const env = parseEnvText('A=a#b\n');
    expect(env.A).toBe('a#b');
  });

  it('= 바로 뒤에 붙은 #도 값이다 (KEY=#c) — `KEY= #주석`과 구별', () => {
    const env = parseEnvText('A=#c\n');
    expect(env.A).toBe('#c');
  });

  it('전체 주석 줄은 건너뛴다', () => {
    const env = parseEnvText('# 주석 줄\nA=1\n');
    expect(env).toEqual({ A: '1' });
  });

  it('이미 설정된 키는 덮어쓰지 않는다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-env-'));
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, 'A=file\n', 'utf8');
    const env = { A: 'preset' };
    try {
      loadEnv({ envPath, env });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(env.A).toBe('preset');
  });
});
