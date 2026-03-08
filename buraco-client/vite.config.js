import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/buraco/', // THIS IS CRITICAL FOR NGINX SUB-PATHS
  
  // THIS is the block that 'npm run dev' uses!
  server: {
    allowedHosts: true, // Trusts your Nginx proxy hostname
    port: 5173,
    host: true
  },

  // (Optional) Kept here just in case you ever run 'npm run preview' again
  preview: {
    allowedHosts: true, 
    port: 5173,
    host: true
  }
})
