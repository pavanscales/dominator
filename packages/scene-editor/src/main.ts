/**
 * Scene Editor — Main Thread
 *
 * Architecture:
 *   Worker  → physics (500K particles) via SharedArrayBuffer
 *   Main    → DOM pool + render loop (reads shared memory, zero-copy)
 *   Signals → reactive UI overlay (FPS, mode, selection, stats)
 *
 * The hot path (500K style.transform writes per frame) bypasses
 * Dominator signals entirely for maximum throughput. Signals power
 * the cold-path UI elements that update at human-visible rates.
 */

import { signal, computed, effect, batch } from '@dominator/core';

// ── Constants ─────────────────────────────────────────────────────────────────

const PARTICLE_COUNT = 500_000;
const HEADER_SIZE = 64;
const FLOATS_PER = 8;
const FPS_RING_SIZE = 64;

// ── SharedArrayBuffer ─────────────────────────────────────────────────────────

if (typeof SharedArrayBuffer === 'undefined') {
    document.body.innerHTML =
        '<div style="color:#ff4444;font-family:monospace;padding:60px;text-align:center;">' +
        '<h1 style="font-size:28px;margin-bottom:16px;">SharedArrayBuffer Required</h1>' +
        '<p style="color:#888;font-size:14px;">This demo requires COOP/COEP headers.</p>' +
        '<p style="color:#666;font-size:12px;margin-top:8px;">Run with: <code style="color:#00f0ff;">pnpm dev</code></p>' +
        '</div>';
    throw new Error('SharedArrayBuffer not available — need COOP/COEP headers');
}

const totalFloats = HEADER_SIZE + PARTICLE_COUNT * FLOATS_PER;
const sharedBuffer = new SharedArrayBuffer(totalFloats * 4);
const header = new Int32Array(sharedBuffer, 0, HEADER_SIZE);
const particleData = new Float32Array(sharedBuffer, HEADER_SIZE * 4, PARTICLE_COUNT * FLOATS_PER);

// ── State ────────────────────────────────────────────────────────────────────

let currentMode = 0;
let mouseX = window.innerWidth * 0.5;
let mouseY = window.innerHeight * 0.5;
let lastTime = performance.now();
let frameCount = 0;
let fpsDisplay = 0;

// ── FPS ring buffer ──────────────────────────────────────────────────────────

const fpsRing = new Float64Array(FPS_RING_SIZE);
let fpsRingPos = 0;
let fpsRingLen = 0;

// ── Dominator Signals (reactive UI) ──────────────────────────────────────────

const fpsSignal = signal(0);
const modeSignal = signal(0);
const selectedId = signal(-1);
const selectedX = signal(0);
const selectedY = signal(0);

const MODES = ['CHAOS', 'FORM', 'SPIRAL', 'VORTEX'] as const;
const MODE_COLORS = ['#00ff88', '#00f0ff', '#c050ff', '#ff6030'] as const;

const modeLabel = computed(() => MODES[modeSignal()] ?? 'CHAOS');
const modeColor = computed(() => MODE_COLORS[modeSignal()] ?? '#00ff88');
const fpsColor = computed(() => {
    const f = fpsSignal();
    return f >= 58 ? '#00ff88' : f >= 45 ? '#eab308' : '#ff4444';
});

// ── Reactive DOM bindings ─────────────────────────────────────────────────────

effect(() => {
    const el = document.getElementById('po-fps');
    if (el) {
        el.textContent = String(fpsSignal());
        el.style.color = fpsColor();
    }
});

effect(() => {
    const el = document.getElementById('po-mode');
    if (el) {
        el.textContent = modeLabel();
        el.style.color = modeColor();
    }
});

effect(() => {
    const el = document.getElementById('sel-id');
    if (el) el.textContent = selectedId() >= 0 ? String(selectedId()) : '---';
});

effect(() => {
    const el = document.getElementById('sel-pos');
    if (el) el.textContent = selectedId() >= 0
        ? `${selectedX().toFixed(1)}, ${selectedY().toFixed(1)}`
        : '---';
});

// ── DOM Pool: pre-allocate 500K particles ────────────────────────────────────

const app = document.getElementById('app')!;
const fragment = document.createDocumentFragment();
const elements = new Array<HTMLElement>(PARTICLE_COUNT);

for (let i = 0; i < PARTICLE_COUNT; i++) {
    const el = document.createElement('div');
    el.className = 'p';
    elements[i] = el;
    fragment.appendChild(el);
}
app.appendChild(fragment);

// ── Overlay refs ─────────────────────────────────────────────────────────────

const poFps = document.getElementById('po-fps')!;
const poPhysics = document.getElementById('po-physics')!;
const poRender = document.getElementById('po-render')!;
const poTotal = document.getElementById('po-total')!;
const poCount = document.getElementById('po-count')!;
const poDom = document.getElementById('po-dom')!;
const hint = document.getElementById('hint')!;

poCount.textContent = PARTICLE_COUNT.toLocaleString();
poDom.textContent = document.querySelectorAll('*').length.toLocaleString();

