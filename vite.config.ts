import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import {defineConfig} from 'vite';

// CORREÇÃO (aviso do Vite configLoader 'native'): __dirname não existe em módulos
// ESM — usar import.meta.dirname (suportado nativamente no Node 20.11+).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      rollupOptions: {
        external: ['fs', 'os', 'path', 'child_process'],
      },
    },
    server: {
      // CORREÇÃO (deprecação do Vite): usar server.ws em vez de server.hmr legado.
      // HMR desativado via DISABLE_HMR env var (AI Studio) e watch desativado
      // quando DISABLE_HMR=true para economizar CPU durante edições do agente.
      ...(process.env.DISABLE_HMR === 'true'
        ? { ws: false as const, watch: null }
        : { ws: { port: Number(process.env.VITE_HMR_PORT || 24678) } }),
    },
  };
});
