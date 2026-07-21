import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'jsdom',
        include: ['packages/core/src/**/*.test.ts', 'packages/stress-million-cells-grid/__tests__/**/*.test.ts'],
    },
});
