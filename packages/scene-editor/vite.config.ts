import { defineConfig } from 'vite';
import { dominatorPlugin } from '@dominator/core/dist/compiler/vite-plugin';

export default defineConfig({
    plugins: [dominatorPlugin()],
    server: {
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
        },
    },
});
