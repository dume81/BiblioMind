# 세션 상태 스냅샷 — 컨텍스트 압축(/compact) 대비

> 작성: 2026-08-21. **압축 후 이 문서 하나만 읽으면 전체 맥락이 복원되도록** 작성됨. 상세의 원본 진실은 각 문서.

## 제품과 문서 지도

**비블리오마인드(BiblioMind)** — Biblio(지식 집합소) + Mind(LLM의 지적 체계). 자료(PDF·이미지·웹)를 지식그래프로 만들어 **Neo4j AuraDB 클라우드**에 쌓고(원본 진실은 로컬 Reviewed/), 챗(Claude 앱/Codex) 질문 시 답의 근거 경로가 크롬 3D 앱에서 하이라이트되는 로컬 GraphRAG 도구. 기존 자산 = 워크스페이스 `GraphRAG_1st/`(3D 시각화 웹앱, github.com/dume81/GraphRAG_1st).

| 문서 (bibliomind/docs/) | 상태 |
|---|---|
| PRD.md | **v3.1** (v3 승인 후 AuraDB 전환 반영) — 요구사항의 원본 진실 |
| TECH-SPEC.md | **v2.1** (v2 승인 후 AuraDB 전환 + 스캐폴딩 패널 반영 — 부록 C) — 설계의 원본 진실. v1은 TECH-SPEC-v1-backup.md(동결) |
| ROADMAP.md | 수직 슬라이스 0~10 작성 완료 — 슬라이스 0(스캐폴딩) ✅ |
| DECISIONS.md | 모든 확정 결정의 ADR — 여기 없는 결정은 없다 |
| PROCESS.md | 전체 공정과 "현재 위치" 트래커 |
| COLLABORATION.md | R&R (사용자/Claude/사용자 전용 액션) |
| interview-round1.md | 인터뷰·웹 검증 기록 (역사 문서) |

## 현재 위치와 다음 행동

- **Phase 2 게이트 통과(2026-08-21 승인) → 슬라이스 0.5(스파이크 준비) 진행 중.** 게이트 확정 3건 + Karpathy 가이드라인 채택(GraphRAG_1st/CLAUDE.md·AGENTS.md 신설, 플러그인 미설치). 브랜치 운용 = 스파이크 통과 후 main 병합. 스캐폴딩 완료 내역(참고):
  - 구현: GraphRAG_1st를 npm workspaces 모노레포로 확장(`@bibliomind/shared|pipeline|mcp-server` + visualization-3d), shared 순수 함수 전부 구현+테스트, kg_status 스텁 1종, scripts/setup.js, .mcp.json, .env.example, ROADMAP 작성. **브랜치 `phase2-scaffolding` 로컬 커밋 — main 병합·push는 이사님 승인 후.**
  - 검증 수치: npm test 총 **203케이스**(기존 시각화 14파일·148케이스 무수정 포함), lint 통과, setup 2회 멱등, mcp:smoke에서 kg_status 응답, dev:all 8787·5173 HTTP 200.
  - 게이트 승인 대상 3건: §1.8 스크립트 개정(mcp:smoke·lint·-y) / instructions_ko 권고 2줄 / 브랜치 운용 — DECISIONS.md 말미 참조.
- **2026-08-21 요구 변경 반영: Neo4j Desktop → AuraDB 클라우드** (PRD v3.1·TECH-SPEC v2.1·DECISIONS ADR). 핵심 리스크 = Free 3일 무쓰기 자동 일시정지·일시정지 30일 후 인스턴스 삭제 — 원본 진실이 로컬 Reviewed/라 재주입으로 완전 복구.
- **슬라이스 0.5 완료 ✅(2026-08-21)** — 사용자 액션 ②까지 양 클라이언트(Codex·Claude Code) kg_status 실호출로 검증 완료. ④(dev:all)는 슬라이스 1 첫 단계로 이월. 코드분 상세: 사용자 액션 ①(AuraDB `bibliomind` 인스턴스·접속·cjk 실측 ✓) → inject-example 실주입(29노드/55관계, 2회 멱등 ✓, 인덱스 2종 ONLINE) → **도구 4종 구현·실호출 검증**("탄지로" T2 cjk 실증·"귀살대" T1·kg_cite verified/partial/none 전 경로·무-throw 푸시) → 평가 질문 세트 21문(docs/spike-eval-questions.md) → 테스트 213케이스. 잔여: **사용자 액션 ② MCP 등록(Claude Code = GraphRAG_1st 루트 열기 / Codex = config.toml + 재시작) ③ 구독 로그인 확인 ④ dev:all + 도구 "항상 허용"** → 슬라이스 1(하이라이트 스파이크 — 최소 허브 라우트·3상태 렌더도 이때 구현)
- **미결(보류)**: GitHub 저장소명 변경 여부 / 부록 A 오너 확인 ①②③(PRD source_remove 문언 포함)

