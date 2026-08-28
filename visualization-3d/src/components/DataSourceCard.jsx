import { useState } from 'react';
import { Card } from './ui.jsx';
import { JsonPasteInput } from './JsonPasteInput.jsx';
import { JsonFileInput } from './JsonFileInput.jsx';
import { Neo4jInput } from './Neo4jInput.jsx';

const SOURCES = [
  { id: 'paste', label: 'JSON 붙여넣기' },
  { id: 'file', label: 'JSON 파일' },
  { id: 'neo4j', label: 'Neo4j' },
];

const SOURCE_LABELS = Object.fromEntries(SOURCES.map((s) => [s.id, s.label]));

export function DataSourceCard({ loader }) {
  const [activeSource, setActiveSource] = useState('paste');
  const { current, loadingSource, sourceErrors, load } = loader;

  const activeErrors = sourceErrors[activeSource];
  const showSuccess = current && current.meta.source === activeSource;

  return (
    <Card className="p-6">
      {/* 데이터 소스 선택 — 전환만으로는 현재 그래프를 삭제하지 않는다 */}
      <div role="tablist" aria-label="데이터 입력 방식" className="inline-flex rounded-lg border border-slate-700 bg-slate-950/50 p-1 mb-5">
        {SOURCES.map((source) => (
          <button
            key={source.id}
            role="tab"
            aria-selected={activeSource === source.id}
            onClick={() => setActiveSource(source.id)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
              activeSource === source.id
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {source.label}
          </button>
        ))}
      </div>

      {/* 각 입력 방식은 mount 상태를 유지해 작성 중인 내용을 보존한다 */}
      <div className={activeSource === 'paste' ? '' : 'hidden'}>
        <JsonPasteInput onLoad={load} />
      </div>
      <div className={activeSource === 'file' ? '' : 'hidden'}>
        <JsonFileInput onLoad={load} />
      </div>
      <div className={activeSource === 'neo4j' ? '' : 'hidden'}>
        <Neo4jInput onLoad={load} isLoading={loadingSource === 'neo4j'} />
      </div>

      {/* 오류: 실패해도 기존 그래프는 유지되고 해당 입력 영역에만 오류를 표시한다 */}
      {activeErrors && activeErrors.length > 0 && (
        <div className="mt-4 p-3 bg-red-950/50 border border-red-800 rounded-lg text-red-200 text-sm">
          {activeErrors.map((err, i) => (
            <div key={i}>{err}</div>
          ))}
        </div>
      )}

      {/* 성공: 노드·관계 개수 표시 */}
      {showSuccess && (
        <div className="mt-4 p-3 bg-slate-950/50 border border-slate-700 rounded-lg text-sm text-slate-300">
          <span className="text-blue-300 font-medium">{SOURCE_LABELS[current.meta.source]}</span>
          {'에서 불러옴 — 노드 '}
          <span className="font-semibold text-slate-100">{current.meta.nodeCount}</span>
          {'개 · 관계 '}
          <span className="font-semibold text-slate-100">{current.meta.relationshipCount}</span>개
          {current.meta.truncated && (
            <span className="ml-2 text-yellow-300">(서버 제한으로 일부 결과가 잘렸습니다)</span>
          )}
          {current.meta.warnings.length > 0 && (
            <div className="mt-1 text-xs text-yellow-200/80">
              {current.meta.warnings.slice(0, 5).map((w, i) => (
                <div key={i}>{w}</div>
              ))}
              {current.meta.warnings.length > 5 && (
                <div>... 외 {current.meta.warnings.length - 5}건</div>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
