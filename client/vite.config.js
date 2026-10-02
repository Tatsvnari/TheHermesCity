import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    rollupOptions: { input: { home: 'index.html', world: 'world.html', dashboard: 'dashboard.html', connect: 'connect.html', gazette: 'gazette.html', promo: 'promo.html', article: 'article.html' } },
  },
  server: { proxy: { '/api': 'http://127.0.0.1:8164', '/ws': { target: 'ws://127.0.0.1:8164', ws: true } } },
});
