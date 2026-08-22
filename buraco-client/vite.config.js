import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default defineConfig({
  root: path.resolve(__dirname, '..', 'Boards'),
  plugins: [react()],
  base: '/',
  build: {
    outDir: path.resolve(__dirname, 'dist'),
  },
  resolve: {
    alias: {
      'boardgame.io': path.resolve(__dirname, 'node_modules/boardgame.io'),
      'boardgame.io/react': path.resolve(__dirname, 'node_modules/boardgame.io/dist/cjs/react.js'),
      'boardgame.io/multiplayer': path.resolve(__dirname, 'node_modules/boardgame.io/dist/cjs/multiplayer.js'),
      'boardgame.io/client': path.resolve(__dirname, 'node_modules/boardgame.io/dist/cjs/client.js'),
      'socket.io-client': path.resolve(__dirname, 'node_modules/socket.io-client'),
      'react': path.resolve(__dirname, 'node_modules/react'),
      'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
      'react-dom/': path.resolve(__dirname, 'node_modules/react-dom/') + '',
      '@buraco/game/Buraco.js': path.resolve(__dirname, '..', 'GameEngines', 'Buraco.js'),
      '@buraco/game/Mighty.js': path.resolve(__dirname, '..', 'GameEngines', 'Mighty.js'),
      '@buraco/game/euchre.js': path.resolve(__dirname, '..', 'GameEngines', 'euchre.js'),
    },
    modules: [path.resolve(__dirname, 'node_modules'), 'node_modules']
  },
  server: {
    allowedHosts: true,
    port: 5173,
    host: true,
    fs: { allow: [path.resolve(__dirname, '..')] }
  },
  preview: {
    allowedHosts: true,
    port: 5173,
    host: true
  }
})
