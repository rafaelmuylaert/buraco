import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
