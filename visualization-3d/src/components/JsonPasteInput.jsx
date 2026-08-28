import { useState } from 'react';
import { Button, Textarea } from './ui.jsx';
import { parseAndNormalizeJson } from '../lib/canonicalGraph.js';
import { SAMPLE_JSON_TEXT } from '../lib/sampleJson.js';
import { looksLikeFilePath, PATH_STRING_GUIDE_MESSAGE } from '../lib/pathString.js';

export function JsonPasteInput({ onLoad }) {
  const [jsonText, setJsonText] = useState(SAMPLE_JSON_TEXT);
  const [pathGuide, setPathGuide] = useState('');

  const handleRender = () => {
    if (!jsonText.trim()) {
      alert('먼저 JSON 데이터를 입력해주세요.');
      return;
    }
    // 파일 경로 문자열은 파일로 읽으려 시도하지 않고 안내만 표시한다.
    if (looksLikeFilePath(jsonText)) {
      setPathGuide(PATH_STRING_GUIDE_MESSAGE);
      return;
    }
    setPathGuide('');
    onLoad('paste', async () => parseAndNormalizeJson(jsonText));
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
      <div className="lg:col-span-3">
        <label className="block text-slate-200 mb-2">JSON 붙여넣기 (노드/관계)</label>
        <Textarea
          value={jsonText}
          onChange={(e) => setJsonText(e.target.value)}
          placeholder='{"nodes": [...], "relationships": [...]}'
          className="h-16"
        />
        <div className="text-xs text-slate-400 mt-2">
          <strong>스키마:</strong> nodes: [&#123; id, label, properties:&#123;&#125; &#125;], relationships: [&#123; type, start_node_id, end_node_id, properties:&#123;&#125; &#125;]
        </div>
        {pathGuide && (
          <div className="mt-2 p-3 bg-yellow-950/40 border border-yellow-800 rounded-lg text-yellow-200 text-sm whitespace-pre-line">
            {pathGuide}
          </div>
        )}
      </div>

      <div className="lg:col-span-1">
        <label className="block text-slate-200 mb-2">작업</label>
        <Button onClick={handleRender} className="w-full">
          그래프 시각화
        </Button>
      </div>
    </div>
  );
}
