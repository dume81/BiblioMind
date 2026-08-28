# 지식 그래프 3D 시각화 (visualization-3d)

지식 그래프(JSON / Neo4j)를 **`react-force-graph-3d` 기반 3D**로 시각화·탐색하는 **Vite + React(JavaScript)** 앱입니다. 과거 vis-network 단일 파일 도구에서 이전된 프로젝트이며(원본 도구는 이 저장소에 포함되지 않음), 당시의 UI·문구·배치·색상을 그대로 유지하고 있습니다.

## 요구 사항

- Node.js 20.19+ (Vite 7 기준). **Node 22 LTS와 24 LTS**에서 검증되었습니다.

### Node.js 설치

[nodejs.org](https://nodejs.org)에서 LTS 설치 관리자를 실행하거나, Windows에서는 `winget install OpenJS.NodeJS.LTS`를 사용합니다. 설치 후 새 터미널에서 `node -v`로 확인합니다.

- 의존성 버전은 `package-lock.json`에 고정되어 있어, 같은 LTS 계열이면 어떤 방식으로 설치해도 실행 결과가 동일합니다.

## 실행 방법

아래 명령은 **저장소 루트**(이 폴더의 상위)에서 시작한다고 가정합니다. 이미 `visualization-3d` 안이라면 `cd visualization-3d`는 생략하세요.

### 최초 1회만: 의존성 설치

저장소를 clone/다운로드한 직후, `node_modules`를 지운 경우, `package.json` 의존성이 바뀐 경우에만 실행합니다. **평소 실행 시에는 필요 없습니다.**

```bash
cd visualization-3d
npm install
```

### 평소 실행 (매번 이것만)

```bash
cd visualization-3d
npm run dev:full
```

`npm run dev:full`은 전체 스택 실행 — Vite(5173) + 로컬 Neo4j API 서버(8787)를 함께 띄우고, Vite가 `/api` 요청을 8787로 프록시합니다. 다음 출력이 보이면 정상 기동입니다:

```
[api] [dev-api] http://localhost:8787/api/graph (Neo4j enabled: ..., configured: ...)
[web]   ➜  Local:   http://localhost:5173/
```

브라우저에서 `http://localhost:5173` 접속. 종료는 실행 중인 터미널에서 `Ctrl+C`.

- 프런트엔드만 필요하면 `npm run dev` (이 경우 Neo4j 탭은 "API 연결 불가" 안내만 표시).
- `EADDRINUSE` 오류가 나면 이전 서버가 아직 떠 있는 것입니다 — 기존 실행 창을 `Ctrl+C`로 종료하거나 해당 포트(8787/5173)를 점유한 node 프로세스를 종료한 뒤 다시 실행하세요.

### 빌드·검증 (필요할 때)

```bash
# 프로덕션 빌드 / 미리보기 (preview도 /api를 8787로 프록시)
npm run build
npm run preview

# 검증
npm run lint
npm run test
```

## 데이터 소스 3종

모든 소스는 동일한 **Canonical Graph**로 정규화된 뒤 같은 검증·필터·하이라이트·3D 렌더링 경로를 사용합니다.

```json
{
  "nodes": [{ "id": "string", "label": "string", "properties": {} }],
  "relationships": [{ "id": "string", "type": "string", "start_node_id": "string", "end_node_id": "string", "properties": {} }]
}
```

1. **JSON 붙여넣기** — 텍스트로 붙여넣고 `그래프 시각화` 클릭.
2. **JSON 파일** — 파일 선택 또는 드래그 앤드 드롭. 최대 5 MiB(`src/components/JsonFileInput.jsx`의 `MAX_JSON_FILE_BYTES` 상수), 한 번에 한 파일, UTF-8.
   - **경로 제약**: 웹브라우저는 보안상 `C:\...` 같은 경로 문자열만으로 로컬 파일을 읽을 수 없습니다. 경로 문자열을 붙여넣으면 앱이 안내 메시지를 표시합니다. 반드시 파일 선택/드롭을 사용하세요.
3. **Neo4j** — 서버 API(`/api/graph`)를 통해서만 조회. 브라우저에서 `neo4j-driver`를 직접 사용하지 않습니다.

로드 실패 시 현재 그래프는 유지되고 해당 입력 영역에만 오류가 표시됩니다. 연속 요청은 request ID로 최신 요청만 반영됩니다.

## Neo4j 설정 (서버 전용)

연결 정보는 **웹페이지 입력창이 아니라 서버 전용 환경 변수**로만 설정합니다.

| 변수 | 설명 |
|---|---|
| `NEO4J_SOURCE_ENABLED` | `true`일 때만 Neo4j 소스 활성화. **기본값(미설정)은 비활성화** |
| `NEO4J_URI` | 예: `neo4j+s://xxxx.databases.neo4j.io` 또는 `bolt://localhost:7687` |
| `NEO4J_USERNAME` | 읽기 전용 전용 계정 권장 (`reader` 롤 또는 MATCH 권한만) |
| `NEO4J_PASSWORD` | 비밀번호 |
| `NEO4J_DATABASE` | 기본 `neo4j` |

- **로컬**: `.env.example`을 복사해 `.env.local`을 만들고 값 입력. `.env.local`은 Git 무시 대상이며, `server/localServer.js`만 읽습니다(클라이언트 번들에 포함되지 않음).
- **Vercel**: 프로젝트 Settings → Environment Variables에 위 변수를 설정.
- **절대 `VITE_` 접두사를 쓰지 마세요.** `VITE_*` 변수는 클라이언트 번들에 노출됩니다.

### API 보안 경계

- 클라이언트는 `presetId` / `nodeLimit`(기본 300, 최대 1000) / `relationshipLimit`(기본 600, 최대 2000)만 보낼 수 있고, 그 외 키는 400으로 거부됩니다. 임의 Cypher·URI·자격증명은 서버로 전달될 수 없습니다.
- 서버는 고정된 매개변수화된 **읽기 전용** query preset만 실행합니다 (`server/core/presets.js`). 쓰기·관리 구문 없음, 명시적 database, 트랜잭션 timeout 15초.
- 응답은 `{ nodes, relationships, meta }`만 포함하며 `Cache-Control: no-store`로 전송됩니다. 원시 오류·query·접속 정보는 노출되지 않고 일반화된 오류 코드만 반환됩니다.
- **다중 label 정책**: Neo4j 노드에 label이 여러 개면 첫 번째 label(`node.labels[0]`)을 Canonical Graph의 단일 `label` 필드로 사용합니다. 전체 label 목록은 properties에 삽입하지 않습니다.
- ID는 deprecated된 `identity`/`start`/`end` 대신 `elementId` 계열을 사용합니다. Neo4j Integer는 안전 범위면 number, 초과면 10진 문자열로, temporal 값은 문자열로, Point는 `{srid, x, y, (z)}`로 변환됩니다.

### 공개 배포 주의

배포된 `/api/graph`는 외부에서 호출될 수 있습니다. **production 기본값은 Neo4j 소스 비활성화**이며, 공개 가능한 읽기 전용 그래프일 때만 `NEO4J_SOURCE_ENABLED=true`로 명시적으로 켜세요. 비공개 데이터라면 Vercel 접근 보호(Deployment Protection) 등을 먼저 적용해야 합니다.

## 그래프 전체 화면

- 그래프 카드 우상단 `전체 화면` 버튼 → 표준 Fullscreen API로 그래프 카드만 전체 화면 전환. Esc·브라우저 UI로 종료해도 상태가 정확히 복원됩니다.
- Fullscreen API 미지원·거부 시 자동으로 **페이지 내 확대 모드(CSS fallback)** 로 전환되고 그 사실을 안내합니다 (Esc/종료 버튼 지원, body 스크롤 잠금·복원, focus 복원).
- 전체 화면 전환은 데이터·필터·선택·하이라이트·카메라 상태를 변경하지 않습니다.

## 시각화 스타일

그래프 카드 우상단의 **시각화 스타일** 드롭다운으로 같은 그래프를 다른 방식으로 렌더링할 수 있습니다. 스타일은 `src/lib/vizStyles.js`의 선언적 레지스트리로 정의되며, 하나의 3D 렌더러(canvas 1개)에 오버라이드로 적용됩니다.

스타일은 **뷰 설정**입니다 — 데이터와 무관하며, 새 그래프 로드·전체 화면 전환·필터 변경에도 유지됩니다. 어떤 스타일에서도 기존 기능(필터·하이라이트·검색·선택·tooltip·전체 화면)이 그대로 동작합니다.

| 스타일 | 참조 예제 | 설명 |
|---|---|---|
| 기본 | — | 기존 기본 렌더링 (오버라이드 없음) |
| 이동 파티클 | `directional-links-particles` | 관계 방향을 따라 파티클 이동 |
| 관계 자동 색상 | `auto-colored` | 관계 유형별 결정적 색상 |
| 텍스트 노드 | `text-nodes` | 구체 대신 노드 이름 텍스트 |
| 유형별 도형 | `custom-node-shape` | 노드 유형(label)마다 다른 3D 도형 자동 배정 |
| 이웃 하이라이트 | `highlight` | 호버한 노드+인접 노드·관계 강조 |
| 다중 선택 | `multi-selection` | Ctrl/Shift+클릭 다중 선택, 선택 노드 함께 드래그, 선택 목록 표시 |
| 탐색 (확장/접기) | `expandable-nodes` | 연결 많은 노드에서 시작해 클릭으로 이웃 펼치기/접기 |
| 클릭 포커스 | `click-to-focus` | 노드 클릭 시 카메라 이동 (선택 기능과 공존) |
| 자동 궤도 회전 | `camera-auto-orbit` | 카메라 자동 회전. [회전 정지/재생] 버튼 제공, 사용자 조작 시 일시정지, 모션 감소 설정에서는 느린 회전 |
| 드래그 고정 | `fix-dragged-nodes` | 드래그한 노드 고정 + [고정 해제] 버튼 (필터로 숨겨진 고정 노드 포함 전체 해제, 스타일을 떠나면 자동 해제) |
| 충돌 감지 | `collision-detection` | 노드 크기 기반 충돌 포스 (겹침 방지) |
| 클릭 파티클 방출 | `emit-particles` | 관계 클릭 시 파티클 방출 |
| 블룸 효과 | `bloom-effect` | UnrealBloomPass 포스트프로세싱 |
| 대규모 성능 모드 | `large-graph` | 라벨 숨김·지오메트리 축소 성능 프리셋 |
| 화살표 강조 | `directional-links-arrows` | 방향 화살표 확대 |
| 관계 라벨 항상 표시 | `text-links` | LOD와 무관하게 모든 관계 라벨 표시 |
| DAG 트리 배치 | `tree` | 계층형 배치 — **상시 사용 가능.** 사이클이 있어도 동작하며(순환을 닫는 간선만 계층 계산에서 무시) 사이클 관계 개수를 안내. 방향 선택(위→아래/아래→위/좌→우/우→좌/중심→바깥/바깥→중심) 제공. 참조 예제의 인상 재현: 넓은 계층 간격(120), 뿌리일수록 큰 노드(실제 층 배치와 같은 깊이 규칙 + 충돌 포스), 진입·방향 변경 시 정면 카메라 정렬(사용자가 카메라를 잡으면 취소), 방향 파티클(관계 500개 초과 시 자동 꺼짐) |

동작 규칙:

- 강조 우선순위: **클릭 선택 > 다중 선택 > 호버 이웃 하이라이트 > 유형·속성 하이라이트 > 검색**.
- 성능 임계값(상수: `PARTICLE_LINK_THRESHOLD`=500, `BLOOM_NODE_THRESHOLD`=500): 초과 시 파티클 수·블룸 강도를 자동으로 낮추고 안내를 표시합니다.
- `prefers-reduced-motion`: 자동 궤도 회전은 느린 속도로 낮추고([회전 정지/재생] 버튼은 항상 제공), 파티클 속도는 감속, 클릭 포커스 카메라 이동은 즉시 이동.

렌더링 품질: 디스플레이 배율(devicePixelRatio)을 상한 `MAX_PIXEL_RATIO`(=2)까지 렌더러에 반영하고, 라벨 텍스처 해상도는 `SPRITE_TEXT_FONT_SIZE`(=180), 노드 구체 분할 수는 `NODE_SPHERE_RESOLUTION`(=16)으로 관리한다 (`src/components/Graph3D.jsx` 상단 상수). 개발 과정의 소스 스냅샷 백업(`_backup/`)은 개발 머신 로컬 전용이며 저장소에는 포함되지 않는다 — 저장소에서는 git 이력이 그 역할을 대신한다.

우측 패널: **하이라이트 카드**(유형 칩+개수 클릭 하이라이트 + 노드 속성 Property/Value 선택 하이라이트)와 **관계 필터 카드**가 하나의 스크롤 컬럼에 자연 높이로 쌓인다(겹침 불가 구조). 새 데이터가 성공적으로 로드되면 필터·선택·하이라이트·검색어는 **전부 초기화**되고 카메라가 새 그래프에 맞춰진다(시각화 스타일 선택만 유지).

제외한 예제와 이유: `ar-graph`(AR 전용), 2D 전용 예제(`custom-2d-shapes` 등 — 본 앱은 3D), `img-nodes`·`html-nodes`(이미지 자산·CSS2D DOM 의존 — 데이터에 이미지 URL이 없음), `all-modes`·`datasets`·`dynamic`(데모 인프라), `fit-to-canvas`(이미 카메라 초기화 버튼으로 존재), `curved-links`(이미 기본 구현에 포함 — 다중·셀프 관계 곡률).

## Vercel 배포

프로젝트 루트를 `visualization-3d`로 두고 배포하면 Vite 정적 빌드 + `api/graph.js` Node.js Function이 자동 인식됩니다.

1. Vercel 프로젝트 생성 (Framework: Vite)
2. 필요 시 환경 변수 설정 (위 표 참고 — 설정하지 않으면 Neo4j 탭은 안전하게 비활성 안내만 표시)
3. 배포

## 구조

```
api/graph.js          Vercel Node.js Function (Edge 아님)
server/core/          Vercel Function과 로컬 dev 서버가 공유하는 서버 코어
  config.js           환경 변수 읽기
  presets.js          고정 읽기 전용 query preset + limit 상수
  neo4jValues.js      Neo4j 특수 값 → JSON-safe 변환
  mapper.js           Neo4j → Canonical Graph 매핑 (중복 제거, dangling 제외)
  errors.js           오류 → 일반화된 코드
  handler.js          요청 검증·세션 수명주기·응답 조립
server/localServer.js 로컬 개발용 API 서버 (.env.local 로드)
src/lib/              Canonical Graph 정규화·검증, 색상, 필터, 렌더 데이터,
                      시각화 스타일 레지스트리(vizStyles), 그래프 형태 분석(graphShape), 드래그 고정 추적(pinTracker)
src/components/       이식된 UI + 데이터 소스 탭 + 3D 그래프 + 전체 화면
src/hooks/            로드 파이프라인(경쟁 상태 방지), 전체 화면 훅
tests/                Vitest 단위 테스트 (mapper·handler는 mock driver 기반)
```

## 알려진 제한

- 실제 Neo4j 인스턴스에 대한 연결은 별도의 읽기 전용 계정과 환경 변수 설정 후에만 가능합니다. 저장소에는 mock 기반 검증만 포함되어 있습니다.
- File System Access API는 사용하지 않습니다(브라우저 호환성).
