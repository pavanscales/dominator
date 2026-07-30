/**
 * 100K Particles — Main Thread (CANVAS RENDERER)
 *
 * Architecture:
 * - Worker runs physics at 120Hz via SharedArrayBuffer
 * - Main thread reads positions from shared memory (zero-copy)
 * - Canvas 2D with ImageData for batch pixel rendering
 * - No DOM manipulation during animation loop
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
const ctx = canvas.getContext('2d', { alpha: false })!;
const dpr = Math.min(window.devicePixelRatio || 1, 2);

function resizeCanvas() {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    ctx.scale(dpr, dpr);
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

const offscreen = new OffscreenCanvas(4, 4);
const octx = offscreen.getContext('2d')!;
octx.fillStyle = '#fff';
octx.fillRect(0, 0, 4, 4);
const particleImg = offscreen.transferToImageBitmap();

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

const particleImgSize = 3;
const offscreenSmall = new OffscreenCanvas(particleImgSize, particleImgSize);
const octxSmall = offscreenSmall.getContext('2d')!;
octxSmall.fillStyle = '#fff';
octxSmall.fillRect(0, 0, particleImgSize, particleImgSize);
const particleSprite = offscreenSmall.transferToImageBitmap();

function renderLoop() {
    const frameStart = performance.now();

    const cmd = Atomics.load(header, 0);

    if (cmd === 1) {
        const physicsStart = performance.now();

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#0a0a0f';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const pixels = new Uint32Array(imageData.data.buffer);
        const w = canvas.width;
        const h = canvas.height;

        for (let i = 0; i < PARTICLE_COUNT; i++) {
            const base = i * FLOATS_PER;
            const x = particleData[base] | 0;
            const y = particleData[base + 1] | 0;
            const r = particleData[base + 2] | 0;
            const g = particleData[base + 3] | 0;
            const b = particleData[base + 4] | 0;

            const px = x - 1;
            const py = y - 1;
            if (px >= 0 && px < w && py >= 0 && py < h) {
                const idx = py * w + px;
                const color = (255 << 24) | (b << 16) | (g << 8) | r;
                pixels[idx] = color;
            }
        }

        ctx.putImageData(imageData, 0, 0);

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