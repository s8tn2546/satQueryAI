import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import cesium from 'vite-plugin-cesium';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    cesium(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'satquery-icon.png', 'satquery-globe-icon.svg'],
      workbox: {
        maximumFileSizeToCacheInBytes: 50000000,
        globPatterns: ['**/*.{js,css,html,ico,png,svg,json}'],
      },
      manifest: {
        name: 'SatQuery AI — Earth Intelligence Platform',
        short_name: 'SatQuery AI',
        description: 'Multi-spectral satellite image analysis & visual QA engine powered by Vision-Language Models.',
        theme_color: '#060913',
        background_color: '#060913',
        display: 'standalone',
        icons: [
          {
            src: 'satquery-icon.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:5000',
    },
  },
});
