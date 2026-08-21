# 프로젝트 작업 규칙

## 프로덕트: 비블리오마인드(BiblioMind)

- 이 프로젝트의 제품명은 **비블리오마인드(BiblioMind)** — Biblio(지식 집합소) + Mind(LLM의 지적 체계). 사용자가 "비블리오마인드" 또는 "BiblioMind"라고 하면 이 작업물·완성물을 가리킨다. (2026-08-21 명명, DECISIONS.md)

이 프로젝트는 **문서 기반 개발(docs-first)** 방식을 따른다. 모든 기획·설계 결정은 `docs/`에 기록되어 있으며, 문서가 코드보다 우선하는 기준점이다.

## 사용자 프로필과 협업 방식

- 사용자는 **SAP FI 컨설턴트 경험이 있는 프로그래밍 비전문가**다. 비유(집짓기·제품 제조)로 요청하면 기술 요구로 번역해 확인하고, 전문용어는 풀어서 설명한다. ERP 개념(프로세스, 마스터데이터, 결재 흐름)으로 설명하면 잘 통한다.
- **호칭: "이사님"** (2026-08-21 사용자 지정. "사장님" 아님)
- **실질적 요청·질의마다 각 분야·직무 전문가(Workflow 에이전트 패널)를 투입**해 분석·검증 후 진행한다.
- 역할 분담은 `docs/COLLABORATION.md`를 따른다. 사용자가 직접 해야 하는 액션(계정·키 발급·결제·공개 push)은 "사용자 액션 필요"로 명시해 구분한다.

## 최상위 기준: PROCESS.md

- 전체 작업 흐름은 `docs/PROCESS.md`에 정의된 Phase 0~6과 하위 작업 순서를 따른다.
- **모든 세션 시작 시** `docs/PROCESS.md`의 "현재 위치"를 확인하고, 그 Phase의 규칙과 산출물 범위 안에서만 작업한다.
- 각 Phase는 산출물 완성 + 사용자 승인(게이트)을 받아야 넘어간다. 여러 Phase를 한 턴에 진행하지 않는다.
- Phase가 바뀌거나 하위 작업이 완료되면 `docs/PROCESS.md`의 "현재 위치"를 갱신한다.

## 개발 시 필수 참조 규칙

- **구현을 시작하기 전에** 반드시 다음 문서를 읽고 그 범위 안에서 작업한다:
  - `docs/PRD.md` — 무엇을, 왜 만드는가 (기능 범위, 사용자 시나리오, 안 만들 것)
  - `docs/TECH-SPEC.md` — 어떻게 만드는가 (스택, 데이터 모델, 아키텍처, 폴더 구조)
  - `docs/ROADMAP.md` — 지금 무엇을 만들 차례인가 (수직 슬라이스 순서, 진행 상태)
- 문서에 없는 기능을 임의로 추가하지 않는다. 필요해 보이면 먼저 사용자에게 제안하고, 승인되면 문서를 갱신한 뒤 구현한다.
- PRD의 "안 만들 것(Non-Goals)" 목록에 있는 것은 사용자가 명시적으로 요청해도 문서 변경을 먼저 확인한다.

## 문서-코드 동기화 규칙

- 구현 중 문서와 다르게 만들 수밖에 없는 상황이 생기면, **코드를 바꾸기 전에** 이유를 설명하고 사용자 승인 후 문서를 먼저 갱신한다.
- 중요한 기술 결정(라이브러리 선택, 스키마 변경, 외부 서비스 도입)은 `docs/DECISIONS.md`에 날짜·결정·근거·대안을 한 항목으로 기록한다.
- 슬라이스 하나가 완료되면 `docs/ROADMAP.md`의 해당 항목 상태를 갱신한다.

## 구현 사이클 규칙

- 한 번에 로드맵의 **슬라이스 하나만** 진행한다: 구현 → 실제 실행으로 검증 → 테스트 작성 → 커밋.
- 정보가 부족하면 추측으로 채우지 말고 질문한다.
- 매 응답 끝에 "현재 단계 / 다음 액션"을 한 줄로 표시한다.

## 프로젝트 컨벤션 (2026-08-21 스캐폴딩 확정)

- **코드 위치**: 구현 저장소는 워크스페이스의 `GraphRAG_1st/` (npm workspaces 모노레포: `shared`·`pipeline`·`mcp-server`·`visualization-3d`). 기획·설계 문서는 `bibliomind/docs/`.
- **언어·스타일**: Node.js ≥22.12, **ESM("type":"module") + JSDoc 타입 주석. TypeScript 금지.** 의존성 최소주의(TECH-SPEC §1.3의 6종 + MCP SDK·zod 외 신규 추가 금지 — 필요 시 문서 먼저).
- **실행·테스트 명령** (GraphRAG_1st 루트에서): `npm run dev:all`(시각화 8787+5173) / `npm test`(전 워크스페이스 Vitest) / `npm run lint` / `npm run setup`(멱등 부트스트랩) / `npm run mcp:smoke`(MCP 자가검증 — 자동 판정용) / `npm run mcp:inspect`(Inspector UI — 사람용).
- **mcp-server 철칙**: stdout은 MCP JSON-RPC 전용 — `console.log` 금지, 진단은 stderr(console.error). shared 모듈은 import 부수효과·stdout 출력 금지. inputSchema는 zod raw shape, 인자 없는 도구는 생략. 스텁 단계 outputSchema 선언 금지.
- **경로·환경**: cwd 기준 경로 금지 — `shared/src/paths.js`(import.meta.url 앵커)와 `shared/src/env.js`만 사용. 정규화·kgid는 `shared/src/normalize.js` 단일 구현만 import(재구현 금지). Neo4j는 **AuraDB 클라우드**(URI 기반 — .env).
- **.mcp.json 유효 범위**: GraphRAG_1st를 프로젝트 루트로 열 때만 적용. 상위 워크스페이스에서 열면 setup.js가 출력하는 절대경로 등록 명령 사용.
- **커밋 규칙**: 슬라이스 단위로 작게, 작업 브랜치(`phase2-scaffolding` 등)에 로컬 커밋. **main 병합·push는 사용자 승인 후에만**(공개 저장소).
- **Windows 주의**: 외부 CLI spawn은 `shared/src/winSpawn.js`(cmd /c 래퍼) 경유, CLI 부재 = 종료 코드 9009. 포트 점검 시 Vite는 IPv6(::1) 바인딩임에 유의.
- **GSD 방법론(.planning) 미사용**: 프로세스 정본은 docs/PROCESS.md. `/gsd-*` 스킬은 사용자 명시 호출 시에만(2026-08-21 스킬 조정 A안 — DECISIONS.md).
