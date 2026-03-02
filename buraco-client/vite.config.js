import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/buraco/', // THIS IS CRITICAL FOR NGINX SUB-PATHS
preview: {
    allowedHosts: true, // This tells Vite to trust your Nginx proxy hostname
    port: 4173,
    host: true
  }

})
