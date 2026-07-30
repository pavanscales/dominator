const { chromium } = require('@playwright/test');
const { spawn } = require('child_process');
const { writeFileSync, mkdirSync } = require('fs');
const path = require('path');

const RESULTS_DIR = path.join(__dirname, 'results');
const SERVER_SCRIPT = path.join(__dirname, 'server-coop-coep.mjs');
const WARMUP_SEC = 15;
const BENCH_SEC = 20;

mkdirSync(RESULTS_DIR, { recursive: true });

async function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, PORT: '9234' },
    });
    let started = false;
    child.stdout.on('data', (d) => {
      const s = d.toString();
      process.stdout.write(s);
      if (!started && s.includes('Listening')) {
        started = true;
        resolve(child);
      }
    });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!started) reject(new Error(`Server exited with code ${code}`));
    });
    setTimeout(() => {
      if (!started) reject(new Error('Server startup timeout'));
    }, 10000);
  });
}

async function run() {
  console.log('\n\x1b[31m╔═══════════════════════════════════════════════════════════════════╗\x1b[0m');
  console.log('\x1b[31m║  100K PARTICLE BENCHMARK — WebWorker + SharedArrayBuffer (CDP)   ║\x1b[0m');
  console.log('\x1b[31m╚═══════════════════════════════════════════════════════════════════╝\x1b[0m\n');

  const server = await startServer();

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
    });
    const page = await context.newPage();

    const cdpSession = await context.newCDPSession(page);
    await cdpSession.send('Performance.enable');

    // Capture baseline
    const memBefore = await cdpSession.send('Performance.getMetrics');
    const jsHeapBefore = memBefore.metrics.find(m => m.name === 'JSHeapUsedSize')?.value || 0;

    console.log(`\x1b[36m[*] Loading particle benchmark (COOP/COEP server)...\x1b[0m`);
    await page.goto('http://127.0.0.1:9234/', { waitUntil: 'domcontentloaded', timeout: 15000 });

    console.log(`\x1b[36m[*] Warming up for ${WARMUP_SEC}s...\x1b[0m`);
    await page.waitForTimeout(WARMUP_SEC * 1000);

    console.log(`\x1b[36m[*] Collecting metrics for ${BENCH_SEC}s...\x1b[0m`);

    // Sample FPS and frame times during bench window
    const samples = [];
    const sampleInterval = 500; // ms
    const totalSamples = Math.floor((BENCH_SEC * 1000) / sampleInterval);

    for (let i = 0; i < totalSamples; i++) {
      const snapshot = await page.evaluate(() => {
        const b = window.__bench;
        if (!b) return null;
        return {
          fps: b.getFps(),
          minFps: b.getMinFps(),
          frameCount: b.getFrameCount(),
          avgFrame: b.getAvgFrame(),
          avgPhys: b.getAvgPhys(),
        };
      });
      if (snapshot) samples.push(snapshot);
      await page.waitForTimeout(sampleInterval);
    }

    // Capture final CDP metrics
    const memAfter = await cdpSession.send('Performance.getMetrics');
    const jsHeapAfter = memAfter.metrics.find(m => m.name === 'JSHeapUsedSize')?.value || 0;
    const domNodes = memAfter.metrics.find(m => m.name === 'Nodes')?.value || 0;
    const jsEventListeners = memAfter.metrics.find(m => m.name === 'JSEventListeners')?.value || 0;

    // Compute stats
    const fpsValues = samples.map(s => s.fps).filter(f => f > 0);
    const avgFps = fpsValues.length ? Math.round(fpsValues.reduce((a, b) => a + b, 0) / fpsValues.length) : 0;
    const minFps = fpsValues.length ? Math.min(...fpsValues) : 0;
    const sortedFps = [...fpsValues].sort((a, b) => a - b);
    const p95Idx = Math.floor(sortedFps.length * 0.05);
    const p95Fps = sortedFps[p95Idx] || 0;
    const maxFps = fpsValues.length ? Math.max(...fpsValues) : 0;

    const avgFrameMs = samples.length ? (samples.reduce((a, s) => a + parseFloat(s.avgFrame), 0) / samples.length).toFixed(2) : '0';
    const avgPhysMs = samples.length ? (samples.reduce((a, s) => a + parseFloat(s.avgPhys), 0) / samples.length).toFixed(2) : '0';
    const lastFrameCount = samples.length ? samples[samples.length - 1].frameCount : 0;

    // Print results
    console.log('\n\x1b[32m╔═══════════════════════════════════════════════════════════════════╗\x1b[0m');
    console.log('\x1b[32m║                 100K PARTICLE BENCHMARK RESULTS                 ║\x1b[0m');
    console.log('\x1b[32m╚═══════════════════════════════════════════════════════════════════╝\x1b[0m\n');

    console.log(`  \x1b[33mParticles:            \x1b[32m100,000\x1b[0m`);
    console.log(`  \x1b[33mWarmup:               \x1b[32m${WARMUP_SEC}s\x1b[0m`);
    console.log(`  \x1b[33mCollection:           \x1b[32m${BENCH_SEC}s\x1b[0m`);
    console.log(`  \x1b[33mTotal frames:         \x1b[32m${lastFrameCount.toLocaleString()}\x1b[0m`);

    console.log(`\n  \x1b[36m─── FPS ───\x1b[0m`);
    const fpsColor = avgFps >= 55 ? '\x1b[32m' : avgFps >= 45 ? '\x1b[33m' : '\x1b[31m';
    console.log(`  ${fpsColor}Average:             ${avgFps} FPS\x1b[0m`);
    console.log(`  ${fpsColor}Min:                  ${minFps} FPS\x1b[0m`);
    console.log(`  \x1b[32mMax:                  ${maxFps} FPS\x1b[0m`);
    console.log(`  \x1b[32mP95 (worst 5%):       ${p95Fps} FPS\x1b[0m`);

    console.log(`\n  \x1b[36m─── TIMING ───\x1b[0m`);
    console.log(`  \x1b[33mAvg frame time:       ${avgFrameMs}ms\x1b[0m`);
    console.log(`  \x1b[33mAvg physics time:     ${avgPhysMs}ms\x1b[0m`);

    console.log(`\n  \x1b[36m─── BROWSER METRICS (CDP) ───\x1b[0m`);
    console.log(`  DOM Nodes:            \x1b[33m${domNodes.toLocaleString()}\x1b[0m`);
    console.log(`  JS Event Listeners:   \x1b[33m${jsEventListeners.toLocaleString()}\x1b[0m`);
    console.log(`  JS Heap Before:       \x1b[33m${(jsHeapBefore / 1048576).toFixed(2)} MB\x1b[0m`);
    console.log(`  JS Heap After:        \x1b[33m${(jsHeapAfter / 1048576).toFixed(2)} MB\x1b[0m`);
    console.log(`  Heap Delta:           \x1b[33m${((jsHeapAfter - jsHeapBefore) / 1048576).toFixed(2)} MB\x1b[0m`);

    console.log(`\n  \x1b[36m─── CDP PERFORMANCE METRICS ───\x1b[0m`);
    const perfMetrics = await cdpSession.send('Performance.getMetrics');
    for (const m of perfMetrics.metrics) {
      if (typeof m.value === 'number' && m.value > 0) {
        console.log(`  ${m.name.padEnd(30)} \x1b[33m${m.value.toLocaleString()}\x1b[0m`);
      }
    }

    // Save report
    const report = {
      timestamp: new Date().toISOString(),
      browser: 'Chromium (Playwright)',
      viewport: '1920x1080',
      particles: 100000,
      warmupSec: WARMUP_SEC,
      benchSec: BENCH_SEC,
      fps: { avg: avgFps, min: minFps, max: maxFps, p95: p95Fps, samples: fpsValues },
      timing: { avgFrameMs: parseFloat(avgFrameMs), avgPhysMs: parseFloat(avgPhysMs) },
      totalFrames: lastFrameCount,
      cdpMetrics: Object.fromEntries(perfMetrics.metrics.map(m => [m.name, m.value])),
      heapDelta: (jsHeapAfter - jsHeapBefore) / 1048576,
      heapBefore: jsHeapBefore / 1048576,
      heapAfter: jsHeapAfter / 1048576,
    };

    const reportPath = path.join(RESULTS_DIR, `particles-100k-${Date.now()}.json`);
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n\x1b[36m[*] Full report saved to: ${reportPath}\x1b[0m`);

  } finally {
    if (browser) await browser.close();
    server.kill();
  }

  console.log('\x1b[32m[*] Done.\x1b[0m\n');
}

run().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
