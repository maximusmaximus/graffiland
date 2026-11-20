import path from 'node:path';
import { fileURLToPath } from 'node:url';
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  root: path.resolve(__dirname, 'client'),
  plugins: [react(), basicSsl()],
  server: {
    host: true,
    port: 5173,
    https: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true
      },
      '/ipfs': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true
      },
      '/ws': {
        target: 'ws://127.0.0.1:3001',
        ws: true
      }
    }
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react')) return 'react-vendor';
          if (id.includes('node_modules/xeroemoji')) return 'xeroemoji';
          if (id.includes('node_modules/qrcode')) return 'qrcode';
          if (id.includes('node_modules/three/examples/jsm')) return 'three-addons';
          if (id.includes('node_modules/three')) return 'three-core';
          if (id.includes('node_modules/maplibre-gl')) return 'maplibre';
          if (id.includes('node_modules/leaflet')) return 'leaflet';
          if (id.includes('node_modules/ethers')) return 'ethers';
          return undefined;
        }
      }
    }
  }
});
