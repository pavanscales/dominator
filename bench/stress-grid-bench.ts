import { chromium } from '@playwright/test';
import { writeFileSync } from 'fs';
import { join } from 'path';

const RESULTS_DIR = join(import.meta.dirname!, 'results');
const STRESS_GRID_URL = 'http://localhost:5176';

interface StressBenchResult {
    name: string;
    value: number;
    unit: string;
    details?: Record<string, number>;
}

async function run() {
    console.log('\n\x1b[35m═══════════════════════════════════════════════════════════════\x1b[0m');
    console.log('\x1b[35m  DOMINATOR STRESS GRID — 1M CELLS BENCHMARK\x1b[0m');
    console.log('\x1b[35m═══════════════════════════════════════════════════════════════\x1b[0m\n');

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
    });
    const page = await context.newPage();

    const cdpSession = await context.newCDPSession(page);
    await cdpSession.send('Performance.enable');

    const memBefore = await cdpSession.send('Performance.getMetrics');
    const jsHeapBefore = memBefore.metrics.find(m => m.name === 'JSHeapUsedSize')?.value || 0;

    console.log('\x1b[36m[*] Loading stress grid at http://localhost:5176...\x1b[0m');
    await page.goto('http://localhost:5176', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    const results: StressGridResult[] = [];

    console.log('\x1b[36m[*] Running: FPS Stability (30s)...\x1b[0m');
    const fpsResult = await page.evaluate(() => {
        return new Promise<StressGridResult>((resolve) => {
            const samples: number[] = [];
            const start = performance.now();
            const duration = 30000;

            function collect() {
                const el = document.querySelector('[style*="font-weight: bold"]');
                if (el) {
                    const fps = parseInt(el.textContent || '0', 10);
                    if (fps > 0) samples.push(fps);
                }
                if (performance.now() - start < duration) {
                    requestAnimationFrame(collect);
                } else {
                    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
                    const min = Math.min(...samples);
                    const max = Math.max(...samples);
                    const p5 = samples.sort((a, b) => a - b)[Math.floor(samples.length * 0.05)];
                    const dropped = samples.filter(f => f < 55).length;

                    resolve({
                        name: 'fps_stability_30s',
                        avg: Math.round(avg),
                        min,
                        max,
                        p5,
                        droppedFrames: dropped,
                        totalSamples: samples.length,
                    });
                }
            }
            requestAnimationFrame(collect);
        });
    });
    results.push(fpsResult);
    console.log(`  FPS: avg=\x1b[32m${fpsResult.avg}\x1b[0m min=\x1b[33m${fpsResult.min}\x1b[0m max=\x1b[32m${fpsResult.max}\x1b[0m p5=\x1b[33m${fpsResult.p5}\x1b[0m dropped=\x1b[31m${fpsResult.droppedFrames}\x1b[0m`);

    console.log('\x1b[36m[*] Running: Scroll Performance...\x1b[0m');
    const scrollResult = await page.evaluate(() => {
        return new Promise<StressGridResult>((resolve) => {
            const container = document.querySelector('.grid-container') as HTMLElement;
            if (!container) { resolve({ name: 'scroll_perf', avg: 0, min: 0, max: 0 }); return; }

            const frameTimes: number[] = [];
            let lastTime = performance.now();
            let scrolling = true;

            function onFrame() {
                if (!scrolling) return;
                const now = performance.now();
                frameTimes.push(now - lastTime);
                lastTime = now;

                container.scrollTop += 50;
                if (container.scrollTop >= container.scrollHeight - container.clientHeight) {
                    scrolling = false;
                    const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
                    resolve({
                        name: 'scroll_perf',
                        avg: Math.round(avg * 100) / 100,
                        min: Math.round(Math.min(...frameTimes) * 100) / 100,
                        max: Math.round(Math.max(...frameTimes) * 100) / 100,
                        totalFrames: frameTimes.length,
                    });
                    return;
                }
                requestAnimationFrame(onFrame);
            }
            requestAnimationFrame(onFrame);
        });
    });
    results.push(scrollResult);
    console.log(`  Scroll: avg=\x1b[32m${scrollResult.avg}ms\x1b[0m min=\x1b[33m${scrollResult.min}ms\x1b[0m max=\x1b[31m${scrollResult.max}ms\x1b[0m`);

    console.log('\x1b[36m[*] Running: Cell Update Throughput...\x1b[0m');
    const updateResult = await page.evaluate(() => {
        return new Promise<StressGridResult>((resolve) => {
            const w = window as any;
            const state = w.state;
            if (!state || !state.getGridData) { resolve({ name: 'cell_update_throughput', avg: 0 }); return; }

            const data = state.getGridData();
            const TOTAL_ROWS = state.TOTAL_ROWS;
            const TOTAL_COLS = state.TOTAL_COLS;
            const iterations = 10000;
            const times: number[] = [];

            for (let trial = 0; trial < 5; trial++) {
                const start = performance.now();
                for (let i = 0; i < iterations; i++) {
                    const r = (Math.random() * TOTAL_ROWS) | 0;
                    const c = (Math.random() * TOTAL_COLS) | 0;
                    data[r * TOTAL_COLS + c] = (Math.random() * 101) | 0;
                }
                times.push(performance.now() - start);
            }

            const avg = times.reduce((a, b) => a + b, 0) / times.length;
            resolve({
                name: 'cell_update_throughput',
                avg: Math.round(avg),
                opsPerMs: Math.round(iterations / avg),
            });
        });
    });
    results.push(updateResult);
    console.log(`  Updates: \x1b[32m${updateResult.opsPerMs}k writes/ms\x1b[0m (${updateResult.avg}ms for 10k)`);

    console.log('\x1b[36m[*] Running: Memory Stability...\x1b[0m');
    const memResult = await page.evaluate(() => {
        return new Promise<StressGridResult>((resolve) => {
            const samples: number[] = [];
            let count = 0;
            const maxSamples = 30;

            function sample() {
                if ((performance as any).memory) {
                    samples.push((performance as any).memory.usedJSHeapSize);
                }
                count++;
                if (count < maxSamples) {
                    setTimeout(sample, 1000);
                } else {
                    const avg = samples.length > 0 ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
                    const max = samples.length > 0 ? Math.max(...samples) : 0;
                    const min = samples.length > 0 ? Math.min(...samples) : 0;
                    const drift = max - min;
                    resolve({
                        name: 'memory_stability',
                        avgMB: Math.round(avg / 1024 / 1024 * 100) / 100,
                        maxMB: Math.round(max / 1024 / 1024 * 100) / 100,
                        minMB: Math.round(min / 1024 / 1024 * 100) / 100,
                        driftMB: Math.round(drift / 1024 / 1024 * 100) / 100,
                        samples: samples.length,
                    });
                }
            }
            sample();
        });
    });
    results.push(memResult);
    console.log(`  Memory: avg=\x1b[33m${memResult.avgMB}MB\x1b[0m drift=\x1b[33m${memResult.driftMB}MB\x1b[0m`);

    const memAfter = await cdpSession.send('Performance.getMetrics');
    const jsHeapAfter = memAfter.metrics.find(m => m.name === 'JSHeapUsedSize')?.value || 0;
    const domNodes = memAfter.metrics.find(m => m.name === 'Nodes')?.value || 0;
    const jsEventListeners = memAfter.metrics.find(m => m.name === 'JSEventListeners')?.value || 0;

    console.log('\n\x1b[32m╔═══════════════════════════════════════════════════════════════╗\x1b[0m');
    console.log('\x1b[32m║               STRESS GRID BENCHMARK RESULTS                  ║\x1b[0m');
    console.log('\x1b[32m╚═══════════════════════════════════════════════════════════════╝\x1b[0m\n');

    for (const r of results) {
        console.log(`  \x1b[33m${r.name}\x1b[0m`);
        const entries = Object.entries(r).filter(([k]) => k !== 'name');
        for (const [k, v] of entries) {
            console.log(`    ${k.padEnd(20)} \x1b[32m${v}\x1b[0m`);
        }
    }

    console.log(`\n\x1b[36m─── BROWSER METRICS (CDP) ───\x1b[0m`);
    console.log(`  DOM Nodes:              \x1b[33m${domNodes.toLocaleString()}\x1b[0m`);
    console.log(`  JS Event Listeners:     \x1b[33m${jsEventListeners.toLocaleString()}\x1b[0m`);
    console.log(`  JS Heap Before:         \x1b[33m${(jsHeapBefore / 1024 / 1024).toFixed(2)} MB\x1b[0m`);
    console.log(`  JS Heap After:          \x1b[33m${(jsHeapAfter / 1024 / 1024).toFixed(2)} MB\x1b[0m`);
    console.log(`  Heap Delta:             \x1b[33m${((jsHeapAfter - jsHeapBefore) / 1024 / 1024).toFixed(2)} MB\x1b[0m`);

    const report = {
        timestamp: new Date().toISOString(),
        browser: 'Chromium (Playwright)',
        viewport: '1920x1080',
        results,
        cdpMetrics: {
            domNodes,
            jsEventListeners,
            jsHeapBefore: jsHeapBefore / 1024 / 1024,
            jsHeapAfter: jsHeapAfter / 1024 / 1024,
            heapDelta: (jsHeapAfter - jsHeapBefore) / 1024 / 1024,
        },
    };

    const reportPath = new URL('./results/stress-grid-' + Date.now() + '.json', import.meta.url).pathname;
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n\x1b[36m[*] Full report saved to: ${reportPath}\x1b[0m`);

    await browser.close();
    console.log('\x1b[32m[*] Done.\x1b[0m\n');
}

interface StressGridResult {
    name: string;
    [key: string]: number | string;
}

run().catch(e => { console.error(e); process.exit(1); });
