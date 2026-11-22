import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['**/.claude/**', '**/node_modules/**', '**/dist/**'],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3001', '/ws': { target: 'ws://127.0.0.1:3001', ws: true } },
  },
});
