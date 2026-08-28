import { useEffect, useRef, useState } from 'react';
import { Button, Badge } from './ui.jsx';
import { normalizeCanonicalGraph } from '../lib/canonicalGraph.js';
import { DEFAULT_NODE_LIMIT, DEFAULT_RELATIONSHIP_LIMIT } from '../lib/neo4jQueryDefaults.js';

// 서버가 보내는 일반화된 오류 코드 → 사용자용 안전한 메시지.
// URI·계정·원시 오류·Cypher는 클라이언트에 절대 노출되지 않는다.
const ERROR_MESSAGES = {
  NEO4J_DISABLED: 'Neo4j 데이터 소스가 비활성화되어 있습니다. 서버 환경 변수 NEO4J_SOURCE_ENABLED=true 설정이 필요합니다.',
  NEO4J_NOT_CONFIGURED: 'Neo4j 연결 정보가 설정되어 있지 않습니다. 로컬은 .env.local, Vercel은 프로젝트 환경 변수를 확인하세요 (README 참고).',
  AUTH_FAILED: 'Neo4j 인증에 실패했습니다. 서버에 설정된 계정 정보를 확인하세요.',
  NETWORK_ERROR: 'Neo4j 서버에 연결할 수 없습니다 (네트워크 또는 TLS 오류).',
  TIMEOUT: 'Neo4j 조회가 시간 초과되었습니다. 결과 개수 제한을 줄여서 다시 시도하세요.',
  INVALID_REQUEST: '요청이 올바르지 않습니다.',
  INVALID_PRESET: '허용되지 않은 query preset입니다.',
  INTERNAL_ERROR: 'Neo4j 조회 중 서버 내부 오류가 발생했습니다.',
};

function messageForCode(code) {
  return ERROR_MESSAGES[code] || ERROR_MESSAGES.INTERNAL_ERROR;
}

export function Neo4jInput({ onLoad, isLoading }) {
  const [status, setStatus] = useState({ state: 'checking' }); // checking | ready | disabled | unconfigured | unavailable
  const [presetId, setPresetId] = useState('');
  const [nodeLimit, setNodeLimit] = useState(DEFAULT_NODE_LIMIT);
  const [relationshipLimit, setRelationshipLimit] = useState(DEFAULT_RELATIONSHIP_LIMIT);
  const abortRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/graph');
        if (!res.ok) throw new Error(`status ${res.status}`);
        const info = await res.json();
        if (cancelled) return;
        if (!info.enabled) {
          setStatus({ state: 'disabled' });
        } else if (!info.configured) {
          setStatus({ state: 'unconfigured' });
        } else {
          setStatus({ state: 'ready', presets: info.presets, limits: info.limits });
          setPresetId(info.presets[0]?.id || '');
          setNodeLimit(info.limits.defaultNodeLimit);
          setRelationshipLimit(info.limits.defaultRelationshipLimit);
        }
      } catch {
        if (!cancelled) setStatus({ state: 'unavailable' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLoad = () => {
    const controller = new AbortController();
    abortRef.current = controller;

    onLoad('neo4j', async () => {
      let res;
      try {
        res = await fetch('/api/graph', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ presetId, nodeLimit, relationshipLimit }),
          signal: controller.signal,
        });
      } catch (err) {
        if (err?.name === 'AbortError') return { ok: false, cancelled: true, errors: [] };
        return { ok: false, errors: ['Neo4j API에 연결할 수 없습니다. 전체 스택 실행(npm run dev:full)이 필요합니다.'] };
      }

      let body;
      try {
        body = await res.json();
      } catch {
        return { ok: false, errors: [messageForCode('INTERNAL_ERROR')] };
      }

      if (!res.ok) {
        return { ok: false, errors: [messageForCode(body?.error?.code)] };
      }

      if (!body.nodes || body.nodes.length === 0) {
        return { ok: false, errors: ['데이터베이스가 비어 있거나 이 preset에 해당하는 노드가 없습니다.'] };
      }

      const normalized = normalizeCanonicalGraph({ nodes: body.nodes, relationships: body.relationships });
      if (!normalized.ok) return normalized;
      // query 보관: graph.refresh 자동 재조회가 이 preset·limit을 그대로 재사용한다 (§7.7).
      return {
        ...normalized,
        extraMeta: { truncated: Boolean(body.meta?.truncated), query: { presetId, nodeLimit, relationshipLimit } },
      };
    });
  };

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  if (status.state === 'checking') {
    return <p className="text-sm text-slate-400 py-4">Neo4j 연결 구성을 확인하는 중...</p>;
  }

  if (status.state !== 'ready') {
    const guide = {
      disabled: 'Neo4j 데이터 소스가 비활성화되어 있습니다. 서버 환경 변수 NEO4J_SOURCE_ENABLED=true로 활성화할 수 있습니다 (README 참고). 배포 기본값은 안전을 위해 비활성화입니다.',
      unconfigured: 'Neo4j 연결 정보가 설정되어 있지 않습니다. 연결 정보(URI·계정)는 화면이 아니라 서버 전용 환경 변수로만 설정합니다 — 로컬: .env.local, Vercel: 프로젝트 환경 변수 (README 참고).',
      unavailable: 'Neo4j API에 연결할 수 없습니다. 로컬에서는 전체 스택 실행(npm run dev:full)이 필요합니다.',
    }[status.state];
    return (
      <div className="p-4 bg-slate-950/50 border border-slate-700 rounded-lg">
        <div className="flex items-center gap-2 mb-2">
          <Badge>연결 구성: 없음</Badge>
        </div>
        <p className="text-sm text-slate-400 whitespace-pre-line">{guide}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Badge variant="secondary">연결 구성: 완료</Badge>
        <span className="text-xs text-slate-500">연결 정보는 서버에만 저장되며 브라우저로 전송되지 않습니다.</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 items-end">
        <div className="lg:col-span-2">
          <label htmlFor="neo4j-preset" className="block text-slate-200 mb-2 text-sm">Query preset</label>
          <select
            id="neo4j-preset"
            value={presetId}
            onChange={(e) => setPresetId(e.target.value)}
            className="w-full h-9 px-3 bg-slate-950/50 border border-slate-700 rounded-lg text-slate-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {status.presets.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="neo4j-node-limit" className="block text-slate-200 mb-2 text-sm">
            노드 제한 (최대 {status.limits.maxNodeLimit})
          </label>
          <input
            id="neo4j-node-limit"
            type="number"
            min="1"
            max={status.limits.maxNodeLimit}
            value={nodeLimit}
            onChange={(e) => setNodeLimit(Number(e.target.value))}
            className="w-full h-9 px-3 bg-slate-950/50 border border-slate-700 rounded-lg text-slate-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label htmlFor="neo4j-rel-limit" className="block text-slate-200 mb-2 text-sm">
            관계 제한 (최대 {status.limits.maxRelationshipLimit})
          </label>
          <input
            id="neo4j-rel-limit"
            type="number"
            min="1"
            max={status.limits.maxRelationshipLimit}
            value={relationshipLimit}
            onChange={(e) => setRelationshipLimit(Number(e.target.value))}
            className="w-full h-9 px-3 bg-slate-950/50 border border-slate-700 rounded-lg text-slate-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        {isLoading ? (
          <>
            <div className="flex items-center gap-2 text-sm text-slate-300">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-400" />
              Neo4j에서 불러오는 중...
            </div>
            <Button onClick={handleCancel} variant="outline" size="sm">취소</Button>
          </>
        ) : (
          <Button onClick={handleLoad}>Neo4j에서 불러오기</Button>
        )}
      </div>
    </div>
  );
}
