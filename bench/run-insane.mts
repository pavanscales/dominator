import { chromium } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const RESULTS_DIR = join(import.meta.dirname!, 'results');
const HTML_PATH = join(import.meta.dirname!, 'insane-bench.html');

mkdirSync(RESULTS_DIR, { recursive: true });

interface BenchResult {
    name: string;
    ops: number;
    elapsed: number;
    opsPerSec: number;
    engine?: string;
}

async function run() {
    console.log('\n\x1b[31m╔═══════════════════════════════════════════════════════════════════╗\x1b[0m');
    console.log('\x1b[31m║  DOMINATOR INSANE BENCHMARK — Old vs New DOD (Real Chromium)    ║\x1b[0m');
    console.log('\x1b[31m╚═══════════════════════════════════════════════════════════════════╝\x1b[0m\n');

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
    });
    const page = await context.newPage();

    const cdpSession = await context.newCDPSession(page);
    await cdpSession.send('Performance.enable');

    const memBefore = await cdpSession.send('Performance.getMetrics');
    const jsHeapBefore = memBefore.metrics.find(m => m.name === 'JSHeapUsedSize')?.value || 0;

    console.log('\x1b[36m[*] Loading insane benchmark page...\x1b[0m');
    await page.goto(`file:///${HTML_PATH.replace(/\\/g, '/')}`);
    console.log('\x1b[36m[*] Running 8 benchmarks (~30s)...\x1b[0m');

    await page.waitForFunction(() => {
        const el = document.getElementById('benchmark-data');
        return el && el.getAttribute('data-done') === 'true';
    }, { timeout: 300000 });

    const rawResults = await page.evaluate(() => {
        return JSON.parse(document.getElementById('benchmark-data')!.textContent!);
    }) as BenchResult[];

    const memAfter = await cdpSession.send('Performance.getMetrics');
    const jsHeapAfter = memAfter.metrics.find(m => m.name === 'JSHeapUsedSize')?.value || 0;
    const domNodes = memAfter.metrics.find(m => m.name === 'Nodes')?.value || 0;
    const jsEventListeners = memAfter.metrics.find(m => m.name === 'JSEventListeners')?.value || 0;

    console.log('\n\x1b[32m╔═══════════════════════════════════════════════════════════════════╗\x1b[0m');
    console.log('\x1b[32m║                   INSANE BENCHMARK RESULTS                       ║\x1b[0m');
    console.log('\x1b[32m╚═══════════════════════════════════════════════════════════════════╝\x1b[0m\n');

    // Group and display results
    const oldResults: Record<string, number> = {};
    const newResults: Record<string, number> = {};

    for (const r of rawResults) {
        if (r.engine === 'old') {
            const key = r.name.replace('_old', '');
            oldResults[key] = r.opsPerSec;
        } else if (r.engine === 'new') {
            const key = r.name.replace('_new', '');
            newResults[key] = r.opsPerSec;
        }
    }

    // Print comparison table
    console.log('\x1b[33m  BENCHMARK                          OLD              NEW           SPEEDUP\x1b[0m');
    console.log('  ' + '─'.repeat(75));

    for (const key of Object.keys(oldResults)) {
        const oldV = oldResults[key]!;
        const newV = newResults[key] || 0;
        const speedup = newV > 0 ? (newV / oldV).toFixed(1) + 'x' : 'N/A';
        const speedupColor = newV > oldV ? '\x1b[32m' : newV < oldV ? '\x1b[31m' : '\x1b[33m';
        console.log(`  ${key.padEnd(36)} \x1b[33m${String(oldV).padStart(10)}\x1b[0m  ${speedupColor}${String(newV).padStart(10)}\x1b[0m  ${speedupColor}${speedup.padStart(8)}\x1b[0m`);
    }

    // Print standalone results
    for (const r of rawResults) {
        if (!r.engine || (r.engine !== 'old' && r.engine !== 'new')) {
            console.log(`  ${r.name.padEnd(36)} \x1b[32m${String(r.opsPerSec).padStart(10)}\x1b[0m  ${r.engine === 'dom' ? 'DOM ops/sec' : r.engine === 'pipeline' ? 'pipeline ops/sec' : 'FPS'}`);
        }
    }

    console.log(`\n\x1b[36m─── BROWSER METRICS (CDP) ───\x1b[0m`);
    console.log(`  DOM Nodes:              \x1b[33m${domNodes.toLocaleString()}\x1b[0m`);
    console.log(`  JS Event Listeners:     \x1b[33m${jsEventListeners.toLocaleString()}\x1b[0m`);
    console.log(`  JS Heap Before:         \x1b[33m${(jsHeapBefore / 1024 / 1024).toFixed(2)} MB\x1b[0m`);
    console.log(`  JS Heap After:          \x1b[33m${(jsHeapAfter / 1024 / 1024).toFixed(2)} MB\x1b[0m`);
    console.log(`  Heap Delta:             \x1b[33m${((jsHeapAfter - jsHeapBefore) / 1024 / 1024).toFixed(2)} MB\x1b[0m`);

    const perfMetrics = await cdpSession.send('Performance.getMetrics');
    console.log(`\n\x1b[36m─── CDP PERFORMANCE METRICS ───\x1b[0m`);
    for (const m of perfMetrics.metrics) {
        if (typeof m.value === 'number' && m.value > 0) {
            console.log(`  ${m.name.padEnd(30)} \x1b[33m${m.value.toLocaleString()}\x1b[0m`);
        }
    }

    const report = {
        timestamp: new Date().toISOString(),
        browser: 'Chromium (Playwright)',
        viewport: '1920x1080',
        results: rawResults,
        comparison: Object.keys(oldResults).map(key => ({
            benchmark: key,
            old: oldResults[key],
            new: newResults[key] || 0,
            speedup: newResults[key] ? (newResults[key]! / oldResults[key]!).toFixed(2) + 'x' : 'N/A',
        })),
        cdpMetrics: Object.fromEntries(perfMetrics.metrics.map(m => [m.name, m.value])),
        heapDelta: (jsHeapAfter - jsHeapBefore) / 1024 / 1024,
    };

    const reportPath = join(RESULTS_DIR, `insane-bench-${Date.now()}.json`);
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n\x1b[36m[*] Full report saved to: ${reportPath}\x1b[0m`);

    await browser.close();
    console.log('\x1b[32m[*] Done.\x1b[0m\n');
}

run().catch(e => { console.error(e); process.exit(1); });
