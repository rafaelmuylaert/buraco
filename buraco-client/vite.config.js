import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/buraco/', // THIS IS CRITICAL FOR NGINX SUB-PATHS
  
  // THIS is the block that 'npm run dev' uses!
  server: {
    allowedHosts: true,
    port: parseInt(process.env.CLIENT_PORT || '5173'),
    host: true,
    proxy: {
      '/buraco/api': { target: `http://buraco-server:${process.env.SERVER_PORT || '8000'}`, rewrite: path => path.replace(/^\/buraco/, '') },
      '/buraco/games': { target: `http://buraco-server:${process.env.SERVER_PORT || '8000'}`, rewrite: path => path.replace(/^\/buraco/, '') },
      '/buraco/socket.io': { target: `http://buraco-server:${process.env.SERVER_PORT || '8000'}`, ws: true, rewrite: path => path.replace(/^\/buraco/, '') }
    }
  },
  preview: {
    allowedHosts: true,
    port: parseInt(process.env.CLIENT_PORT || '5173'),
    host: true
  }
})
