const { chromium } = require('@playwright/test');

(async () => {
  console.log('Starting benchmark runner...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

  page.on('console', msg => {
    if (msg.type() === 'error') console.log('BROWSER ERR:', msg.text());
  });
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

  const htmlPath = 'C:/Users/jayad/domdom/dominator/bench/insane-bench.html';
  console.log('Loading:', htmlPath);
  await page.goto('file:///' + htmlPath, { timeout: 60000, waitUntil: 'domcontentloaded' });
  console.log('Page loaded. Title:', await page.title());

  // Wait for benchmarks to complete with long timeout
  console.log('Waiting for benchmarks (up to 5 min)...');
  try {
    // Poll for completion
    for (let i = 0; i < 300; i++) {
      await page.waitForTimeout(1000);
      const status = await page.textContent('#status').catch(() => '');
      if (status && status.indexOf('COMPLETE') >= 0) {
        console.log('Benchmarks complete at poll #' + (i+1));
        break;
      }
      if (i % 10 === 0) console.log('  Polling... (' + (i+1) + 's) Status: ' + status);
    }

    const rawResults = await page.evaluate(() => {
      const dataEl = document.getElementById('benchmark-data');
      if (dataEl && dataEl.textContent) return JSON.parse(dataEl.textContent);
      return [];
    });

    // Print results
    console.log('\n=== RESULTS ===');
    for (const r of rawResults) {
      console.log(`${r.name}: ${r.opsPerSec.toLocaleString()} ${r.engine === 'dom' ? 'ops/sec' : r.engine === 'pipeline' ? 'ops/sec' : r.engine === 'old' ? 'ops/sec' : 'FPS'}`);
    }

    // Check for comparison data
    const oldResults = rawResults.filter(r => r.engine === 'old');
    const newResults = rawResults.filter(r => r.engine === 'new');
    if (oldResults.length > 0 && newResults.length > 0) {
      console.log('\n=== OLD vs NEW ===');
      for (let i = 0; i < Math.min(oldResults.length, newResults.length); i++) {
        const oldR = oldResults[i];
        const newR = newResults[i];
        if (oldR && newR) {
          const speedup = (newR.opsPerSec / oldR.opsPerSec).toFixed(1);
          console.log(`${oldR.name.replace('_old', '')}: OLD=${oldR.opsPerSec.toLocaleString()} NEW=${newR.opsPerSec.toLocaleString()} SPEEDUP=${speedup}x`);
        }
      }
    }

  } catch (e) {
    console.log('Timeout/error waiting for benchmarks. Checking status...');
    const status = await page.textContent('#status');
    console.log('Status:', status);
  }

  await browser.close();
  console.log('Done.');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
