// 엔진 어댑터 계약 테스트 (TECH-SPEC §1.12-2) — **실제 codex/claude를 부르지 않는다.**
// 가짜 실행 스크립트를 spawn해 stdin 전달·실패 분류·타임아웃·교정 재호출·한도 전환을 검증한다.
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { classifyFailure } from '../src/generate/engines/run.js';
import { resolveEngine, otherEngine, VALID_ENGINES } from '../src/generate/resolveEngine.js';
import * as codexEngine from '../src/generate/engines/codex.js';
import * as claudeEngine from '../src/generate/engines/claude.js';
import { parseEngineJson } from '../src/generate/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-engine.js');
const PROMPT = '프롬프트 머리\n\n[자료 본문]\n탄지로는 네즈코의 오빠다.';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-engine-'));

/**
 * 어댑터가 부를 spawn을 가로채 가짜 엔진으로 바꾼다.
 * 실제 어댑터가 만든 argv는 무시하고, 시나리오만 전달한다 — 여기서 시험하는 것은
 * "어댑터가 결과·실패를 어떻게 환원하는가"이지 CLI의 argv 해석이 아니다.
 */
const fakeSpawn = (scenario, extra = []) => () =>
  spawn(process.execPath, [FAKE, scenario, ...extra], { stdio: ['pipe', 'pipe', 'pipe'] });

describe('resolveEngine — 시작 엔진 선택 (§1.4)', () => {
  it('#1 도구 인자가 최우선', () => {
    expect(resolveEngine('claude', { KG_ENGINE: 'codex' })).toEqual({ ok: true, engine: 'claude' });
  });

  it('#2 인자가 없으면 .env', () => {
    expect(resolveEngine(undefined, { KG_ENGINE: 'claude' })).toEqual({ ok: true, engine: 'claude' });
  });

  it('#3 둘 다 없으면 내장 기본 codex', () => {
    expect(resolveEngine(undefined, {})).toEqual({ ok: true, engine: 'codex' });
  });

  it('#4 알 수 없는 값은 실패로 환원한다 — throw하지 않는다', () => {
    const r = resolveEngine('gemma', {});
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('gemma');
  });

  it('#5 전환 대상은 반대쪽 엔진', () => {
    expect(otherEngine('codex')).toBe('claude');
    expect(otherEngine('claude')).toBe('codex');
    expect(VALID_ENGINES).toEqual(['codex', 'claude']);
  });
});

describe('classifyFailure — 실패 분류 (§1.4)', () => {
  // 2026-08-22 명제 교체: 초판은 *"한도 문구는 종료 코드보다 먼저 본다 — 코드 0이어도
  // rate_limit"* 이었다. 그 전제("0으로 끝나면서 안내 문구만 뱉는 경우가 있다")는 확인되지
  // 않은 가정이었고, **바로 그 가정이 실사고를 냈다** — 정상 종료한 생성물의 본문에 있던
  // 주소 번지수 429가 한도로 읽혀 배치가 중단됐다. 새 명제는 아래와 같다.
  it('#6 한도는 **비정상 종료 + stderr 문구**일 때만 잡는다', () => {
    expect(classifyFailure({ code: 1, stdout: '', stderr: 'usage limit reached', timedOut: false, spawnError: null }).kind)
      .toBe('rate_limit');
  });

  it('#7 한글 한도 문구도 잡는다', () => {
    expect(classifyFailure({ code: 1, stdout: '', stderr: '사용량 한도에 도달했습니다', timedOut: false, spawnError: null }).kind)
      .toBe('rate_limit');
  });

  it('#8 타임아웃', () => {
    expect(classifyFailure({ code: null, stdout: '', stderr: '', timedOut: true, spawnError: null }).kind).toBe('timeout');
  });

  it('#9 **Windows 종료 코드 9009는 not_installed** — cmd /c 경유라 ENOENT가 안 난다 (§1.13-1)', () => {
    expect(classifyFailure({ code: 9009, stdout: '', stderr: '', timedOut: false, spawnError: null }).kind)
      .toBe('not_installed');
  });

  it('#10 비-Windows의 spawn ENOENT도 not_installed', () => {
    const e = new Error('spawn codex ENOENT'); e.code = 'ENOENT';
    expect(classifyFailure({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: e }).kind)
      .toBe('not_installed');
  });

  it('#11 그 외 비정상 종료는 crash', () => {
    expect(classifyFailure({ code: 3, stdout: '', stderr: '폭발', timedOut: false, spawnError: null }).kind).toBe('crash');
  });

  it('#12 정상 종료는 null (실패 아님)', () => {
    expect(classifyFailure({ code: 0, stdout: '{}', stderr: '', timedOut: false, spawnError: null })).toBeNull();
  });

  // ── 2026-08-22 실사고 회귀 (살해 케이스) ──
  // 자료 본문의 회사 주소 "서울시 동대문구 장안동 429-2"가 HTTP 429로 오인돼
  // **정상 생성이 한도 소진으로 기록되고 배치가 중단**됐다. 두 엔진이 같은 파일에서
  // 동시에 "실패"한 것도 엔진 문제가 아니라 이 오탐 때문이었다.
  it('#12-a **자료 본문의 번지수 429를 한도로 읽지 않는다** — 실사고 회귀', () => {
    const kg = JSON.stringify({ nodes: [{ id: '0', label: 'Place', properties: { name: '서울시 동대문구 장안동 429-2 제이빌딩 203호' } }], relationships: [] });
    expect(classifyFailure({ code: 0, stdout: kg, stderr: '', timedOut: false, spawnError: null })).toBeNull();
  });

  it('#12-b **모델이 쓴 본문은 한도 신호로 쓰지 않는다** — stdout에 한도 문구가 있어도', () => {
    // 모델이 "rate limit"이라는 말을 자료에서 옮겨 적을 수 있다. 그건 시스템 신호가 아니다.
    const kg = '{"nodes":[{"id":"0","label":"Concept","properties":{"name":"API rate limit 정책"}}],"relationships":[]}';
    expect(classifyFailure({ code: 0, stdout: kg, stderr: '', timedOut: false, spawnError: null })).toBeNull();
  });

  it('#12-c 문맥 있는 HTTP 429는 여전히 한도로 잡는다 (stderr·비정상 종료)', () => {
    expect(classifyFailure({ code: 1, stdout: '', stderr: 'request failed with HTTP 429', timedOut: false, spawnError: null }).kind)
      .toBe('rate_limit');
  });

  it('#12-d 정상 종료(0)면 stderr에 한도 문구가 있어도 한도가 아니다 — 결과가 나왔다', () => {
    expect(classifyFailure({ code: 0, stdout: '{}', stderr: 'warning: approaching rate limit', timedOut: false, spawnError: null }))
      .toBeNull();
  });
});

