# 비블리오마인드(BiblioMind) — 로컬 GraphRAG 지식그래프 도구

자료(웹·PDF·이미지)를 지식그래프로 만들어 Neo4j에 쌓고, 챗(Claude Code·Codex) 질문의 근거 경로를 **3D로 하이라이트**하는 로컬 도구입니다. 3D 앱은 `react-force-graph-3d` 기반 18종 시각화 스타일·유형/속성 하이라이트·관계 필터를 제공합니다. (셋업 가이드 전체 판은 작성 중 — `docs/ROADMAP.md` 슬라이스 9)

## 빠른 시작

요구 사항: [Node.js](https://nodejs.org) 22.12+

```bash
git clone https://github.com/dume81/BiblioMind.git
cd BiblioMind
npm install
npm run setup
npm run dev:all
```

브라우저에서 `http://localhost:5173` 접속 → **JSON 파일** 탭에 샘플 데이터 `examples/KG_Demon Slayer_Draft_01.json`을 드래그 앤드 드롭하면 바로 3D 그래프가 나타납니다.

## 데이터 넣는 3가지 방법

1. **JSON 붙여넣기** — `{ "nodes": [...], "relationships": [...] }` 형식 텍스트
2. **JSON 파일** — 파일 선택 또는 드래그 앤드 드롭 (샘플: `examples/KG_Demon Slayer_Draft_01.json`)
3. **Neo4j** — 선택 사항. 서버 전용 환경 변수 설정 필요 ([visualization-3d/README.md](visualization-3d/README.md)의 "Neo4j 설정" 참고 — Neo4j AuraDB 클라우드 URI 지원)

## 저장소 구성

```
visualization-3d/              앱 본체 (Vite + React + react-force-graph-3d)
shared/ pipeline/ mcp-server/  비블리오마인드(BiblioMind) 파이프라인 패키지 — 개발 중
examples/KG_Demon Slayer_Draft_01.json  샘플 지식 그래프 데이터 (귀멸의 칼날)
```

앱의 상세 문서 — 데이터 스키마, 시각화 스타일 18종, Neo4j 보안 경계, Vercel 배포 방법 — 는 [visualization-3d/README.md](visualization-3d/README.md)에 있습니다.

## 검증

```bash
npm test       # 전 워크스페이스 Vitest 단위 테스트 (저장소 루트에서)
npm run lint
```
