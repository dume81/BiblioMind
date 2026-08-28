// Neo4j 조회 기본 한도 — 입력 폼 초기값과 자동 전환 폴백(App.jsx)이 같은 값을 쓰는 단일 정본.
// 2026-08-28: 통합 재빌드로 그래프가 657노드·967관계가 되자 구 기본값(300·600)이 관계를
// 잘라 "존재하지 않는 고립 노드"가 화면에 보였다(DB 실측 고립 0). 서버 최대 허용치
// (server/core/presets.js의 MAX_*)와 같은 값으로 상향해 현 규모 전량이 기본으로 보이게 한다.
// 그래프가 이 한도를 넘게 커지면 절단이 재발한다 — 그때는 서버 한도와 함께 재결정할 것.
export const DEFAULT_NODE_LIMIT = 1000;
export const DEFAULT_RELATIONSHIP_LIMIT = 2000;
