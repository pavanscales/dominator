/**
 * WorkerScheduler: Main thread ↔ Worker bridge using SharedArrayBuffer.
 * 
 * Architecture:
 * - Worker runs ALL reactivity (signals, effects, physics)
 * - Main thread ONLY creates DOM and applies style mutations
 * - Communication via SharedArrayBuffer + Atomics (zero-copy, no postMessage)
 * 
 * Memory Layout in SharedBuffer:
 * [0]     command (atomic int32: 0=idle, 1=ready, 2=swap, 3=shutdown)
 * [1]     particle count
 * [2]     frame number
 * [3]     mouse X
 * [4]     mouse Y
 * [5]     mode (0=chaos, 1=form)
 * [6]     fps (reported by worker)
 * [7-8]   viewport (width, height)
 * [64..]  particle data (interleaved: x, y, vx, vy, r, g, b, a per particle)
 */

export const CMD_IDLE = 0;
export const CMD_READY = 1;
export const CMD_SWAP = 2;
export const CMD_SHUTDOWN = 3;

// Shared memory layout
export const HEADER_SIZE = 64; // 64 int32s = 256 bytes header
export const FLOATS_PER_PARTICLE = 8; // x, y, vx, vy, r, g, b, a

export interface SharedLayout {
    buffer: SharedArrayBuffer;
    header: Int32Array;        // Command/status ints
    positions: Float32Array;   // Read-only particle positions (GPU-composed)
    colors: Float32Array;      // Read-only particle colors
    velocityX: Float32Array;   // Worker-only (not needed on main thread)
    velocityY: Float32Array;   // Worker-only
}

export function createSharedLayout(maxParticles: number): SharedLayout {
    const totalFloats = HEADER_SIZE + maxParticles * FLOATS_PER_PARTICLE;
    const byteSize = totalFloats * 4; // 4 bytes per float32
    const buffer = new SharedArrayBuffer(byteSize);

    const header = new Int32Array(buffer, 0, HEADER_SIZE);
    const dataStart = HEADER_SIZE * 4;

    // Split the data region into named views
    const fullData = new Float32Array(buffer, dataStart, maxParticles * FLOATS_PER_PARTICLE);

    // Create views into the interleaved data
    // Layout per particle: [x, y, vx, vy, r, g, b, a]
    // We can create offset views but for simplicity, use the full array
    // and index with stride

    return {
        buffer,
        header,
        positions: fullData, // Actually the full array — use getParticlePos() below
        colors: fullData,
        velocityX: fullData,
        velocityY: fullData,
    };
}

export function getParticlePos(layout: SharedLayout, index: number, out: { x: number; y: number }): void {
    const base = HEADER_SIZE + index * FLOATS_PER_PARTICLE;
    out.x = layout.positions[base];
    out.y = layout.positions[base + 1];
}

export function getParticleColor(layout: SharedLayout, index: number): { r: number; g: number; b: number; a: number } {
    const base = HEADER_SIZE + index * FLOATS_PER_PARTICLE + 4;
    return {
        r: layout.positions[base],
        g: layout.positions[base + 1],
        b: layout.positions[base + 2],
        a: layout.positions[base + 3],
    };
}

export function setHeaderCommand(layout: SharedLayout, cmd: number): void {
    Atomics.store(layout.header, 0, cmd);
}

export function getHeaderCommand(layout: SharedLayout): number {
    return Atomics.load(layout.header, 0);
}

export function waitCommand(layout: SharedLayout, expected: number, timeout = 1000): void {
    Atomics.wait(layout.header, 0, expected, timeout);
}

export function signalReady(layout: SharedLayout): void {
    Atomics.store(layout.header, 0, CMD_READY);
    Atomics.notify(layout.header, 0);
}

export function setHeaderInt(layout: SharedLayout, offset: number, value: number): void {
    Atomics.store(layout.header, offset, value);
}

export function getHeaderInt(layout: SharedLayout, offset: number): number {
    return Atomics.load(layout.header, offset);
}
