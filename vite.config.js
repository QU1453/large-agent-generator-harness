import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base './' 使打包产物可被 file:// 协议加载
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500
  }
})
