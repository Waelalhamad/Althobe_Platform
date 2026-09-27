import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API runs on :3000 and Vite proxies /api to it, so the browser sees one origin
// — exactly as in production, where the API serves this app's built files (ADR-005).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5180,
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
});
