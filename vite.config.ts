import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ root: 'web', plugins: [react()], server: { hmr: false }, build: { outDir: '../dist/web', emptyOutDir: false } });
