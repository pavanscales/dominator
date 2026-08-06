/**
 * 100K Particles — Main Thread (CANVAS RENDERER) — HIGH PERF
 *
 * Architecture:
 * - Worker runs physics at 120Hz via SharedArrayBuffer (WASM SIMD)
 * - Main thread reads positions from shared memory (zero-copy)
 * - Canvas 2D ImageData with single putImageData (GPU upload once)
 * - Optimized loop with local variables, no bounds checks in hot path
 *
 * Expected: 60+ FPS locked, < 1ms render time
 */

const PARTICLE_COUNT = 100_000;
const HEADER_SIZE = 64;
const FLOATS_PER = 8;

const totalFloats = HEADER_SIZE + PARTICLE_COUNT * FLOATS_PER;
const sharedBuffer = new SharedArrayBuffer(totalFloats * 4);
const header = new Int32Array(sharedBuffer, 0, HEADER_SIZE);
const particleData = new Float32Array(sharedBuffer, HEADER_SIZE * 4, PARTICLE_COUNT * FLOATS_PER);

let mode = 0;
let mouseX = window.innerWidth / 2;
let mouseY = window.innerHeight / 2;
let tick = 0;
let lastTime = performance.now();
let frameCount = 0;
let fpsDisplay = 0;

const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })!;
const dpr = Math.min(window.devicePixelRatio || 1, 2);

function resizeCanvas() {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    Atomics.store(header, 7, window.innerWidth);
    Atomics.store(header, 8, window.innerHeight);
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

const app = document.getElementById('app')!;
app.style.position = 'relative';
app.style.width = '100vw';
app.style.height = '100vh';
app.appendChild(canvas);

// Reusable ImageData and pixel buffer - allocated once
let imageData: ImageData | null = null;
let pixels: Uint32Array | null = null;
let canvasW = 0;
let canvasH = 0;

function ensureImageData(w: number, h: number) {
    if (imageData && canvasW === w && canvasH === h) return;
    canvasW = w;
    canvasH = h;
    imageData = ctx.createImageData(w, h);
    pixels = new Uint32Array(imageData.data.buffer);
}

const FPS_RING = 32;
const fpsRing = new Float64Array(FPS_RING);
let fpsRingPos = 0;
let fpsRingLen = 0;

const poFps = document.getElementById('po-fps')!;
const poPhysics = document.getElementById('po-physics')!;
const poRender = document.getElementById('po-render')!;
const poTotal = document.getElementById('po-total')!;
const poCount = document.getElementById('po-count')!;
const poDom = document.getElementById('po-dom')!;
const poMode = document.getElementById('po-mode')!;
const hint = document.getElementById('hint')!;

poCount.textContent = String(PARTICLE_COUNT);
poDom.textContent = '1';

setInterval(() => {
    mode = mode === 0 ? 1 : 0;
    Atomics.store(header, 5, mode);
    poMode.textContent = mode === 0 ? 'CHAOS' : 'FORM';
    poMode.style.color = mode === 0 ? '#00ff88' : '#00f0ff';
}, 4000);

window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    Atomics.store(header, 3, mouseX);
    Atomics.store(header, 4, mouseY);
    if (hint.style.opacity !== '0') {
        hint.style.opacity = '0';
    }
});

window.addEventListener('click', () => {
    worker.postMessage({ type: 'explode' });
});

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

worker.postMessage({
    type: 'init',
    count: PARTICLE_COUNT,
    buffer: sharedBuffer,
    width: window.innerWidth,
    height: window.innerHeight,
});

// Pre-compute color lookup for 256 hues (faster than sin/cos per particle)
const COLOR_LUT = new Uint32Array(360);
for (let h = 0; h < 360; h++) {
    const rad = h * Math.PI / 180;
    const r = (Math.sin(rad) * 127 + 128) | 0;
    const g = (Math.sin(rad + 2.094) * 127 + 128) | 0;
    const b = (Math.sin(rad + 4.188) * 127 + 128) | 0;
    COLOR_LUT[h] = (255 << 24) | (b << 16) | (g << 8) | r;
}

