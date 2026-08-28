import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useGraphLoader } from './hooks/useGraphLoader.js';
import { usePushChannel } from './hooks/usePushChannel.js';
import { buildRenderData } from './lib/renderData.js';
import { normalizeCanonicalGraph } from './lib/canonicalGraph.js';
import { resolveQueryHighlight, buildHighlightSnapshot } from './lib/queryHighlight.js';
import { DataSourceCard } from './components/DataSourceCard.jsx';
import { GraphCard } from './components/GraphCard.jsx';
import { HighlightPanel } from './components/HighlightPanel.jsx';
import { PropertyFilters } from './components/PropertyFilters.jsx';

function KnowledgeGraph() {
  const loader = useGraphLoader();
  const canonical = loader.current?.graph || null;

  // 새 그래프가 원자적으로 교체될 때만 증가 — Graph3D는 이 키가 바뀔 때만
  // simulation 재안정화 + zoomToFit 1회를 수행한다.
  const [graphKey, setGraphKey] = useState(0);

  // 필터 결과는 어느 canonical에서 계산됐는지(source)와 함께 저장한다 —
  // 데이터 교체 직후 이전 그래프의 필터 결과가 한 프레임이라도 새 그래프에 적용되는 것을 막는다.
  const [filteredEntry, setFilteredEntry] = useState(null);
  const [selectedNodeType, setSelectedNodeType] = useState(null);
  const [propertyHighlight, setPropertyHighlight] = useState(null);
  const [selection, setSelection] = useState(null);

  // 쿼리 하이라이트 (TECH-SPEC §5.3·§7): 마지막 highlight.set 메시지 — 마지막 신호 승자.
  // 데이터 교체(뷰 상태 초기화)와 독립적으로 유지된다 — 소스 자동 전환 후에도 적용되어야 한다.
  const [queryHighlight, setQueryHighlight] = useState(null);
  const [channelNotice, setChannelNotice] = useState(null); // 소스 자동 전환 등 1줄 안내 (§7.7)
  const [refreshBanner, setRefreshBanner] = useState(null); // graph.refresh 배너 { nodes } (§7.7)

  // 새 데이터가 성공적으로 로드되면 뷰 상태를 완전 초기화한다 (이슈 3 사양):
  // 필터(PropertyFilters 내부에서 초기화)·선택·유형/속성 하이라이트를 모두 리셋하고
  // 카메라 맞춤 1회(graphKey 증가로 트리거). 시각화 스타일 선택은 뷰 설정이므로 유지된다.
  useEffect(() => {
    setGraphKey((k) => k + 1);
    setSelection(null);
    setSelectedNodeType(null);
    setPropertyHighlight(null);
    // 재빌드 배너는 **직전 그래프**에 대한 안내다(§7.7). 화면의 그래프가 교체되면 그 안내는
    // 더 이상 지금 보고 있는 것을 설명하지 않으므로 함께 내린다.
    // 2026-08-23 실측 사고: 재빌드(29노드) 배너가 남은 채 검수용 p05(12노드)가 표시돼
    // **한 화면에 두 개의 노드 수가 동시에** 떠 있었다. 슬라이스 2에서 channelNotice로 한 번
    // 고쳤던 것과 **같은 유형**이 다른 상태 변수에서 재발한 것이다.
    // **여기(교체 지점)에 두는 이유**: graph.show 분기에만 넣으면 highlight.set의 Neo4j 자동
    // 전환 경로에서 같은 staleness가 다시 난다(이미 Neo4j인데 "Neo4j 그래프 열기" 배너가 남음).
    // **channelNotice는 여기 두면 안 된다** — 그 안내는 "왜 화면이 바뀌는지"를 교체 *직전*에
    // 띄우므로, 교체 시점에 지우면 사용자가 읽기도 전에 사라진다.
    setRefreshBanner(null);
  }, [canonical]);

  // 필터 변경은 유형·속성 하이라이트를 함께 해제한다 — 하이라이트 대상이 필터로
  // 전부 사라져 그래프 전체가 흐려진 채 남는 상황을 막는다.
  const handleFilteredDataChange = useCallback((data) => {
    setFilteredEntry({ source: canonical, data });
    setSelectedNodeType(null);
    setPropertyHighlight(null);
  }, [canonical]);

  const handleFilterReset = useCallback(() => {
    if (canonical) {
      setFilteredEntry({ source: canonical, data: canonical });
      setSelectedNodeType(null);
      setPropertyHighlight(null);
    }
  }, [canonical]);

  // 하이라이트 카드 초기화: 유형·속성 하이라이트 모두 해제.
  const handleHighlightReset = useCallback(() => {
    setSelectedNodeType(null);
    setPropertyHighlight(null);
  }, []);

  const handleHighlightNodeType = useCallback((nodeType) => {
    setSelectedNodeType(nodeType);
  }, []);

  // --- 푸시 채널 수신 (TECH-SPEC §5.3·§7.2·§7.3·§7.7) ---
  const { load } = loader;

  // 디스패치 핸들러가 최신 소스·직전 Neo4j 조회 조건을 재구독 없이 읽도록 ref로 전달한다.
  const currentSourceRef = useRef(null);
  currentSourceRef.current = loader.current?.meta.source || null;
  const lastNeo4jQueryRef = useRef(null);
  lastNeo4jQueryRef.current = loader.current?.meta.source === 'neo4j'
    ? loader.current.meta.query || null
    : lastNeo4jQueryRef.current;

  // Neo4j 로드 (자동 전환·재조회·배너 버튼 공용) — 기존 검증→원자 교체 파이프라인 재사용.
  // query를 meta에 보관해 graph.refresh 재조회가 사용자의 preset·limit을 그대로 쓰게 한다(§7.7).
  const loadFromNeo4j = useCallback((query) => {
    const effectiveQuery = query || { presetId: 'overview' };
    return load('neo4j', async () => {
      let res;
      try {
        res = await fetch('/api/graph', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(effectiveQuery),
        });
      } catch {
        return { ok: false, errors: ['Neo4j API에 연결할 수 없습니다. 전체 스택 실행(npm run dev:all)이 필요합니다.'] };
      }
      let body;
      try {
        body = await res.json();
      } catch {
        return { ok: false, errors: ['Neo4j 응답을 해석할 수 없습니다.'] };
      }
      if (!res.ok) {
        return { ok: false, errors: ['Neo4j 조회에 실패했습니다. Neo4j 탭에서 상세를 확인하세요.'] };
      }
      if (!body.nodes || body.nodes.length === 0) {
        return { ok: false, errors: ['데이터베이스가 비어 있거나 노드가 없습니다.'] };
      }
      const normalized = normalizeCanonicalGraph({ nodes: body.nodes, relationships: body.relationships });
      if (!normalized.ok) return normalized;
      return { ...normalized, extraMeta: { truncated: Boolean(body.meta?.truncated), query: effectiveQuery } };
    });
  }, [load]);

  const handlePushMessage = useCallback((type, message) => {
    if (type === 'highlight.set') {
      setQueryHighlight(message);
      // 소스 자동 전환 (§5.3·§7.7 — 예외 없음): 'superseded'는 실패가 아니다.
      if (currentSourceRef.current !== 'neo4j') {
        setChannelNotice('검색 하이라이트를 위해 Neo4j 그래프로 전환했습니다.');
        loadFromNeo4j(lastNeo4jQueryRef.current).then((status) => {
          if (status === 'failed') {
            setChannelNotice('Neo4j 그래프 전환에 실패했습니다 — Neo4j 탭에서 오류를 확인하세요.');
          }
        });
      }
      return;
    }
    if (type === 'highlight.clear') {
      setQueryHighlight(null);
      return;
    }
    if (type === 'graph.show') {
      // 검수용 그래프 표시 (§7.3) — 마지막 신호 승자: 교체 성공 시에만 이전 하이라이트 소거,
      // 검증 실패는 화면에 1줄 안내한다 (침묵 실패 방지).
      load('push', async () => {
        const normalized = normalizeCanonicalGraph(message.graph || {});
        if (!normalized.ok) return normalized;
        return {
          ...normalized,
          extraMeta: {
            file: message.file ?? null,
            sourceInput: message.sourceInput ?? null,
            purpose: message.purpose ?? 'review',
          },
        };
      }).then((status) => {
        if (status === 'replaced') {
          setQueryHighlight(null);
          // 낡은 안내 소거 (2026-08-22 슬라이스 2 브라우저 실왕복에서 발견).
          // channelNotice는 "왜 화면이 바뀌었는지"를 설명한다. 검수용 그래프로 교체되면
          // 직전의 "검색 하이라이트를 위해 Neo4j 그래프로 전환했습니다"는 **사실이 아니게 된다** —
          // 실측에서 검수 파일명과 그 문구가 화면에 동시에 떠 서로 모순된 안내를 보였다.
          setChannelNotice(null);
        } else if (status === 'failed') {
          setChannelNotice('검수용 그래프 표시에 실패했습니다 — 데이터 검증 오류 (챗에서 재시도하세요).');
        }
      });
      return;
    }
    if (type === 'graph.refresh') {
      // 현재 소스가 neo4j면 직전 조회 조건 그대로 자동 재조회, 아니면 배너 안내 (§7.7).
      if (currentSourceRef.current === 'neo4j') {
        loadFromNeo4j(lastNeo4jQueryRef.current);
      } else {
        setRefreshBanner({ nodes: message.counts?.nodes ?? null });
      }
    }
  }, [load, loadFromNeo4j]);

  usePushChannel(handlePushMessage);

  // 렌더 데이터는 Canonical Graph의 복제본 — react-force-graph-3d가 좌표를 주입해도
  // Canonical Graph는 변하지 않는다. 필터는 같은 렌더 객체를 재사용해 좌표를 보존한다.
  const fullRender = useMemo(() => (canonical ? buildRenderData(canonical) : null), [canonical]);

  const renderData = useMemo(() => {
    if (!fullRender) return null;
    // 현재 canonical에서 계산된 필터 결과만 적용한다 (이전 그래프의 결과는 무시).
    const filteredData = filteredEntry && filteredEntry.source === canonical ? filteredEntry.data : null;
    if (!filteredData || filteredData === canonical) return fullRender;
    const nodeIds = new Set(filteredData.nodes.map((n) => n.id));
    const relIds = new Set(filteredData.relationships.map((r) => r.id));
    return {
      nodes: fullRender.nodes.filter((n) => nodeIds.has(n.id)),
      links: fullRender.links.filter((l) => relIds.has(l.id)),
    };
  }, [fullRender, filteredEntry, canonical]);

  // 필터 활성 여부 — N/M 안내의 원인별 힌트 분기(§5.4)에 쓴다.
  const filterActive = Boolean(
    filteredEntry && filteredEntry.source === canonical && filteredEntry.data !== canonical,
  );

  // 하이라이트 해석은 필터 적용본(renderData) 기준 — 숨김 요소는 자연히 M에서 제외된다 (§7.5).
  const resolvedHighlight = useMemo(
    () => (queryHighlight && renderData ? resolveQueryHighlight(queryHighlight, renderData) : null),
    [queryHighlight, renderData],
  );

  // 판정 자동 대조용 읽기 전용 진단 스냅샷 (§7.9). 화면은 이 전역을 읽지 않으므로
  // 지워도 3상태 표시는 그대로 동작한다 — 렌더링 경로에 관여하지 않는다.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.__bibliomind = buildHighlightSnapshot(resolvedHighlight, renderData);
  }, [resolvedHighlight, renderData]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
      <div className="container mx-auto py-8 space-y-8 px-4">
        <div className="text-center">
          <h1 className="text-4xl font-bold tracking-tight bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
            비블리오마인드
          </h1>
        </div>

        <DataSourceCard loader={loader} />

        {/* 검수 컨텍스트 (§7.3): push 소스로 표시 중일 때 파일명·원 자료·배지 */}
        {loader.current?.meta.source === 'push' && (
          <div className="p-3 bg-purple-950/40 border border-purple-800 rounded-lg text-sm text-purple-200 flex flex-wrap items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-purple-800/60 text-xs font-semibold">검수용 표시</span>
            {loader.current.meta.file && <span>{loader.current.meta.file}</span>}
            {loader.current.meta.sourceInput && (
              <span className="text-purple-300/80">원 자료: {loader.current.meta.sourceInput}</span>
            )}
          </div>
        )}

        {/* 푸시 채널 1줄 안내 (§7.7 — 소스 자동 전환 등) */}
        {channelNotice && (
          <div className="p-3 bg-blue-950/40 border border-blue-800 rounded-lg text-sm text-blue-200 flex items-center justify-between gap-3">
            <span>{channelNotice}</span>
            <button
              onClick={() => setChannelNotice(null)}
              aria-label="안내 닫기"
              className="text-blue-300 hover:text-blue-100 text-xs shrink-0"
            >
              닫기
            </button>
          </div>
        )}

        {/* 재빌드 배너 (§5.2 graph.refresh — 현재 소스가 neo4j가 아닐 때) */}
        {refreshBanner && (
          <div className="p-3 bg-emerald-950/40 border border-emerald-800 rounded-lg text-sm text-emerald-200 flex items-center justify-between gap-3">
            <span>
              그래프가 재빌드되었습니다
              {refreshBanner.nodes != null && ` (노드 ${Number(refreshBanner.nodes).toLocaleString()})`}
            </span>
            <button
              onClick={() => {
                setRefreshBanner(null);
                loadFromNeo4j(lastNeo4jQueryRef.current);
              }}
              className="px-2.5 py-1 rounded-md bg-emerald-800/60 hover:bg-emerald-700/60 text-emerald-100 text-xs shrink-0"
            >
              Neo4j 그래프 열기
            </button>
          </div>
        )}

        {renderData && (
          <div className="flex flex-col lg:flex-row lg:gap-8 h-[750px]">
            <div className="w-full lg:w-[75%] order-2 lg:order-1">
              <GraphCard
                renderData={renderData}
                canonical={canonical}
                graphKey={graphKey}
                selectedNodeType={selectedNodeType}
                propertyHighlight={propertyHighlight}
                selection={selection}
                onSelectionChange={setSelection}
                queryHighlight={resolvedHighlight}
                isLoading={loader.loadingSource !== null}
              />
            </div>
            {/* 우측 패널: 하나의 스크롤 컬럼 — 카드가 자연 높이로 쌓여 겹침이 구조적으로 불가능하다 (이슈 2). */}
            <div className="w-full lg:w-[25%] order-1 lg:order-2 mb-4 lg:mb-0 lg:h-full lg:overflow-y-auto flex flex-col gap-4 lg:pr-1">
              <div className="shrink-0">
                <HighlightPanel
                  renderNodes={renderData.nodes}
                  canonicalNodes={canonical ? canonical.nodes : []}
                  activeNodeType={selectedNodeType}
                  onHighlightNodeType={handleHighlightNodeType}
                  propertyHighlight={propertyHighlight}
                  onPropertyHighlightChange={setPropertyHighlight}
                  onReset={handleHighlightReset}
                  queryHighlight={resolvedHighlight}
                  filterActive={filterActive}
                />
              </div>
              <div className="shrink-0">
                {canonical && (
                  <PropertyFilters
                    originalData={canonical}
                    onFilteredDataChange={handleFilteredDataChange}
                    onReset={handleFilterReset}
                  />
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  return <KnowledgeGraph />;
}
