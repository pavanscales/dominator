/**
 * Worker: 500K Particle Physics Engine
 *
 * Runs entirely in Web Worker thread.
 * Communicates with main thread via SharedArrayBuffer — zero postMessage.
 * 
 * 4 physics modes:
 *   0 = CHAOS   — Brownian motion + mouse repulsion + screen wrap
 *   1 = FORM    — Magnetic snap to grid positions
 *   2 = SPIRAL  — Orbital motion around viewport center
 *   3 = VORTEX  — Swirl around mouse cursor
 */

const FLOATS_PER = 8;
const HEADER_SIZE = 64;

let _px!: Float32Array;
let _py!: Float32Array;
let _vx!: Float32Array;
let _vy!: Float32Array;
let _tx: Float32Array | null = null;
let _ty: Float32Array | null = null;
let _count = 0;
let _sharedData!: Float32Array;
let _sharedHeader!: Int32Array;
let _running = false;
let _rafId = 0;
let _width = 1920;
let _height = 1080;
let _mouseX = 960;
let _mouseY = 540;
let _mode = 0;
let _tick = 0;

// xorshift32 PRNG — deterministic, fast, no Math.random
let _rng = 123456789;
function xor(): number {
    _rng ^= _rng << 13;
    _rng ^= _rng >> 17;
    _rng ^= _rng << 5;
    return (_rng >>> 0) / 4294967296;
}

function generateGridTargets(): void {
    const side = Math.ceil(Math.sqrt(_count));
    const cellW = _width / (side + 1);
    const cellH = _height / (side + 1);
    _tx = new Float32Array(_count);
    _ty = new Float32Array(_count);
    for (let i = 0; i < _count; i++) {
        _tx[i] = (i % side + 1) * cellW;
        _ty[i] = (Math.floor(i / side) + 1) * cellH;
    }
}

self.onmessage = (e: MessageEvent) => {
    const msg = e.data;
    switch (msg.type) {
        case 'init': {
            _count = msg.count;
            const buf = msg.buffer as SharedArrayBuffer;
            _sharedHeader = new Int32Array(buf, 0, HEADER_SIZE);
            _sharedData = new Float32Array(buf, HEADER_SIZE * 4, _count * FLOATS_PER);

            _px = new Float32Array(_count);
            _py = new Float32Array(_count);
            _vx = new Float32Array(_count);
            _vy = new Float32Array(_count);

            _width = msg.width || 1920;
            _height = msg.height || 1080;

            for (let i = 0; i < _count; i++) {
                _px[i] = xor() * _width;
                _py[i] = xor() * _height;
                _vx[i] = (xor() - 0.5) * 5;
                _vy[i] = (xor() - 0.5) * 5;
            }

            generateGridTargets();

            _running = true;
            _loop();
            break;
        }
        case 'explode': {
            for (let i = 0; i < _count; i++) {
                _vx[i] = (xor() - 0.5) * 80;
                _vy[i] = (xor() - 0.5) * 80;
            }
            break;
        }
        case 'resize': {
            _width = msg.width;
            _height = msg.height;
            generateGridTargets();
            break;
        }
        case 'shutdown': {
            _running = false;
            if (_rafId) cancelAnimationFrame(_rafId);
            break;
        }
    }
};

