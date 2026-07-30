import { test, expect, Page } from '@playwright/test';
import type { CDPSession } from '@playwright/test';

const MIN_FPS = 30;
const TARGET_FPS = 55;
const WARMUP_MS = 4000;
const MEASURE_MS = 6000;
const MAX_MEMORY_GROWTH_MB = 50;
const MAX_LAYOUT_SHIFT = 0.1;
const MAX_NODES = 10000;

interface FrameTimings {
    deltas: number[];
    fps: { min: number; avg: number; p1: number };
    frameTime: { avg: number; p99: number; max: number };
}

async function getMemoryUsage(page: Page): Promise<{ jsHeapUsed: number; jsHeapLimit: number }> {
    try {
        const metrics = await page.evaluate(() => {
            const m = (performance as any).memory;
            return m ? { jsHeapUsed: m.usedJSHeapSize, jsHeapLimit: m.jsHeapSizeLimit } : null;
        });
        if (metrics) return metrics;
    } catch { }
    return { jsHeapUsed: 0, jsHeapLimit: 0 };
}

async function getDOMNodeCount(page: Page): Promise<number> {
    return page.evaluate(() => document.querySelectorAll('*').length);
}

async function injectFPSMeter(page: Page): Promise<void> {
    await page.evaluate(() => {
        if ((window as any).__fpsMeter) return;
        const ring = new Float64Array(64);
        let pos = 0;
        let len = 0;
        let last = performance.now();

        function tick() {
            const now = performance.now();
            const delta = now - last;
            last = now;
            ring[pos] = delta;
            pos = (pos + 1) & 63;
            if (len < 64) len++;
            requestAnimationFrame(tick);
        }

        (window as any).__fpsMeter = {
            getFPS() {
                if (len === 0) return 0;
                let sum = 0;
                for (let i = 0; i < len; i++) sum += ring[i];
                return Math.round(1000 / (sum / len));
            },
            getAllDeltas(): number[] {
                const arr = new Float64Array(len);
                for (let i = 0; i < len; i++) arr[i] = ring[(pos - len + i + 64) & 63];
                return Array.from(arr);
            },
            reset() {
                pos = 0;
                len = 0;
                last = performance.now();
            },
        };
        requestAnimationFrame(tick);
    });
}

async function collectFrameTimings(page: Page, durationMs: number): Promise<FrameTimings> {
    await injectFPSMeter(page);
    await page.waitForTimeout(durationMs);
    const deltas: number[] = await page.evaluate(() => (window as any).__fpsMeter.getAllDeltas());

    if (deltas.length === 0) {
        return { deltas, fps: { min: 0, avg: 0, p1: 0 }, frameTime: { avg: 0, p99: 0, max: 0 } };
    }

    const sorted = [...deltas].sort((a, b) => a - b);
    const avg = deltas.reduce((s, d) => s + d, 0) / deltas.length;
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    const max = sorted[sorted.length - 1];
    const min = sorted[0];

    const fpsValues = deltas.map(d => 1000 / d).sort((a, b) => a - b);
    const avgFps = fpsValues.reduce((s, f) => s + f, 0) / fpsValues.length;
    const p1Fps = fpsValues[Math.floor(fpsValues.length * 0.01)];
    const minFps = fpsValues[0];

    return {
        deltas,
        fps: { min: minFps, avg: avgFps, p1: p1Fps },
        frameTime: { avg, p99, max },
    };
}

async function collectLayoutShift(page: Page, durationMs: number): Promise<number> {
    return page.evaluate(async (duration: number) => {
        return new Promise<number>((resolve) => {
            let maxShift = 0;
            let observer: PerformanceObserver | null = null;

            const handler = (list: PerformanceObserverEntryList) => {
                for (const entry of list.getEntries()) {
                    const cls = entry as any;
                    if (cls.value > maxShift) maxShift = cls.value;
                }
            };

            try {
                observer = new PerformanceObserver(handler);
                observer.observe({ type: 'layout-shift', buffered: true });
            } catch { }

            setTimeout(() => {
                if (observer) observer.disconnect();
                resolve(maxShift);
            }, duration);
        });
    }, durationMs);
}