## 핵심 확정 사항 압축 (상세·근거는 DECISIONS.md)

1. 디스코드/OpenClaw **배제** → 대화 인터페이스 = **로컬 MCP 서버** (Claude 앱·ChatGPT 데스크탑 Codex 양쪽 지원)
2. KG 생성 엔진 = Codex/Claude **선택형** + 한도 소진 시 **상호 전환(failover)** — 역할 분리는 폐기됨. Gemma는 범위 제외
3. **도메인 스키마 AI 자동 도출** — 기존 유형 재사용 우선 + 부족분 신규 도출 + 자동 등재·보고
4. 검수 2단(구조/의미) + 재빌드 롤백(Reviewed/=원본 진실) + 반려 3회 보류. 조작 원칙 = "챗이 조종석, 브라우저는 화면"
5. 하이라이트 = 3상태(밖 dim / 1층 은은·무조건 / 2층 검증된 인용 강조+파티클), 식별자 = kgid
6. 제품명 비블리오마인드(2026-08-21) · 호칭 = **"이사님"** · 예시 데이터(귀멸의 칼날) 유지 · MIT 라이선스 유지
7. 그래프 DB = **Neo4j AuraDB 클라우드** (2026-08-21 전환 — 코드는 URI 기반이라 로컬 병용 가능. **사용자명·DB명은 자격증명 .txt 값 그대로 — 신형 콘솔은 8자 생성 ID**. Free 한도 20만/40만 실측, 3일 무쓰기 일시정지·30일 삭제 정책 고지 의무)
8. 총감사(2026-08-21, 패널 8인) 반영: 스파이크 Claude 표면 = **Claude Code(GraphRAG_1st 루트 열기)**, ChatGPT 데스크탑 미설치 — **Codex 표면으로 확정**, 부록 A 3건 전부 해소(승인은 source_remove만 매번 확인·나머지 항상 허용), kg_search 호출률·부정 대조 검증 신설(§1.14-6), bibliomind/ 로컬 git 관리 시작

## 슬라이스 1 진행 상태 (2026-08-21 갱신 — 구현분 완료 ✅, 판정 대기)

**구현 완료(커밋 GraphRAG_1st 1ef89f0)**: 아래 브리핑의 §7.8 목록 전부 구현 + 검수 패널(4렌즈 18에이전트+반박 검증) 확정 13건 반영 + 테스트 248케이스(기존 148 무수정+신규 35) + 실왕복 검증(kg_search 실호출 → `delivered:true` → 크롬 자동 전환·질문·citation 문구 DOM 확인, 부정 대조 "무잔"→"검색 결과 없음", highlight_clear 소거). 상세·소결정은 DECISIONS 말미 "슬라이스 1 구현 완료" 항목이 정본.

**남은 것(이사님 몫)**: ① 사용자 액션 ④ — `npm run dev:all` + 크롬 http://localhost:5173 열어 하이라이트 육안 확인(허브가 마지막 verified 하이라이트를 보관 중 — 열면 자동 재생) + 챗 클라이언트에서 도구 "항상 허용" ② 스파이크 판정 — spike-eval-questions.md 21문 × Codex 먼저·Claude Code는 8/25(화) 이후 ③ 판정 통과 시 main 병합 승인.

**유지보수 진행(2026-08-22~)**: 슬라이스 1 스파이크 **Claude 표면 21/21 통과**(시드 14/15·인용 73건 verified·부정대조 3/3·소요 중앙값 6.1초). 오너가 **B안**(개선 먼저→재판정→Codex) 채택 → **docs/MAINTENANCE-PLAN.md가 유지보수 정본**(목표 5개·Phase M0~M5·Phase N 별건·오너 결정 3건). 현재 위치 = **M0 게이트 대기**(설계 문서화 + 오너 결정 ①T2 하한 50% ②잔상 A안 ③한글화 Phase N 편성). 다음 = M1 계측기 → M2 검색 정확도 → M3 문구 → M4 재판정 → M5 Codex.

**판정 진행 실기록(2026-08-21 밤 확정)**: **docs/spike-judgment-log.md가 유일 정본** — 문항별 판정표(**완료 11/21문**: A1·A4·A5·B5·C1·D1·D2·D3·E1·E2·E3), 시드 5/5·E군 3/3, D2 침묵 실패 2회 재현 → 공백 가시화 질의 규칙 **적용 완료(GraphRAG_1st 커밋 e362d35 — [A]~[E] 실코드 검증됨)** → 재측정 통과. 오너 확정 원칙(공백 가시화 = 품질 루프)·판정 후 처리 목록 6건 포함. **주의: 이 문서의 다른 절에 남은 판정 이전 서술("Codex 먼저·8/25 이후"·"사용자 액션 ②③④ 잔여" 등)은 낡음 — 상충 시 spike-judgment-log.md가 우선.** 8/22 재개 = 이 대화창 모델을 Opus 5로 바꾸고 "spike-judgment-log.md 읽고 이어서".

