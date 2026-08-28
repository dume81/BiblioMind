// 루트 flat config — 신규 패키지(shared/pipeline/mcp-server)와 scripts/ 전용.
// visualization-3d는 자체 eslint.config.js를 유지한다(루트 lint 스크립트가 -w로 위임 실행).
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'visualization-3d/**',
      'node_modules/**',
      'data/**',
      'examples/**',
      'coverage/**',
      'dist/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // 밑줄 접두 인자는 스텁·계약 문서화용 미사용 허용 (관례)
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