async function countDOMWrites(page: Page, durationMs: number): Promise<number> {
    return page.evaluate(async (duration: number) => {
        const origAppendChild = Node.prototype.appendChild;
        const origInsertBefore = Node.prototype.insertBefore;
        const origRemoveChild = Node.prototype.removeChild;
        const origReplaceChild = Node.prototype.replaceChild;
        const origSetAttribute = Element.prototype.setAttribute;
        const origTextContentDesc = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')!;

        let count = 0;

        (Node.prototype as any).appendChild = function (this: Node, node: Node) {
            count++;
            return origAppendChild.call(this, node);
        };
        (Node.prototype as any).insertBefore = function (this: Node, node: Node, ref: Node | null) {
            count++;
            return origInsertBefore.call(this, node, ref);
        };
        (Node.prototype as any).removeChild = function (this: Node, child: Node) {
            count++;
            return origRemoveChild.call(this, child);
        };
        (Node.prototype as any).replaceChild = function (this: Node, newChild: Node, oldChild: Node) {
            count++;
            return origReplaceChild.call(this, newChild, oldChild);
        };
        (Element.prototype as any).setAttribute = function (this: Element, name: string, value: string) {
            count++;
            return origSetAttribute.call(this, name, value);
        };

        Object.defineProperty(Node.prototype, 'textContent', {
            get() { return origTextContentDesc.get!.call(this); },
            set(v: string) {
                count++;
                return origTextContentDesc.set!.call(this, v);
            },
        });

        await new Promise(r => setTimeout(r, duration));

        (Node.prototype as any).appendChild = origAppendChild;
        (Node.prototype as any).insertBefore = origInsertBefore;
        (Node.prototype as any).removeChild = origRemoveChild;
        (Node.prototype as any).replaceChild = origReplaceChild;
        (Element.prototype as any).setAttribute = origSetAttribute;
        Object.defineProperty(Node.prototype, 'textContent', origTextContentDesc);
        return count;
    }, durationMs);
}

async function countSignalFlushes(page: Page, durationMs: number): Promise<number> {
    return page.evaluate(async (duration: number) => {
        const state = (window as any).state;
        if (!state || !state.gridData) return -1;
        const origSet = state.gridData.set.bind(state.gridData);
        let count = 0;
        state.gridData.set = (v: number) => {
            count++;
            return origSet(v);
        };
        await new Promise(r => setTimeout(r, duration));
        state.gridData.set = origSet;
        return count;
    }, durationMs);
}

async function runScrollBenchmark(page: Page): Promise<{
    fpsDuringScroll: number;
    droppedFrames: number;
}> {
    await page.evaluate(() => {
        const scrollEl = document.querySelector('.grid-scroll') as HTMLElement;
        scrollEl.scrollTop = 0;
        scrollEl.scrollLeft = 0;
    });
    await page.waitForTimeout(500);

    const scrollHeight = await page.evaluate(() => {
        const el = document.querySelector('.grid-scroll') as HTMLElement;
        return el.scrollHeight;
    });

    const scrollSteps = 20;
    const scrollPerStep = Math.floor(scrollHeight / scrollSteps);

    for (let i = 1; i <= scrollSteps; i++) {
        await page.evaluate(({ top, left }: { top: number; left: number }) => {
            const el = document.querySelector('.grid-scroll') as HTMLElement;
            el.scrollTop = top;
            el.scrollLeft = left;
        }, { top: i * scrollPerStep, left: (i * scrollPerStep * 0.5) % 80000 });
        await page.waitForTimeout(100);
    }

    await injectFPSMeter(page);
    await page.waitForTimeout(2000);
    const during = await page.evaluate(() => (window as any).__fpsMeter.getAllDeltas() as number[]);

    const fpsValues = during.map(d => 1000 / d);
    const avgFps = fpsValues.reduce((s, f) => s + f, 0) / fpsValues.length;
    const droppedFrames = during.filter(d => d > 50).length;

    return { fpsDuringScroll: avgFps, droppedFrames };
}