function _loop(): void {
    if (!_running) return;

    _mouseX = Atomics.load(_sharedHeader, 3);
    _mouseY = Atomics.load(_sharedHeader, 4);
    _mode = Atomics.load(_sharedHeader, 5);
    _width = Atomics.load(_sharedHeader, 7) || _width;
    _height = Atomics.load(_sharedHeader, 8) || _height;

    _tick++;

    const cx = _width * 0.5;
    const cy = _height * 0.5;

    for (let i = 0; i < _count; i++) {
        let x = _px[i];
        let y = _py[i];
        let vx = _vx[i];
        let vy = _vy[i];

        if (_mode === 1 && _tx && _ty) {
            // FORM: magnetic snap to grid
            const dx = _tx[i] - x;
            const dy = _ty[i] - y;
            vx += dx * 0.06;
            vy += dy * 0.06;
            vx *= 0.82;
            vy *= 0.82;
            x += vx;
            y += vy;
        } else if (_mode === 2) {
            // SPIRAL: orbital motion around center
            const dx = x - cx;
            const dy = y - cy;
            const angle = Math.atan2(dy, dx);
            const targetDist = 120 + Math.sin(_tick * 0.006 + i * 0.00008) * Math.min(cx, cy) * 0.6;
            const targetAngle = angle + 0.025;
            vx += (Math.cos(targetAngle) * targetDist - dx) * 0.007;
            vy += (Math.sin(targetAngle) * targetDist - dy) * 0.007;
            vx *= 0.95;
            vy *= 0.95;
            x += vx;
            y += vy;
        } else if (_mode === 3) {
            // VORTEX: swirl around mouse
            const dx = _mouseX - x;
            const dy = _mouseY - y;
            const distSq = dx * dx + dy * dy;
            const dist = Math.sqrt(distSq) || 1;
            const angle = Math.atan2(dy, dx);
            const perpAngle = angle + Math.PI * 0.5;
            const pull = Math.min(10, 500 / dist);
            const swirl = Math.max(0.5, 1 - dist / 600);
            vx += Math.cos(perpAngle) * pull * swirl * 0.2 - dx * 0.0006;
            vy += Math.sin(perpAngle) * pull * swirl * 0.2 - dy * 0.0006;
            vx *= 0.97;
            vy *= 0.97;
            x += vx;
            y += vy;
        } else {
            // CHAOS: Brownian + mouse repulsion
            const dx = _mouseX - x;
            const dy = _mouseY - y;
            const distSq = dx * dx + dy * dy;
            if (distSq < 225000) {
                const dist = Math.sqrt(distSq) || 1;
                const force = (470 - dist) / 470;
                vx -= dx * force * 0.14;
                vy -= dy * force * 0.14;
            }
            vx += (xor() - 0.5) * 0.18;
            vy += (xor() - 0.5) * 0.18;
            vx *= 0.96;
            vy *= 0.96;
            x += vx;
            y += vy;
        }

        // Screen wrap (not in form mode)
        if (_mode !== 1) {
            if (x < 0) x += _width; else if (x > _width) x -= _width;
            if (y < 0) y += _height; else if (y > _height) y -= _height;
        }

        _px[i] = x;
        _py[i] = y;
        _vx[i] = vx;
        _vy[i] = vy;
    }

    // Write positions + colors to shared buffer
    for (let i = 0; i < _count; i++) {
        const base = i * FLOATS_PER;
        _sharedData[base] = _px[i];
        _sharedData[base + 1] = _py[i];

        if (_mode === 1) {
            // Form: white
            _sharedData[base + 2] = 255;
            _sharedData[base + 3] = 255;
            _sharedData[base + 4] = 255;
            _sharedData[base + 5] = 0.92;
        } else if (_mode === 2) {
            // Spiral: purple-cyan
            const t = (Math.sin(_tick * 0.008 + i * 0.00006) + 1) * 0.5;
            _sharedData[base + 2] = 140 + t * 115 | 0;
            _sharedData[base + 3] = 60 + t * 140 | 0;
            _sharedData[base + 4] = 255;
            _sharedData[base + 5] = 0.82;
        } else if (_mode === 3) {
            // Vortex: orange-red heat
            const dx = _mouseX - _px[i];
            const dy = _mouseY - _py[i];
            const heat = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / 500);
            _sharedData[base + 2] = 255;
            _sharedData[base + 3] = 80 - heat * 60 | 0;
            _sharedData[base + 4] = 20 + heat * 30 | 0;
            _sharedData[base + 5] = 0.7 + heat * 0.3;
        } else {
            // Chaos: blue base, red near mouse
            const dx = _mouseX - _px[i];
            const dy = _mouseY - _py[i];
            const distSq = dx * dx + dy * dy;
            if (distSq < 225000) {
                _sharedData[base + 2] = 255;
                _sharedData[base + 3] = 40;
                _sharedData[base + 4] = 70;
                _sharedData[base + 5] = 0.95;
            } else {
                _sharedData[base + 2] = 0;
                _sharedData[base + 3] = 170;
                _sharedData[base + 4] = 255;
                _sharedData[base + 5] = 0.65;
            }
        }
    }

    // Signal frame ready
    Atomics.store(_sharedHeader, 0, 1);
    Atomics.notify(_sharedHeader, 0);

    _rafId = requestAnimationFrame(_loop);
}
