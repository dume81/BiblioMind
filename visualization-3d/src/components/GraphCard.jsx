import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Graph3D } from './Graph3D.jsx';
import { useFullscreen, CSS_FALLBACK_MESSAGE } from '../hooks/useFullscreen.js';
import { useReducedMotion } from '../hooks/useReducedMotion.js';
import { getNodeDisplayName } from '../lib/displayName.js';
import { VIZ_STYLES, DEFAULT_VIZ_STYLE_ID, DAG_ORIENTATIONS, getVizStyle, resolveStyleNotice } from '../lib/vizStyles.js';
import { analyzeDag } from '../lib/graphShape.js';

// 3D 렌더링 오류(WebGL 미지원 등)를 카드 내부 오류 overlay로 표시한다.
class GraphErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center text-red-400">
            <p className="font-medium">시각화 오류</p>
            <p className="text-sm">3D 그래프를 표시할 수 없습니다. (WebGL 지원 여부를 확인하세요)</p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function SelectionInfo({ selection, canonical }) {
  if (!selection || !canonical) return null;
  let title = '';
  let subtitle = '';
  let properties = {};
  if (selection.kind === 'node') {
    const node = canonical.nodes.find((n) => n.id === selection.id);
    if (!node) return null;
    title = getNodeDisplayName(node);
    subtitle = `노드 · ${node.label}`;
    properties = node.properties;
  } else {
    const rel = canonical.relationships.find((r) => r.id === selection.id);
    if (!rel) return null;
    title = rel.type;
    subtitle = `관계 · ${rel.start_node_id} → ${rel.end_node_id}`;
    properties = rel.properties;
  }
  const entries = Object.entries(properties);
  return (
    <div className="absolute bottom-3 left-3 max-w-[280px] max-h-[40%] overflow-y-auto p-3 bg-slate-950/80 border border-slate-700 rounded-lg backdrop-blur-sm text-sm pointer-events-auto">
      <div className="font-semibold text-slate-100">{title}</div>
      <div className="text-xs text-slate-400 mb-1">{subtitle}</div>
      {entries.length > 0 && (
        <dl className="text-xs text-slate-300 space-y-0.5">
          {entries.map(([key, value]) => (
            <div key={key} className="flex gap-2">
              <dt className="text-slate-500 shrink-0">{key}</dt>
              <dd className="break-all">{String(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

const overlayButtonClass = 'h-8 px-2.5 bg-slate-950/70 border border-slate-700 rounded-md text-slate-300 hover:text-white hover:bg-slate-800 text-xs transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';

export function GraphCard({
  renderData,
  canonical,
  graphKey,
  selectedNodeType,
  propertyHighlight,
  selection,
  onSelectionChange,
  queryHighlight,
  isLoading,
}) {
  const wrapperRef = useRef(null);
  const toggleBtnRef = useRef(null);
  const graphApiRef = useRef(null);
  const measureRef = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [searchTerm, setSearchTerm] = useState('');
  const { mode, isFullscreen, toggle, exit, announcement } = useFullscreen(wrapperRef, toggleBtnRef);
  const reducedMotion = useReducedMotion();

  // 시각화 스타일 — 뷰 설정이므로 데이터 로드·전체 화면 전환에도 유지된다.
  const [styleId, setStyleId] = useState(DEFAULT_VIZ_STYLE_ID);
  const vizStyle = getVizStyle(styleId);

  // DAG 배치 방향 (DAG 스타일에서만 노출)
  const [dagOrientation, setDagOrientation] = useState('td');

  // 자동 궤도 회전: 재생/일시정지. 스타일 진입 시 재생 상태로 시작한다.
  const [orbitPlaying, setOrbitPlaying] = useState(true);
  useEffect(() => {
    if (styleId === 'autoOrbit') setOrbitPlaying(true);
  }, [styleId]);
  const handleOrbitInterrupted = useCallback(() => setOrbitPlaying(false), []);

  // 다중 선택: 스타일을 떠나거나 새 그래프가 로드되면 비운다.
  const [multiSelectedIds, setMultiSelectedIds] = useState(() => new Set());
  useEffect(() => {
    if (styleId !== 'multiSelection') setMultiSelectedIds(new Set());
  }, [styleId]);
  useEffect(() => {
    setMultiSelectedIds(new Set());
    // 새 데이터 로드 시 검색어도 초기화한다 (이슈 3: 완전 초기화).
    setSearchTerm('');
  }, [graphKey]);

  const dagInfo = useMemo(() => analyzeDag(canonical), [canonical]);

  const styleNotice = useMemo(
    () => resolveStyleNotice(vizStyle, {
      reducedMotion,
      nodeCount: renderData.nodes.length,
      linkCount: renderData.links.length,
      dagOrientation,
      isDag: dagInfo.isDag,
      cycleEdgeCount: dagInfo.cycleEdgeCount,
    }),
    [vizStyle, reducedMotion, renderData, dagOrientation, dagInfo],
  );

  // 그래프 영역 크기 감지 — 전체 화면 진입·종료 시에도 이 관찰자가 renderer 크기를 갱신한다.
  useEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ width: rect.width, height: rect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 마운트·전체 화면 전환 시 즉시 측정하고, 다음 animation frame에서 한 번 더 반영한다.
  useEffect(() => {
    const measure = () => {
      const el = measureRef.current;
      if (el) setSize({ width: el.clientWidth, height: el.clientHeight });
    };
    measure();
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [mode]);

  const fullscreenLabel = isFullscreen ? '전체 화면 종료' : '전체 화면';

  const multiSelectedNames = useMemo(() => {
    if (!canonical || multiSelectedIds.size === 0) return [];
    return canonical.nodes
      .filter((n) => multiSelectedIds.has(n.id))
      .map((n) => getNodeDisplayName(n));
  }, [canonical, multiSelectedIds]);

  return (
    <div
      ref={wrapperRef}
      className={`graph-card-wrapper relative bg-slate-900/50 border border-slate-800 rounded-xl overflow-hidden backdrop-blur-sm ${
        mode === 'css' ? 'graph-fullscreen-fallback' : 'h-full w-full'
      }`}
    >
      <div ref={measureRef} className="absolute inset-0 bg-gradient-to-br from-slate-900 to-slate-950">
        <GraphErrorBoundary>
          {size.width > 0 && size.height > 0 && (
            <Graph3D
              ref={graphApiRef}
              data={renderData}
              graphKey={graphKey}
              width={size.width}
              height={size.height}
              selectedNodeType={selectedNodeType}
              propertyHighlight={propertyHighlight}
              selection={selection}
              onSelectionChange={onSelectionChange}
              queryHighlight={queryHighlight}
              searchTerm={searchTerm}
              vizStyle={vizStyle}
              reducedMotion={reducedMotion}
              dagOrientation={dagOrientation}
              orbitPlaying={orbitPlaying}
              onOrbitInterrupted={handleOrbitInterrupted}
              multiSelectedIds={multiSelectedIds}
              onMultiSelectedChange={setMultiSelectedIds}
            />
          )}
        </GraphErrorBoundary>
      </div>

      {/* 우상단 컨트롤: 시각화 스타일 · 스타일별 보조 컨트롤 · 검색 · 카메라 초기화 · 전체 화면 */}
      <div className="absolute top-3 right-3 flex flex-wrap items-center justify-end gap-2 max-w-[85%]">
        <select
          value={styleId}
          onChange={(e) => setStyleId(e.target.value)}
          aria-label="시각화 스타일"
          title="시각화 스타일"
          className="h-8 px-2 bg-slate-950/70 border border-slate-700 rounded-md text-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {VIZ_STYLES.map((style) => (
            <option key={style.id} value={style.id} title={style.description}>
              {style.label}
            </option>
          ))}
        </select>

        {styleId === 'dagMode' && (
          <select
            value={dagOrientation}
            onChange={(e) => setDagOrientation(e.target.value)}
            aria-label="DAG 배치 방향"
            title="DAG 배치 방향"
            className="h-8 px-2 bg-slate-950/70 border border-slate-700 rounded-md text-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {DAG_ORIENTATIONS.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        )}

        {styleId === 'autoOrbit' && (
          <button
            onClick={() => setOrbitPlaying((p) => !p)}
            aria-pressed={!orbitPlaying}
            className={overlayButtonClass}
          >
            {orbitPlaying ? '회전 정지' : '회전 재생'}
          </button>
        )}

        {styleId === 'dragFix' && (
          <button onClick={() => graphApiRef.current?.releaseFixedNodes()} className={overlayButtonClass}>
            고정 해제
          </button>
        )}

        {styleId === 'multiSelection' && multiSelectedIds.size > 0 && (
          <button onClick={() => setMultiSelectedIds(new Set())} className={overlayButtonClass}>
            선택 해제 ({multiSelectedIds.size})
          </button>
        )}

        <input
          type="search"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="노드 검색..."
          aria-label="노드 검색"
          className="h-8 w-36 px-2.5 bg-slate-950/70 border border-slate-700 rounded-md text-slate-100 placeholder:text-slate-500 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={() => graphApiRef.current?.zoomToFit()}
          aria-label="카메라 초기화"
          title="카메라 초기화"
          className={overlayButtonClass}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
            <path d="M3 21v-5h5" />
          </svg>
        </button>
        <button
          ref={toggleBtnRef}
          onClick={toggle}
          aria-label={fullscreenLabel}
          aria-pressed={isFullscreen}
          title={fullscreenLabel}
          className={`${overlayButtonClass} inline-flex items-center gap-1.5`}
        >
          {isFullscreen ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3v3a2 2 0 0 1-2 2H3" />
              <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
              <path d="M3 16h3a2 2 0 0 1 2 2v3" />
              <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3H5a2 2 0 0 0-2 2v3" />
              <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
              <path d="M3 16v3a2 2 0 0 0 2 2h3" />
              <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
            </svg>
          )}
          {fullscreenLabel}
        </button>
      </div>

      {/* CSS 확대 모드 안내 — native 전체 화면이 아님을 명확히 알린다 */}
      {mode === 'css' && (
        <div className="absolute top-14 right-3 max-w-[300px] p-2.5 bg-yellow-950/70 border border-yellow-800 rounded-lg text-yellow-200 text-xs">
          {CSS_FALLBACK_MESSAGE} Esc 또는 [전체 화면 종료] 버튼으로 나갈 수 있습니다.
          <button onClick={exit} className="ml-2 underline hover:text-yellow-100">종료</button>
        </div>
      )}

      {/* 스타일 안내 (성능 감쇠·모션 감소·조작 힌트) */}
      {styleNotice && (
        <div className="absolute top-3 left-3 max-w-[300px] px-2.5 py-1.5 bg-slate-950/70 border border-slate-800 rounded-md text-[11px] text-slate-400 pointer-events-none">
          {styleNotice}
        </div>
      )}

      {/* 다중 선택 목록 */}
      {styleId === 'multiSelection' && multiSelectedNames.length > 0 && (
        <div className="absolute top-14 left-3 max-w-[260px] max-h-[30%] overflow-y-auto p-2.5 bg-slate-950/80 border border-slate-700 rounded-lg text-xs text-slate-300">
          <div className="font-semibold text-slate-100 mb-1">선택된 노드 {multiSelectedNames.length}개</div>
          {multiSelectedNames.map((name, i) => (
            <div key={i} className="truncate">{name}</div>
          ))}
        </div>
      )}

      {/* 조작 안내 */}
      <div className="absolute bottom-3 right-3 px-2.5 py-1.5 bg-slate-950/60 border border-slate-800 rounded-md text-[11px] text-slate-500 pointer-events-none">
        회전: 드래그 · 확대/축소: 스크롤 · 이동: 우클릭 드래그 · 선택: 클릭
      </div>

      {/* 선택 정보 */}
      <SelectionInfo selection={selection} canonical={canonical} />

      {/* 로딩 overlay */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950/50 backdrop-blur-[2px]">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-400 mx-auto mb-2" />
            <p className="text-sm text-slate-400">데이터 불러오는 중...</p>
          </div>
        </div>
      )}

      {/* 전체 화면 상태 변경 알림 (스크린 리더용) */}
      <div aria-live="polite" className="sr-only">{announcement}</div>
    </div>
  );
}