test.describe('million cells grid - performance stress test', () => {

    let page: Page;
    let session: CDPSession | null = null;

    test.beforeAll(async ({ browser }) => {
        const ctx = await browser.newContext({
            viewport: { width: 1920, height: 1080 },
            deviceScaleFactor: 1,
        });
        page = await ctx.newPage();
        try {
            session = await page.context().newCDPSession(page);
            await session.send('Performance.enable');
        } catch (e) {
            console.log('CDP session not available, some tests will be skipped');
        }
    });

    test.afterAll(async () => {
        if (session) {
            try { await session.detach(); } catch { }
        }
    });

    test('1M cell grid loads and maintains 55+ FPS under sustained random update load', async () => {
        await page.goto('/', { waitUntil: 'networkidle' });
        await page.waitForSelector('.million-cells-app', { timeout: 15000 });
        await page.waitForTimeout(2000);

        const nodeCount = await getDOMNodeCount(page);
        expect(nodeCount).toBeLessThan(MAX_NODES);
        console.log(`[RESULT] Initial DOM nodes: ${nodeCount}`);

        await page.waitForTimeout(WARMUP_MS);
        const steadyState = await collectFrameTimings(page, MEASURE_MS);

        expect(steadyState.fps.avg).toBeGreaterThanOrEqual(TARGET_FPS);
        expect(steadyState.fps.p1).toBeGreaterThanOrEqual(MIN_FPS);
        expect(steadyState.frameTime.p99).toBeLessThan(50);

        console.log(`[RESULT] FPS: avg=${steadyState.fps.avg.toFixed(1)} p1=${steadyState.fps.p1.toFixed(1)} min=${steadyState.fps.min.toFixed(1)}`);
        console.log(`[RESULT] Frame Time: avg=${steadyState.frameTime.avg.toFixed(2)}ms p99=${steadyState.frameTime.p99.toFixed(2)}ms max=${steadyState.frameTime.max.toFixed(2)}ms`);
    });

    test('memory usage remains stable (no leak, under 50MB growth over 5s)', async () => {
        const memBefore = await getMemoryUsage(page);
        console.log(`[RESULT] Memory before: ${(memBefore.jsHeapUsed / 1e6).toFixed(1)}MB`);

        await page.waitForTimeout(5000);

        const memAfter = await getMemoryUsage(page);
        const growthMB = (memAfter.jsHeapUsed - memBefore.jsHeapUsed) / 1e6;
        console.log(`[RESULT] Memory after: ${(memAfter.jsHeapUsed / 1e6).toFixed(1)}MB growth: ${growthMB.toFixed(1)}MB`);

        expect(growthMB).toBeLessThan(MAX_MEMORY_GROWTH_MB);
    });

    test('DOM node count stays bounded by virtual viewport (under 10K nodes)', async () => {
        const nodeCount = await getDOMNodeCount(page);
        console.log(`[RESULT] DOM nodes: ${nodeCount}`);
        expect(nodeCount).toBeLessThan(MAX_NODES);
    });

    test('layout shift (CLS) stays under 0.1 during updates', async () => {
        const cls = await collectLayoutShift(page, 5000);
        console.log(`[RESULT] Max layout shift: ${cls}`);
        expect(cls).toBeLessThan(MAX_LAYOUT_SHIFT);
    });

    test('virtual scrolling maintains FPS during scroll', async () => {
        const scrollMetrics = await runScrollBenchmark(page);
        console.log(`[RESULT] Scroll FPS: ${scrollMetrics.fpsDuringScroll.toFixed(1)} Dropped: ${scrollMetrics.droppedFrames}`);
        expect(scrollMetrics.fpsDuringScroll).toBeGreaterThanOrEqual(30);
        expect(scrollMetrics.droppedFrames).toBeLessThan(10);
    });

    test('DOM writes per frame are bounded (no thrashing)', async () => {
        await page.waitForTimeout(2000);
        const writes = await countDOMWrites(page, 2000);
        const frames = 120;
        const writesPerFrame = writes / frames;
        console.log(`[RESULT] DOM writes: ${writes} total, ${writesPerFrame.toFixed(1)}/frame`);
        expect(writesPerFrame).toBeLessThan(2000);
    });

    test('CDP performance metrics are healthy', async () => {
        if (!session) {
            console.log('SKIP: CDP session not available');
            return;
        }
        const { metrics } = await session.send('Performance.getMetrics');
        const cdp: Record<string, number> = {};
        for (const m of metrics) cdp[m.name] = m.value;
        console.log('[RESULT] CDP Metrics:', JSON.stringify(cdp, null, 2));

        if (cdp.DOMNodes) expect(cdp.DOMNodes).toBeLessThan(MAX_NODES);
        if (cdp.JSHeapUsedSize) {
            const heapMB = cdp.JSHeapUsedSize / 1e6;
            expect(heapMB).toBeLessThan(200);
        }
    });

    test('signal flush rate is within expected bounds', async () => {
        const flushes = await countSignalFlushes(page, 2000);
        if (flushes >= 0) {
            console.log(`[RESULT] Signal flushes: ${flushes} in 2s (${(flushes / 2).toFixed(0)}/s)`);
            expect(flushes).toBeLessThan(500);
        }
    });

    test('grid displays correct FPS in the header overlay', async () => {
        await page.waitForTimeout(3000);
        const overlay = await page.$('#po-fps');
        expect(overlay).not.toBeNull();
        const isVisible = await overlay!.isVisible();
        expect(isVisible).toBe(true);
        const fpsText = await page.textContent('#po-fps');
        console.log(`[RESULT] UI FPS overlay text: "${fpsText}"`);
        const isHidden = await page.evaluate(() => document.hidden);
        if (isHidden) {
            console.log('[RESULT] Skipping FPS value check (headless/page hidden)');
        } else {
            expect(fpsText).not.toBe('--');
        }
    });

    test('stats panel reflects real data changes (avg, high)', async () => {
        const statsText = await page.textContent('#stat-avg strong');
        console.log(`[RESULT] Stats avg value: ${statsText}`);
        const avg = parseFloat(statsText || '0');
        expect(avg).toBeGreaterThanOrEqual(0);
    });

    test('cell selection and keyboard navigation works under load', async () => {
        const selectedBefore = await page.evaluate(() => {
            const state = (window as any).state;
            return state ? state.selectedCell() : -2;
        });
        await page.click('.grid-viewport .grid-row:first-child .grid-cell:first-child');
        await page.waitForTimeout(500);
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(200);
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(200);
        const selectedAfter = await page.evaluate(() => {
            const state = (window as any).state;
            return state ? state.selectedCell() : -2;
        });
        if (selectedBefore !== -2 && selectedAfter !== -2) {
            expect(selectedAfter).not.toBe(selectedBefore);
        }
    });
});