// Pre-compute base hues for all particles
const baseHues = new Uint16Array(PARTICLE_COUNT);
for (let i = 0; i < PARTICLE_COUNT; i++) {
    baseHues[i] = (i * 137) % 360; // golden angle for distribution
}

function renderLoop() {
    const frameStart = performance.now();

    const cmd = Atomics.load(header, 0);

    if (cmd === 1) {
        const physicsStart = performance.now();

        const w = window.innerWidth;
        const h = window.innerHeight;
        ensureImageData(w, h);

        // Fast clear - fill with background color
        const bgColor = 0xFF0A0A0F; // #0a0a0f in ABGR
        pixels!.fill(bgColor);

        // Hot loop - optimized for V8:
        // - Local variables hoisted
        // - No function calls
        // - Uint32Array direct write
        // - Bounds check minimized
        const pd = particleData;
        const pxData = pixels!;
        const hues = baseHues;
        const stride = FLOATS_PER;
        const width = w;
        const height = h;
        const maxIdx = width * height;

        // Unrolled 4x for ILP
        let i = 0;
        const unrollEnd = PARTICLE_COUNT - 3;
        for (; i < unrollEnd; i += 4) {
            // Particle 0
            let base = i * stride;
            let x = pd[base] | 0;
            let y = pd[base + 1] | 0;
            if (x >= 0 && x < width && y >= 0 && y < height) {
                pxData[y * width + x] = COLOR_LUT[hues[i]];
            }

            // Particle 1
            base = (i + 1) * stride;
            x = pd[base] | 0;
            y = pd[base + 1] | 0;
            if (x >= 0 && x < width && y >= 0 && y < height) {
                pxData[y * width + x] = COLOR_LUT[hues[i + 1]];
            }

            // Particle 2
            base = (i + 2) * stride;
            x = pd[base] | 0;
            y = pd[base + 1] | 0;
            if (x >= 0 && x < width && y >= 0 && y < height) {
                pxData[y * width + x] = COLOR_LUT[hues[i + 2]];
            }

            // Particle 3
            base = (i + 3) * stride;
            x = pd[base] | 0;
            y = pd[base + 1] | 0;
            if (x >= 0 && x < width && y >= 0 && y < height) {
                pxData[y * width + x] = COLOR_LUT[hues[i + 3]];
            }
        }
        // Tail
        for (; i < PARTICLE_COUNT; i++) {
            const base = i * stride;
            const x = pd[base] | 0;
            const y = pd[base + 1] | 0;
            if (x >= 0 && x < width && y >= 0 && y < height) {
                pxData[y * width + x] = COLOR_LUT[hues[i]];
            }
        }

        ctx.putImageData(imageData!, 0, 0);

        const physicsTime = performance.now() - physicsStart;

        Atomics.store(header, 0, 0);

        frameCount++;
        const now = performance.now();
        const delta = now - lastTime;
        lastTime = now;

        fpsRing[fpsRingPos] = delta;
        fpsRingPos = (fpsRingPos + 1) & (FPS_RING - 1);
        if (fpsRingLen < FPS_RING) fpsRingLen++;

        if ((frameCount & 15) === 0) {
            let sum = 0;
            for (let i = 0; i < fpsRingLen; i++) sum += fpsRing[i];
            const avgDelta = sum / fpsRingLen;
            fpsDisplay = avgDelta > 0 ? Math.min(999, Math.round(1000 / avgDelta)) : 0;

            const totalTime = (performance.now() - frameStart).toFixed(1);
            const renderTime = (performance.now() - frameStart - physicsTime).toFixed(1);

            poFps.textContent = String(fpsDisplay);
            poFps.className = 'perf-mono' + (fpsDisplay >= 55 ? '' : fpsDisplay >= 45 ? ' warn' : ' bad');
            poPhysics.textContent = physicsTime.toFixed(1) + 'ms';
            poRender.textContent = renderTime + 'ms';
            poTotal.textContent = totalTime + 'ms';
        }
    }

    requestAnimationFrame(renderLoop);
}

requestAnimationFrame(renderLoop);