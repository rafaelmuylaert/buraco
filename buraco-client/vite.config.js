import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
 // 1. Force Vite to pre-bundle the core sub-export
  optimizeDeps: {
    include: ['boardgame.io/core']
  },
  
  // 2. Tell Rollup to allow CommonJS translation for boardgame.io
  build: {
    commonjsOptions: {
      include: [/boardgame\.io/, /node_modules/]
    }
  },
  base: '/',
  server: {
    allowedHosts: true,
    port: 5173,
    host: true,
    fs: { allow: ['..'] }
  },
  preview: {
    allowedHosts: true,
    port: 5173,
    host: true
  }
})
