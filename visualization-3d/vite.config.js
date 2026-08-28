import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// /api 요청은 로컬 개발 시 server/localServer.js(8787)로 프록시된다.
// Vercel 배포 시에는 같은 출처의 /api/graph Function이 직접 응답하므로 프록시가 필요 없다.
// 대상은 127.0.0.1 명시 — localServer가 127.0.0.1 전용 바인딩(TECH-SPEC §5.1)이라
// localhost가 ::1로 풀리는 환경에서 프록시가 실패하지 않게 한다.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
  test: {
    // 원복용 스냅샷(_backup) 안의 테스트가 중복 실행되지 않게 제외한다.
    exclude: [...configDefaults.exclude, '_backup/**'],
  },
});