describe('어댑터 — 가짜 엔진으로 실제 spawn (실구독 미소모)', () => {
  it('#13 codex 어댑터: -o 파일에서 결과를 읽는다', async () => {
    const out = path.join(TMP, 'codex-out-1.txt');
    const r = await codexEngine.run({
      prompt: PROMPT, timeoutMs: 20000, cwd: TMP, outFile: out,
      spawnImpl: fakeSpawn('good', ['--out', out]),
    });
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.text).nodes).toHaveLength(3);
  });

  it('#14 claude 어댑터: stdout JSON 봉투의 result를 꺼낸다', async () => {
    const r = await claudeEngine.run({
      prompt: PROMPT, timeoutMs: 20000, cwd: TMP,
      spawnImpl: fakeSpawn('good', ['--envelope']),
    });
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.text).relationships).toHaveLength(2);
  });

  it('#15 **프롬프트가 stdin으로 전달된다** — 가짜 엔진이 못 받으면 계약 위반으로 실패시킨다', async () => {
    // 본문 표지가 없는 프롬프트를 주면 가짜 엔진이 종료 코드 4로 항의한다.
    const r = await claudeEngine.run({
      prompt: '본문 표지 없음', timeoutMs: 20000, cwd: TMP,
      spawnImpl: fakeSpawn('good', ['--envelope']),
    });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('crash');
    expect(r.summary).toContain('4');
  });

  it('#16 한도 → rate_limit으로 환원', async () => {
    const r = await claudeEngine.run({
      prompt: PROMPT, timeoutMs: 20000, cwd: TMP, spawnImpl: fakeSpawn('ratelimit'),
    });
    expect(r).toMatchObject({ ok: false, kind: 'rate_limit' });
  });

  it('#17 비정상 종료 → crash', async () => {
    const r = await claudeEngine.run({
      prompt: PROMPT, timeoutMs: 20000, cwd: TMP, spawnImpl: fakeSpawn('crash'),
    });
    expect(r).toMatchObject({ ok: false, kind: 'crash' });
  });

  it('#18 빈 출력 → bad_output', async () => {
    const r = await claudeEngine.run({
      prompt: PROMPT, timeoutMs: 20000, cwd: TMP, spawnImpl: fakeSpawn('empty', ['--envelope']),
    });
    expect(r).toMatchObject({ ok: false, kind: 'bad_output' });
  });

  it('#19 매달리면 타임아웃으로 끊는다 — 무한 대기하지 않는다', async () => {
    const t0 = Date.now();
    const r = await claudeEngine.run({
      prompt: PROMPT, timeoutMs: 700, cwd: TMP, spawnImpl: fakeSpawn('hang'),
    });
    expect(r).toMatchObject({ ok: false, kind: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(10000);
  }, 20000);
});

describe('parseEngineJson — 출력에서 KG JSON 꺼내기', () => {
  it('#20 순수 JSON', () => {
    expect(parseEngineJson('{"nodes":[],"relationships":[]}').ok).toBe(true);
  });

  it('#21 백틱 펜스가 붙어 와도 견딘다 (지시 위반이지만 버리지 않는다)', () => {
    const r = parseEngineJson('```json\n{"nodes":[],"relationships":[]}\n```');
    expect(r.ok).toBe(true);
    expect(r.doc.nodes).toEqual([]);
  });

  it('#22 앞뒤 잡담이 섞여도 중괄호 구간을 꺼낸다', () => {
    const r = parseEngineJson('네, 만들었습니다:\n{"nodes":[],"relationships":[]}\n필요하면 말씀하세요.');
    expect(r.ok).toBe(true);
  });

  it('#23 JSON이 아니면 실패 사유를 돌려준다', () => {
    const r = parseEngineJson('죄송합니다. 이해하지 못했습니다.');
    expect(r.ok).toBe(false);
    expect(r.why).toBeTruthy();
  });

  it('#24 최상위가 배열이면 거부한다 (§2.2 출력 규율)', () => {
    expect(parseEngineJson('[{"nodes":[]}]').ok).toBe(false);
  });

  it('#25 빈 출력', () => {
    expect(parseEngineJson('').ok).toBe(false);
    expect(parseEngineJson(null).ok).toBe(false);
  });
});
