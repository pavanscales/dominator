/**
 * 100K PARTICLES — MULTI-BACKEND BARE METAL PERFORMANCE ENGINE
 * 
 * Backend Priority (auto-detected):
 * 1. WebGPU Compute Shaders — GPU parallel physics + render (FASTEST)
 * 2. WebGL2 Transform Feedback + Instanced Arrays — GPU physics + render
 * 3. WebGL2 Point Sprites + Instanced Arrays — GPU render, CPU physics (WASM SIMD)
 * 4. WASM SIMD128 + Threads — Multi-threaded CPU physics + OffscreenCanvas render
 * 5. WASM Single-threaded — Single-threaded CPU physics + OffscreenCanvas render
 * 
 * Architecture:
 * - ALL rendering happens in Worker via OffscreenCanvas (zero main thread work)
 * - Transferable OffscreenCanvas for zero-copy canvas ownership
 * - SharedArrayBuffer for zero-copy data sharing
 * - Framework's Zig WASM modules for physics/reconciliation/signals
 * - Compiler-optimized .dnr templates for reactive UI
 */

// ┌─────────────────────────────────────────────────────────────────────────────
// BACKEND INTERFACE — All backends implement this
// ┌─────────────────────────────────────────────────────────────────────────────
interface ParticleBackend {
    readonly name: string;
    readonly isGPU: boolean;
    init(canvas: OffscreenCanvas, config: BackendConfig): Promise<void>;
    step(deltaTime: number): void;
    setMouse(x: number, y: number): void;
    setMode(mode: number): void;
    setViewport(width: number, height: number): void;
    explode(): void;
    destroy(): void;
    getStats(): BackendStats;
}

interface BackendConfig {
    particleCount: number;
    width: number;
    height: number;
    dpr: number;
    sharedBuffer?: SharedArrayBuffer;
    wasmModule?: WebAssembly.Module;
}

interface BackendStats {
    fps: number;
    physicsTime: number;
    renderTime: number;
    totalTime: number;
    backend: string;
}

// ┌─────────────────────────────────────────────────────────────────────────────
// BACKEND REGISTRY & AUTO-DETECTION
// ┌─────────────────────────────────────────────────────────────────────────────
const backends: Map<string, () => ParticleBackend> = new Map();

function registerBackend(name: string, factory: () => ParticleBackend): void {
    backends.set(name, factory);
}

async function detectBestBackend(config: BackendConfig): Promise<ParticleBackend> {
    // Priority order
    const priority = [
        'webgpu-compute',
        'webgl2-transform-feedback',
        'webgl2-instanced',
        'wasm-threads',
        'wasm-single',
    ];

    for (const name of priority) {
        const factory = backends.get(name);
        if (!factory) continue;
        
        try {
            const backend = factory();
            // Test if backend is actually available
            if (await backend.isAvailable(config)) {
                console.log(`[Particles] Using backend: ${backend.name}`);
                return backend;
            }
        } catch (e) {
            console.warn(`[Particles] Backend ${name} failed:`, e);
        }
    }
    
    throw new Error('No compatible backend found');
}

// Add isAvailable to interface
interface ParticleBackend {
    readonly name: string;
    readonly isGPU: boolean;
    init(canvas: OffscreenCanvas, config: BackendConfig): Promise<void>;
    step(deltaTime: number): void;
    setMouse(x: number, y: number): void;
    setMode(mode: number): void;
    setViewport(width: number, height: number): void;
    explode(): void;
    destroy(): void;
    getStats(): BackendStats;
    isAvailable(config: BackendConfig): Promise<boolean>;
}

// ┌─────────────────────────────────────────────────────────────────────────────
// MAIN WORKER — Runs physics + render on OffscreenCanvas (ZERO MAIN THREAD)
// ┌─────────────────────────────────────────────────────────────────────────────

let currentBackend: ParticleBackend | null = null;
let canvas: OffscreenCanvas | null = null;
let animationId: number = 0;
let lastTime = 0;
let frameCount = 0;

const stats = {
    fps: 0,
    physicsTime: 0,
    renderTime: 0,
    totalTime: 0,
    backend: 'unknown',
};

const fpsRing = new Float64Array(32);
let fpsRingPos = 0;
let fpsRingLen = 0;

// Shared buffer for main thread communication
let sharedHeader: Int32Array | null = null;
let sharedData: Float32Array | null = null;

