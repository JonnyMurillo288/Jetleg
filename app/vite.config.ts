import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import basicSsl from '@vitejs/plugin-basic-ssl';

/**
 * Browsers refuse geolocation on insecure origins, and localhost is the only
 * HTTP exemption. Opening the app on a phone at http://192.168.x.x therefore
 * loads fine but never produces a GPS fix — which disables the thermometer,
 * radar and measuring questions, i.e. most of the game.
 *
 * HTTPS=1 serves over TLS with a self-signed certificate so a phone on the same
 * wifi gets a secure context. `npm run tunnel` is the alternative, and gets a
 * real certificate with no browser warning.
 */
const useHttps = process.env.HTTPS === '1';

/**
 * The game runs all day, on a phone, often underground. The service worker
 * precaches the app shell and every layer file, and runtime-caches basemap
 * tiles as they are seen — so once the board has been panned over on wifi it
 * keeps working in a BART tunnel.
 */
export default defineConfig({
  /**
   * `host: true` listens on the LAN, not just localhost.
   *
   * `allowedHosts: true` is deliberate. Scoping it to an array — which is what
   * this was, to admit the quick-tunnel domain — does not *extend* Vite's
   * default allowlist, it *replaces* it. localhost and LAN IPs then stop being
   * allowed and every request 404s, which presents as a blank white app with no
   * error anywhere. These are local dev servers for a personal tool, so
   * accepting any Host is the right trade.
   */
  server: { host: true, allowedHosts: true },
  preview: { host: true, allowedHosts: true },
  plugins: [
    ...(useHttps ? [basicSsl()] : []),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['data/*.geojson', 'data/*.json'],
      manifest: {
        name: 'JetLeg — Hide+Seek San Francisco',
        short_name: 'JetLeg SF',
        description: 'Map and deduction tool for Jet Lag: Hide+Seek in San Francisco.',
        theme_color: '#111827',
        background_color: '#f8fafc',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '.',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Layer files are large; the default 2 MB cap would silently skip them.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,geojson,json,png,svg}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/tiles\.openfreemap\.org\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'basemap-tiles',
              expiration: { maxEntries: 4000, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
});
