import { useMemo } from 'react';
import { Button, Card } from './ui.jsx';
import { getColorForNodeType } from '../lib/colors.js';
import { collectNodePropertyOptions } from '../lib/filters.js';
import { citationPhrase, coverageNotice } from '../lib/queryHighlight.js';

// 하이라이트 카드 (이슈 2 재설계 — 사용자 제공 레퍼런스 UI 기준):
// - 쿼리 하이라이트 상태 (TECH-SPEC §7.6): 질문·citation 문구·N/M·truncated·결과 없음
// - 노드 유형 칩: 색상 점 + 유형명 + (개수), 클릭으로 유형 하이라이트
// - Property/Value 선택: 노드 속성 값 기준 하이라이트
// - 초기화: 유형·속성 하이라이트 모두 해제
// 모든 후보는 현재 그래프에서 동적으로 계산된다 (하드코딩 없음).
export function HighlightPanel({
  renderNodes,
  canonicalNodes,
  activeNodeType,
  onHighlightNodeType,
  propertyHighlight,
  onPropertyHighlightChange,
  onReset,
  queryHighlight,
  filterActive,
}) {
  const nodeTypes = useMemo(() => {
    const types = new Map();
    renderNodes.forEach((node) => {
      const type = node.label || 'Unknown';
      types.set(type, (types.get(type) || 0) + 1);
    });
    return Array.from(types.entries())
      .sort()
      .map(([type, count]) => ({ type, count, color: getColorForNodeType(type) }));
  }, [renderNodes]);

  const propertyOptions = useMemo(
    () => collectNodePropertyOptions(canonicalNodes || []),
    [canonicalNodes],
  );
  const propertyKeys = Object.keys(propertyOptions);
  const selectedProperty = propertyHighlight?.property || '';
  const selectedValue = propertyHighlight?.value || '';
  const valueOptions = selectedProperty ? propertyOptions[selectedProperty] || [] : [];

  const handleNodeTypeClick = (nodeType) => {
    if (activeNodeType === nodeType) {
      onHighlightNodeType?.(null);
    } else {
      onHighlightNodeType?.(nodeType);
    }
  };

  const handlePropertyChange = (property) => {
    // 속성이 바뀌면 값 선택은 초기화한다. 값이 선택되기 전에는 하이라이트가 적용되지 않는다.
    onPropertyHighlightChange?.(property ? { property, value: '' } : null);
  };

  const handleValueChange = (value) => {
    if (!selectedProperty) return;
    onPropertyHighlightChange?.(value ? { property: selectedProperty, value } : { property: selectedProperty, value: '' });
  };

  const selectClass = 'w-full h-9 px-2 bg-slate-950/50 border border-slate-700 rounded-lg text-slate-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-40';

  const coverage = coverageNotice(queryHighlight, filterActive);

  return (
    <Card className="p-4">
      {/* 쿼리 하이라이트 상태 (§7.6) — 챗 질문의 검색 결과가 표시 중일 때만 */}
      {queryHighlight && (
        <div className="mb-4 p-3 bg-slate-950/50 border border-blue-900/60 rounded-lg space-y-1.5">
          <div className="text-xs font-semibold text-blue-300">검색 하이라이트</div>
          {queryHighlight.question && (
            <p className="text-sm text-slate-200 break-all">“{queryHighlight.question}”</p>
          )}
          {queryHighlight.emptyResult ? (
            <p className="text-sm text-yellow-200">검색 결과 없음</p>
          ) : (
            <>
              <p className="text-xs text-slate-300">{citationPhrase(queryHighlight.citation)}</p>
              {coverage && <p className="text-xs text-yellow-200">{coverage}</p>}
              {queryHighlight.truncated && (
                <p className="text-xs text-yellow-200">검색 결과가 상한에서 절단됨 — 더 좁은 질문 권장</p>
              )}
            </>
          )}
        </div>
      )}

      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-slate-200">하이라이트</h3>
        <Button onClick={onReset} variant="outline" size="sm" className="flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
            <path d="M3 21v-5h5" />
          </svg>
          초기화
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {nodeTypes.map(({ type, count, color }) => (
          <button
            key={type}
            onClick={() => handleNodeTypeClick(type)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-all hover:bg-slate-800/70 ${
              activeNodeType === type ? 'bg-slate-800 ring-2 ring-yellow-400 shadow-lg shadow-yellow-400/30' : ''
            }`}
          >
            <div
              className={`w-2.5 h-2.5 rounded-full transition-all ${
                activeNodeType === type ? 'ring-2 ring-yellow-300 shadow-md shadow-yellow-300/50' : ''
              }`}
              style={{ backgroundColor: color }}
            />
            <span className="text-sm font-medium text-slate-200">{type}</span>
            <span className="text-xs text-slate-400">({count})</span>
          </button>
        ))}
      </div>

      <div className="mt-4 pt-4 border-t border-slate-800 grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="highlight-property" className="block text-xs text-slate-400 mb-1.5">Property</label>
          <select
            id="highlight-property"
            value={selectedProperty}
            onChange={(e) => handlePropertyChange(e.target.value)}
            className={selectClass}
          >
            <option value="">Select...</option>
            {propertyKeys.map((key) => (
              <option key={key} value={key}>{key}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="highlight-value" className="block text-xs text-slate-400 mb-1.5">Value</label>
          <select
            id="highlight-value"
            value={selectedValue}
            onChange={(e) => handleValueChange(e.target.value)}
            disabled={!selectedProperty}
            className={selectClass}
          >
            <option value="">Select...</option>
            {valueOptions.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </div>
      </div>
    </Card>
  );
}