self.onmessage = async (e: MessageEvent) => {
    const msg = e.data;
    
    switch (msg.type) {
        case 'init': {
            canvas = msg.canvas as OffscreenCanvas;
            
            const config: BackendConfig = {
                particleCount: msg.count || 100_000,
                width: msg.width || 1920,
                height: msg.height || 1080,
                dpr: msg.dpr || 1,
                sharedBuffer: msg.buffer as SharedArrayBuffer,
                wasmModule: msg.wasmModule as WebAssembly.Module,
            };
            
            // Setup shared memory views
            const HEADER_SIZE = 64;
            const FLOATS_PER = 8;
            sharedHeader = new Int32Array(config.sharedBuffer!, 0, HEADER_SIZE);
            sharedData = new Float32Array(config.sharedBuffer!, HEADER_SIZE * 4, config.particleCount * FLOATS_PER);
            
            // Initialize best backend
            currentBackend = await detectBestBackend(config);
            await currentBackend.init(canvas!, config);
            
            stats.backend = currentBackend.name;
            
            // Signal ready
            Atomics.store(sharedHeader!, 0, 1);
            Atomics.notify(sharedHeader!, 0);
            
            lastTime = performance.now();
            animationId = requestAnimationFrame(frameLoop);
            break;
        }
        
        case 'mouse': {
            if (currentBackend) {
                currentBackend.setMouse(msg.x, msg.y);
            }
            if (sharedHeader) {
                Atomics.store(sharedHeader, 3, msg.x);
                Atomics.store(sharedHeader, 4, msg.y);
            }
            break;
        }
        
        case 'mode': {
            if (currentBackend) {
                currentBackend.setMode(msg.mode);
            }
            if (sharedHeader) {
                Atomics.store(sharedHeader, 5, msg.mode);
            }
            break;
        }
        
        case 'explode': {
            if (currentBackend) {
                currentBackend.explode();
            }
            break;
        }
        
        case 'resize': {
            if (currentBackend) {
                currentBackend.setViewport(msg.width, msg.height);
            }
            if (sharedHeader) {
                Atomics.store(sharedHeader, 7, msg.width);
                Atomics.store(sharedHeader, 8, msg.height);
            }
            break;
        }
        
        case 'shutdown': {
            if (animationId) cancelAnimationFrame(animationId);
            if (currentBackend) currentBackend.destroy();
            break;
        }
    }
};

function frameLoop(time: number): void {
    const frameStart = performance.now();
    const deltaTime = time - lastTime;
    lastTime = time;
    frameCount++;

    // Run physics + render
    const physicsStart = performance.now();
    currentBackend!.step(deltaTime * 0.001);
    const physicsTime = performance.now() - physicsStart;
    
    const renderStart = performance.now();
    // Render is handled inside backend.step() for GPU backends
    // For CPU backends, render happens here
    const renderTime = performance.now() - renderStart;

    const totalTime = performance.now() - frameStart;
    
    // Update stats
    stats.physicsTime = physicsTime;
    stats.renderTime = renderTime;
    stats.totalTime = totalTime;
    
    fpsRing[fpsRingPos] = deltaTime;
    fpsRingPos = (fpsRingPos + 1) & 31;
    if (fpsRingLen < 32) fpsRingLen++;
    
    if ((frameCount & 15) === 0) {
        let sum = 0;
        for (let i = 0; i < fpsRingLen; i++) sum += fpsRing[i];
        const avgDt = sum / fpsRingLen;
        stats.fps = avgDt > 0 ? Math.min(999, Math.round(1000 / avgDt)) : 0;
        
        // Send stats to main thread via shared memory
        if (sharedHeader) {
            Atomics.store(sharedHeader, 1, Math.round(stats.fps));
            Atomics.store(sharedHeader, 2, Math.round(stats.physicsTime * 1000));
            Atomics.store(sharedHeader, 6, Math.round(stats.renderTime * 1000));
            Atomics.store(sharedHeader, 9, Math.round(stats.totalTime * 1000));
        }
    }

    animationId = requestAnimationFrame(frameLoop);
}

// ┌─────────────────────────────────────────────────────────────────────────────
// EXPORT FOR MODULE LOADING
// ┌─────────────────────────────────────────────────────────────────────────────
export type { ParticleBackend, BackendConfig, BackendStats };
export { registerBackend };