import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      },
      // PDFs de etiquetas: los sirve Express desde public/. Sin proxy, en dev
      // (5173) el link del panel da 404 y no se puede imprimir.
      '/etiquetas-marcopostal': { target: 'http://localhost:3000', changeOrigin: true },
      '/etiquetas-mercadolibre': { target: 'http://localhost:3000', changeOrigin: true },
      '/generated': { target: 'http://localhost:3000', changeOrigin: true }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  }
});