## 슬라이스 1 착수 브리핑 (원본 보존 — 위 진행 상태가 최신)

1. **구현 전 정독**: TECH-SPEC **§5 푸시 프로토콜(1173~1268행)** + **§7 시각화 확장(1485행~끝, §7.8 최소 수정 작업 목록이 파일별 지침)**. §5.2 메시지 4종 스키마·§5.1 보관/재생 규칙·§7.4 kgid 색인·§7.5 우선순위·§7.6 패널 문구(v2.2 정직화 반영)가 정본.
2. **수정 대상(§7.8 — 이 목록 밖 수정 금지, 외과수술 원칙)**: `visualization-3d/server/localServer.js`(라우트 3종+SSE+보관·재생+본문 상한+127.0.0.1) / `server/core/mapper.js`(RKEntity 제외 1줄) / `src/hooks/useGraphLoader.js`(push 소스) / `src/App.jsx`(SSE 구독 훅) / 신규 3상태 오버라이드 모듈 / `src/components/HighlightPanel.jsx`(citation 문구·N/M·truncated) / 신규 단위 테스트(kgid 색인·3상태 우선순위·N/M).
3. **완료 판정**: 기존 148케이스 무수정 통과 + 신규 테스트 + `dev:all` 켜고 kg_search 실호출 시 `delivered:true`·화면 하이라이트 실표시(mcp-server 쪽은 이미 완성 — 수신 측만 만들면 연결됨).
4. **스파이크 판정 절차**: docs/spike-eval-questions.md 21문 × 클라이언트 2종. **순서: Codex 먼저 → Claude 쪽은 8/25(화) 한도 재설정 후**(2026-08-21 기준 Claude Max 76% 사용). 시작 전 `npm run setup`으로 Aura 상태 확인(8/24까지는 활성 보장 — inject 쓰기로 시계 리셋됨). 판정 표면: Claude Code(GraphRAG_1st 루트) + Codex 데스크탑.
5. **git 상태**: GraphRAG_1st `phase2-scaffolding` 브랜치(커밋: 8b10e56 스캐폴딩 → 143e888 가이드라인 → 0c35f5a 정정 → 56fee39 슬라이스 0.5). bibliomind/ 로컬 git(ebfa10f → 8a9bc67 → 3effa1a). **main 병합·push는 스파이크 통과 후 이사님 승인**.
6. **주의**: MCP 서버 코드를 고치면 챗 클라이언트가 다음 기동 시 자동 반영(stdio 스폰). Codex config.toml·Claude Code .mcp.json 등록은 이미 완료·검증됨 — 재등록 불요.

## 산출물·자산 링크

- **도해 아티팩트** (유저 플로우·정보구조도·아키텍처, 검증 반영 v2): https://claude.ai/code/artifact/b02684d0-9743-4480-a8ce-cb3722145b3d
- 예시 KG JSON: `GraphRAG_1st/KG_Demon Slayer_Draft_01.json` / KG 추출 프롬프트: 워크스페이스 `req_node_relation.txt`
- 설치된 스킬(다음 세션부터 인식): agent-browser(+CLI v0.34.0 전역), find-skills, **GSD Core v1.11.0(전역 — 2026-08-21 스킬 조정 A안으로 핵심 프로필 8종 축소, 훅 14개·상태줄 유지)**, design-taste-frontend, mcp-builder(Anthropic 공식). GSD 방법론(.planning)은 미사용 — /gsd-*는 명시 호출 시에만(루트 CLAUDE.md 명문화)
- **OmniRoute 평가 결론(2026-08-21)**: 설치 가능하나 **비권고 확정** — Anthropic 구독 OAuth 서드파티 금지(계정 제재 위험)·루트 CA/MITM 보안 이력·KG 품질 역효과·단일 실패점. 설치하지 않았음

## 협업 방식 (압축 후에도 유지할 것)

- 실질 요청마다 **전문가 패널(Workflow 에이전트) 투입** → 결과 종합 → 문서 반영 → 게이트 승인
- **문서가 코드보다 먼저** · 산출물 개정 시 **왜곡·누락 금지**(독립 검증자 대조가 표준 절차)
- 사용자 = SAP FI 컨설턴트 출신 프로그래밍 비전문가, 비유로 소통(기술 번역 후 확인), 사용자 전용 액션(계정·키·결제)은 "사용자 액션 필요"로 명시
- 매 응답 끝: `현재 위치: Phase X.Y / 다음 액션` 한 줄
