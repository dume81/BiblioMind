import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Card, Checkbox } from './ui.jsx';
import { collectRelationshipProperties, createFilteredGraph, resolveRelationshipFilterValue } from '../lib/filters.js';

// 기존 관계 필터 카드 이식. 필터 후보는 현재 그래프에서 다시 계산되고,
// 새 그래프에 없는 선택 값은 자동으로 해제된다 (유효한 공통 값은 유지).
export function PropertyFilters({ originalData, onFilteredDataChange, onReset }) {
  const [activeFilters, setActiveFilters] = useState({});

  const relationshipProperties = useMemo(
    () => collectRelationshipProperties(originalData.relationships),
    [originalData],
  );

  // 새 그래프가 로드되면 필터 선택을 전부 초기화한다 (이슈 3: 완전 초기화 사양).
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    setActiveFilters({});
  }, [originalData]);

  const handleValueToggle = (property, value) => {
    setActiveFilters((prev) => {
      const newFilters = { ...prev };

      if (!newFilters[property]) {
        newFilters[property] = [];
      }

      if (newFilters[property].includes(value)) {
        newFilters[property] = newFilters[property].filter((v) => v !== value);
        if (newFilters[property].length === 0) {
          delete newFilters[property];
        }
      } else {
        newFilters[property] = [...newFilters[property], value].sort();
      }

      return newFilters;
    });
  };

  useEffect(() => {
    if (Object.keys(activeFilters).length === 0) {
      onFilteredDataChange(originalData);
      return;
    }

    try {
      const relationshipOptions = {
        customFilter: (rel) => {
          return Object.entries(activeFilters).every(([property, values]) => {
            if (values.length === 0) return true;
            // 수집(collectRelationshipProperties)과 동일한 해석으로 값을 읽는다.
            const relValue = resolveRelationshipFilterValue(rel, property);
            return values.includes(String(relValue));
          });
        },
      };

      const filteredData = createFilteredGraph(originalData, relationshipOptions);
      onFilteredDataChange(filteredData);
    } catch (error) {
      console.error('Error applying filters:', error);
      onFilteredDataChange(originalData);
    }
  }, [activeFilters, originalData, onFilteredDataChange]);

  const clearAllFilters = () => {
    setActiveFilters({});
    onReset();
  };

  const getPropertyDisplayName = (property) => {
    if (property === 'episode_number') return '에피소드';
    if (property === 'type') return '관계 타입';
    if (property === 'label') return '노드 레이블';
    if (property === 'wall') return '벽';
    return property.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
  };

  return (
    <Card>
      <div className="p-4 border-b border-slate-800">
        <h3 className="flex items-center gap-2 text-lg font-semibold text-slate-200">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="22,3 2,3 10,12.46 10,19 14,21 14,12.46" />
          </svg>
          관계 필터
        </h3>
      </div>
      <div className="p-4 space-y-4">
        {Object.keys(relationshipProperties).length === 0 ? (
          <p className="text-slate-400 text-center py-4">관계 속성을 찾을 수 없습니다</p>
        ) : (
          Object.entries(relationshipProperties).map(([property, values]) => (
            <div key={property} className="space-y-3">
              <div className="flex items-center gap-2">
                <Badge variant="default">
                  {getPropertyDisplayName(property)}
                </Badge>
                {activeFilters[property] && activeFilters[property].length > 0 && (
                  <Badge variant="secondary">
                    {activeFilters[property].length} 선택됨
                  </Badge>
                )}
              </div>

              <div className="space-y-2">
                {values.map((value) => (
                  <div key={value} className="flex items-start space-x-2 w-full">
                    <Checkbox
                      id={`${property}-${value}`}
                      checked={activeFilters[property]?.includes(value) || false}
                      onChange={() => handleValueToggle(property, value)}
                    />
                    <label
                      htmlFor={`${property}-${value}`}
                      className="text-sm cursor-pointer leading-relaxed break-words flex-1 text-slate-300 hover:text-slate-200"
                      title={value}
                    >
                      {value}
                    </label>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}

        {Object.keys(activeFilters).length > 0 && (
          <div className="flex items-center justify-between pt-4 border-t border-slate-800">
            <div className="text-sm text-slate-400">
              {Object.keys(activeFilters).length} 필터 활성화됨
            </div>
            <button
              onClick={clearAllFilters}
              className="text-sm text-slate-400 hover:text-slate-200 underline transition-colors"
            >
              모든 필터 지우기
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}
