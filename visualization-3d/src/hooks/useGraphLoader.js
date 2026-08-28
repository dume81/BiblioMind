import { useCallback, useRef, useState } from 'react';

// 모든 데이터 소스가 공유하는 로드 파이프라인:
//   데이터 읽기 → 파싱/조회 → 정규화 → 공통 검증 → staging
//   → 검증 성공 시에만 Canonical Graph 원자적 교체
//
// - 실패하면 현재 표시 중인 그래프를 절대 삭제하지 않는다 (오류는 소스별로 보관).
// - 동시 요청은 request ID로 최신 요청만 반영한다.
export function useGraphLoader() {
  const [current, setCurrent] = useState(null); // { graph, meta: { source, nodeCount, relationshipCount, truncated, warnings } }
  const [loadingSource, setLoadingSource] = useState(null);
  const [sourceErrors, setSourceErrors] = useState({}); // { [source]: string[] }
  const requestIdRef = useRef(0);

  const clearSourceError = useCallback((source) => {
    setSourceErrors((prev) => {
      if (!prev[source]) return prev;
      const next = { ...prev };
      delete next[source];
      return next;
    });
  }, []);

  /**
   * @param {string} source 'paste' | 'file' | 'neo4j' | 'push'
   * @param {() => Promise<{ok: true, graph, warnings?, extraMeta?} | {ok: false, errors}>} task
   * @returns {Promise<'replaced' | 'superseded' | 'cancelled' | 'failed'>}
   *   'replaced'만 그래프 교체 성공. 'superseded'(더 새 요청에 추월됨)·'cancelled'는
   *   실패가 아니다 — 호출자가 실패 안내를 띄울 때 'failed'만 대상으로 삼는다.
   */
  const load = useCallback(async (source, task) => {
    const requestId = ++requestIdRef.current;
    setLoadingSource(source);
    clearSourceError(source);

    let result;
    try {
      result = await task();
    } catch (err) {
      result = { ok: false, errors: [err?.message || '알 수 없는 오류가 발생했습니다.'] };
    }

    // 늦게 도착한 이전 요청은 무시한다 — 최신 요청만 그래프·오류·로딩 상태를 결정한다.
    if (requestId !== requestIdRef.current) return 'superseded';
    setLoadingSource(null);

    if (!result.ok) {
      // 취소는 오류로 표시하지 않는다.
      if (result.cancelled) return 'cancelled';
      setSourceErrors((prev) => ({ ...prev, [source]: result.errors }));
      return 'failed';
    }

    // 검증을 통과한 결과만 원자적으로 교체한다.
    setCurrent({
      graph: result.graph,
      meta: {
        source,
        nodeCount: result.graph.nodes.length,
        relationshipCount: result.graph.relationships.length,
        warnings: result.warnings || [],
        ...(result.extraMeta || {}),
      },
    });
    return 'replaced';
  }, [clearSourceError]);

  return { current, loadingSource, sourceErrors, load, clearSourceError };
}
