import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: '.',
    fullyParallel: false,
    retries: 0,
    workers: 1,
    timeout: 600_000,
    expect: { timeout: 30_000 },
    use: {
        baseURL: 'http://localhost:5176',
        headless: true,
        viewport: { width: 1920, height: 1080 },
        launchOptions: {
            args: [
                '--disable-web-security',
                '--no-sandbox',
                '--disable-gpu-sandbox',
                '--disable-setuid-sandbox',
                '--js-flags=--expose-gc',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                '--disable-backgrounding-occluded-windows',
            ],
        },
    },
    webServer: {
        command: 'npx vite --port 5176',
        port: 5176,
        cwd: '..',
        reuseExistingServer: false,
        timeout: 30_000,
    },
});
