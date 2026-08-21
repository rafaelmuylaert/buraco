import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@might': path.resolve(__dirname, '..', 'might'),
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
