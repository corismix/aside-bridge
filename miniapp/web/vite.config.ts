// vitest/config re-exports vite's defineConfig with the `test` block typed.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const API_TARGET = process.env.MINIAPP_DEV_API || 'http://127.0.0.1:8790';

export default defineConfig({
  plugins: [react()],
  test: {
    // Component tests drive real DOM events through React; the pure-logic
    // suites do not care either way.
    environment: 'jsdom',
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // The mini app is served from one origin; assets are relative so the
    // same bundle works behind a tunnel subpath.
    assetsDir: 'assets',
  },
  server: {
    // bind v4 explicitly: the default resolves to ::1 on this Mac, which
    // makes http://127.0.0.1:5273 refuse connections
    host: '127.0.0.1',
    port: 5273,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/ws': { target: API_TARGET, ws: true, changeOrigin: true },
    },
  },
});
