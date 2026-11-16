import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Standalone run: '@instinct/files' resolves to the local shim. No network services are used.
export default defineConfig({
    base: './',
    // build stamp shown in the staff app bar, so staff can see which version the browser loaded
    define: { __BUILD__: JSON.stringify(new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })) },
    plugins: [react()],
    resolve: { alias: { '@instinct/files': fileURLToPath(new URL('./shim/instinct-files.tsx', import.meta.url)) } },
    // If 5173 is busy (e.g. an earlier dev server is still open), Vite moves to the next free port and prints it.
    server: { host: '127.0.0.1', port: 5173, strictPort: false },
});
