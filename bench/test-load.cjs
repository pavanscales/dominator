const { chromium } = require('playwright');

(async () => {
  console.log('Starting...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', msg => console.log('BROWSER:', msg.text()));
  page.on('pageerror', err => console.log('PAGE_ERR:', err.message));
  
  const p = 'C:/Users/jayad/domdom/dominator/bench/insane-bench.html';
  console.log('Loading', p);
  await page.goto('file:///' + p, { timeout: 60000 });
  console.log('Title:', await page.title());
  
  await page.waitForTimeout(8000);
  const status = await page.textContent('#status');
  console.log('Status after 8s:', status);
  
  await browser.close();
  console.log('Done');
})().catch(e => { console.error(e.message); process.exit(1); });
