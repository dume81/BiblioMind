import { useRef, useState } from 'react';
import { normalizeCanonicalGraph } from '../lib/canonicalGraph.js';

// 파일 크기 상한 (상수로 관리). 초과 시 명확한 오류를 표시하고 기존 그래프를 유지한다.
export const MAX_JSON_FILE_BYTES = 5 * 1024 * 1024; // 5 MiB

async function readAndNormalizeFile(file) {
  if (!file) {
    return { ok: false, errors: ['선택된 파일이 없습니다.'] };
  }
  if (file.size === 0) {
    return { ok: false, errors: [`빈 파일입니다: ${file.name}`] };
  }
  if (file.size > MAX_JSON_FILE_BYTES) {
    const mib = (file.size / (1024 * 1024)).toFixed(1);
    const limitMib = MAX_JSON_FILE_BYTES / (1024 * 1024);
    return { ok: false, errors: [`파일이 너무 큽니다 (${mib} MiB). 최대 ${limitMib} MiB까지 지원합니다.`] };
  }

  // 확장자·MIME이 부정확해도 실제 내용으로 검증한다. UTF-8로 읽는다.
  const text = await file.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, errors: [`JSON 구문 오류 (${file.name}): ${err.message}`] };
  }
  return normalizeCanonicalGraph(parsed);
}

export function JsonFileInput({ onLoad }) {
  const inputRef = useRef(null);
  const [dragActive, setDragActive] = useState(false);
  const [fileName, setFileName] = useState('');
  const [multiFileNotice, setMultiFileNotice] = useState('');

  // 한 번에 한 파일만 처리한다. 여러 개가 오면 첫 파일만 사용하고 알려준다.
  const handleFiles = (fileList) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    setMultiFileNotice(files.length > 1 ? `파일은 한 번에 하나만 처리합니다. "${files[0].name}"만 불러옵니다.` : '');
    const file = files[0];
    setFileName(file.name);
    onLoad('file', () => readAndNormalizeFile(file));
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragActive(false);
    handleFiles(e.dataTransfer?.files);
  };

  return (
    <div>
      <label className="block text-slate-200 mb-2">JSON 파일 선택</label>
      <div
        role="button"
        tabIndex={0}
        aria-label="JSON 파일 선택 또는 끌어 놓기"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        className={`flex flex-col items-center justify-center gap-2 p-8 border-2 border-dashed rounded-lg cursor-pointer transition-colors ${
          dragActive
            ? 'border-blue-500 bg-blue-950/30'
            : 'border-slate-700 bg-slate-950/50 hover:border-slate-500'
        }`}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-slate-400">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        <p className="text-sm text-slate-300">
          .json 파일을 클릭해서 선택하거나 이 영역으로 끌어 놓으세요
        </p>
        <p className="text-xs text-slate-500">최대 {MAX_JSON_FILE_BYTES / (1024 * 1024)} MiB · UTF-8 · 한 번에 한 파일</p>
        {fileName && <p className="text-xs text-blue-300 mt-1">선택한 파일: {fileName}</p>}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files);
          // 같은 파일을 다시 선택해도 change 이벤트가 발생하도록 값을 비운다.
          e.target.value = '';
        }}
      />
      {multiFileNotice && (
        <div className="mt-2 p-2 bg-yellow-950/40 border border-yellow-800 rounded-lg text-yellow-200 text-xs">
          {multiFileNotice}
        </div>
      )}
    </div>
  );
}
