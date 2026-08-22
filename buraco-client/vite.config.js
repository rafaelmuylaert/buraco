import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// With npm workspaces, dependencies are hoisted to the root node_modules
const workspaceRoot = path.resolve(__dirname, '..')
const nodeModules = path.resolve(workspaceRoot, 'node_modules')

export default defineConfig({
  root: path.resolve(__dirname, '..', 'Boards'),
  plugins: [react()],
  base: '/',
  build: {
    outDir: path.resolve(__dirname, 'dist'),
  },
  resolve: {
    alias: {
      'boardgame.io': path.resolve(nodeModules, 'boardgame.io'),
      'boardgame.io/react': path.resolve(nodeModules, 'boardgame.io/dist/cjs/react.js'),
      'boardgame.io/multiplayer': path.resolve(nodeModules, 'boardgame.io/dist/cjs/multiplayer.js'),
      'boardgame.io/client': path.resolve(nodeModules, 'boardgame.io/dist/cjs/client.js'),
      'socket.io-client': path.resolve(nodeModules, 'socket.io-client'),
      'react': path.resolve(nodeModules, 'react'),
      'react-dom': path.resolve(nodeModules, 'react-dom'),
      'react-dom/': path.resolve(nodeModules, 'react-dom/') + '',
      '@buraco/game/Buraco.js': path.resolve(workspaceRoot, 'GameEngines', 'Buraco.js'),
      '@buraco/game/Mighty.js': path.resolve(workspaceRoot, 'GameEngines', 'Mighty.js'),
      '@buraco/game/euchre.js': path.resolve(workspaceRoot, 'GameEngines', 'euchre.js'),
    },
    modules: [nodeModules, 'node_modules']
  },
  server: {
    allowedHosts: true,
    port: 5173,
    host: true,
    fs: { allow: [workspaceRoot] }
  },
  preview: {
    allowedHosts: true,
    port: 5173,
    host: true
  }
})
