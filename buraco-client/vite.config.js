import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  root: path.resolve(__dirname, '..'),
  plugins: [react()],
  base: '/',
  build: {
    outDir: path.resolve(__dirname, 'dist'),
  },
  server: {
    allowedHosts: true,
    port: 5173,
    host: true,
    fs: { allow: ['.'] }
  },
  preview: {
    allowedHosts: true,
    port: 5173,
    host: true
  }
})