// ── Mode buttons ─────────────────────────────────────────────────────────────

const modeButtons = document.querySelectorAll<HTMLElement>('[data-mode]');
function syncModeButtons(): void {
    modeButtons.forEach((btn) => {
        const m = parseInt(btn.dataset.mode || '0', 10);
        btn.classList.toggle('active', m === currentMode);
        btn.style.borderColor = m === currentMode ? MODE_COLORS[m] : 'rgba(255,255,255,0.1)';
        btn.style.color = m === currentMode ? MODE_COLORS[m] : '#666';
    });
}

modeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
        currentMode = parseInt(btn.dataset.mode || '0', 10);
        Atomics.store(header, 5, currentMode);
        batch(() => { modeSignal.set(currentMode); });
        syncModeButtons();
    });
});

// Auto-cycle modes
let modeTimer = setInterval(() => {
    currentMode = (currentMode + 1) % 4;
    Atomics.store(header, 5, currentMode);
    batch(() => { modeSignal.set(currentMode); });
    syncModeButtons();
}, 5000);

// ── Mouse tracking ───────────────────────────────────────────────────────────

window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    Atomics.store(header, 3, mouseX);
    Atomics.store(header, 4, mouseY);
    if (hint.style.opacity !== '0') hint.style.opacity = '0';
});

window.addEventListener('click', () => {
    worker.postMessage({ type: 'explode' });
});

// ── Resize ───────────────────────────────────────────────────────────────────

function updateSize(): void {
    Atomics.store(header, 7, window.innerWidth);
    Atomics.store(header, 8, window.innerHeight);
    worker.postMessage({ type: 'resize', width: window.innerWidth, height: window.innerHeight });
}
updateSize();
window.addEventListener('resize', updateSize);

// ── Start Worker ─────────────────────────────────────────────────────────────

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
worker.postMessage({
    type: 'init',
    count: PARTICLE_COUNT,
    buffer: sharedBuffer,
    width: window.innerWidth,
    height: window.innerHeight,
});

// ── Selection: nearest particle to mouse (every 100ms) ──────────────────────

setInterval(() => {
    let minDist = Infinity;
    let minIdx = -1;
    // Sample every 500th particle for speed
    for (let i = 0; i < PARTICLE_COUNT; i += 500) {
        const base = i * FLOATS_PER;
        const dx = mouseX - particleData[base];
        const dy = mouseY - particleData[base + 1];
        const d = dx * dx + dy * dy;
        if (d < minDist) {
            minDist = d;
            minIdx = i;
        }
    }
    if (minIdx >= 0) {
        batch(() => {
            selectedId.set(minIdx);
            selectedX.set(particleData[minIdx * FLOATS_PER]);
            selectedY.set(particleData[minIdx * FLOATS_PER + 1]);
        });
    }
}, 100);

// ── Render loop: reads SharedArrayBuffer, writes to DOM ─────────────────────

function renderLoop(): void {
    const frameStart = performance.now();
    const cmd = Atomics.load(header, 0);

    if (cmd === 1) {
        const t0 = performance.now();

        // Hot path: 500K direct DOM writes — no signals, no VDOM, no diff
        for (let i = 0; i < PARTICLE_COUNT; i++) {
            const base = i * FLOATS_PER;
            const el = elements[i]!;
            const x = particleData[base] | 0;
            const y = particleData[base + 1] | 0;
            const r = particleData[base + 2] | 0;
            const g = particleData[base + 3] | 0;
            const b = particleData[base + 4] | 0;
            const a = particleData[base + 5];

            el.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
            el.style.backgroundColor = 'rgba(' + r + ',' + g + ',' + b + ',' + a.toFixed(2) + ')';
        }

        const physicsTime = performance.now() - t0;
        Atomics.store(header, 0, 0);

        // FPS calculation
        frameCount++;
        const now = performance.now();
        const delta = now - lastTime;
        lastTime = now;

        fpsRing[fpsRingPos] = delta;
        fpsRingPos = (fpsRingPos + 1) & (FPS_RING_SIZE - 1);
        if (fpsRingLen < FPS_RING_SIZE) fpsRingLen++;

        if ((frameCount & 15) === 0) {
            let sum = 0;
            for (let i = 0; i < fpsRingLen; i++) sum += fpsRing[i];
            const avgDelta = sum / fpsRingLen;
            fpsDisplay = avgDelta > 0 ? Math.min(999, Math.round(1000 / avgDelta)) : 0;

            const totalTime = performance.now() - frameStart;
            const renderTime = totalTime - physicsTime;

            batch(() => {
                fpsSignal.set(fpsDisplay);
            });

            poPhysics.textContent = physicsTime.toFixed(1) + 'ms';
            poRender.textContent = renderTime.toFixed(1) + 'ms';
            poTotal.textContent = totalTime.toFixed(1) + 'ms';
        }
    }

    requestAnimationFrame(renderLoop);
}

requestAnimationFrame(renderLoop);
