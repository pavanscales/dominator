import { chromium } from '@playwright/test';
import { writeFileSync } from 'fs';
import { join } from 'path';

const RESULTS_DIR = join(import.meta.dirname!, 'results');
const HTML_PATH = join(import.meta.dirname!, 'index.html');

interface BenchResult {
  name: string;
  ops: number;
  elapsed: number;
  opsPerSec: number;
}

async function run() {
  console.log('\n\x1b[31m═══════════════════════════════════════════════════════════════\x1b[0m');
  console.log('\x1b[31m  DOMINATOR DOD BENCHMARK SUITE — Real Browser (Chromium CDP)\x1b[0m');
  console.log('\x1b[31m═══════════════════════════════════════════════════════════════\x1b[0m\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  });
  const page = await context.newPage();

  const cdpSession = await context.newCDPSession(page);
  await cdpSession.send('Performance.enable');
  await cdpSession.send('Tracing.start', { categories: 'devtools.timeline,blink.user_timing,rail,loading' });

  const memBefore = await cdpSession.send('Performance.getMetrics');
  const jsHeapBefore = memBefore.metrics.find(m => m.name === 'JSHeapUsedSize')?.value || 0;

  console.log('\x1b[36m[*] Loading benchmark page...\x1b[0m');
  await page.goto(`file:///${HTML_PATH.replace(/\\/g, '/')}`);
  console.log('\x1b[36m[*] Waiting for benchmarks to complete...\x1b[0m');

  await page.waitForFunction(() => {
    const el = document.getElementById('benchmark-data');
    return el && el.getAttribute('data-done') === 'true';
  }, { timeout: 120000 });

  const rawResults = await page.evaluate(() => {
    return JSON.parse(document.getElementById('benchmark-data')!.textContent!);
  }) as BenchResult[];

  const memAfter = await cdpSession.send('Performance.getMetrics');
  const jsHeapAfter = memAfter.metrics.find(m => m.name === 'JSHeapUsedSize')?.value || 0;
  const domNodes = memAfter.metrics.find(m => m.name === 'Nodes')?.value || 0;
  const jsEventListeners = memAfter.metrics.find(m => m.name === 'JSEventListeners')?.value || 0;

  await cdpSession.send('Tracing.end');
  const traceBuffer: Buffer[] = [];
  cdpSession.on('Tracing.dataCollected', (data) => { traceBuffer.push(Buffer.from(JSON.stringify(data))); });
  await new Promise<void>(r => cdpSession.once('Tracing.tracingComplete', () => r()));

  const perfMetrics = await cdpSession.send('Performance.getMetrics');

  console.log('\n\x1b[32m╔═══════════════════════════════════════════════════════════════╗\x1b[0m');
  console.log('\x1b[32m║                   BENCHMARK RESULTS                          ║\x1b[0m');
  console.log('\x1b[32m╚═══════════════════════════════════════════════════════════════╝\x1b[0m\n');

  let currentSection = '';
  for (const r of rawResults) {
    const section = r.name.includes('signal') || r.name.includes('effect') || r.name.includes('batch') || r.name.includes('computed')
      ? (r.name.includes('signal') ? 'SIGNAL' : r.name.includes('effect') ? 'EFFECT' : r.name.includes('computed') ? 'COMPUTED' : 'BATCH')
      : r.name.includes('dom') ? 'DOM' : r.name.includes('full_pipeline') ? 'PIPELINE' : r.name.includes('particle') ? 'PARTICLE' : 'OTHER';

    if (section !== currentSection) {
      currentSection = section;
      console.log(`\x1b[33m─── ${section} ───\x1b[0m`);
    }

    const opsStr = r.name.includes('FPS') || r.name.includes('frames')
      ? `\x1b[32m${r.opsPerSec.toLocaleString()} FPS\x1b[0m`
      : `\x1b[32m${r.opsPerSec.toLocaleString()} ops/sec\x1b[0m`;

    const pad = Math.max(0, 60 - r.name.length);
    console.log(`  ${r.name} ${' '.repeat(pad)} ${opsStr}`);
  }

  console.log(`\n\x1b[36m─── BROWSER METRICS (CDP) ───\x1b[0m`);
  console.log(`  DOM Nodes:              \x1b[33m${domNodes.toLocaleString()}\x1b[0m`);
  console.log(`  JS Event Listeners:     \x1b[33m${jsEventListeners.toLocaleString()}\x1b[0m`);
  console.log(`  JS Heap Before:         \x1b[33m${(jsHeapBefore / 1024 / 1024).toFixed(2)} MB\x1b[0m`);
  console.log(`  JS Heap After:          \x1b[33m${(jsHeapAfter / 1024 / 1024).toFixed(2)} MB\x1b[0m`);
  console.log(`  Heap Delta:             \x1b[33m${((jsHeapAfter - jsHeapBefore) / 1024 / 1024).toFixed(2)} MB\x1b[0m`);

  console.log(`\n\x1b[36m─── CDP PERFORMANCE METRICS ───\x1b[0m`);
  for (const m of perfMetrics.metrics) {
    if (typeof m.value === 'number' && m.value > 0) {
      console.log(`  ${m.name.padEnd(30)} \x1b[33m${typeof m.value === 'number' ? m.value.toLocaleString() : m.value}\x1b[0m`);
    }
  }

  const report = {
    timestamp: new Date().toISOString(),
    browser: 'Chromium (Playwright)',
    viewport: '1920x1080',
    results: rawResults,
    cdpMetrics: Object.fromEntries(perfMetrics.metrics.map(m => [m.name, m.value])),
    heapDelta: (jsHeapAfter - jsHeapBefore) / 1024 / 1024,
  };

  const reportPath = join(RESULTS_DIR, `benchmark-${Date.now()}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n\x1b[36m[*] Full report saved to: ${reportPath}\x1b[0m`);

  await browser.close();
  console.log('\x1b[32m[*] Done.\x1b[0m\n');
}

run().catch(e => { console.error(e); process.exit(1); });
