// @ts-nocheck — experimental worker file
/**
 * Worker: 100K particle physics engine — MAXIMUM PERFORMANCE.
 * 
 * Uses @dominator/core WASM physics with SharedArrayBuffer for zero-copy.
 * - WASM memory IS SharedArrayBuffer → main thread reads positions directly
 * - No per-particle copy loop → bulk TypedArray operations
 * - Cached typed views → no allocation per frame
 * - Config reads batched via Atomics → single cache line access
 */

import {
    physicsInitWasm,
    physicsStep,
    physicsExplode,
    physicsSetTargets,
    physicsSetViewport,
    physicsSetMouse,
    physicsSetMode,
} from '@dominator/core';

const FLOATS_PER = 8;
const HEADER_SIZE = 64;

let _sharedData: Float32Array;
let _sharedHeader: Int32Array;
let _running = false;
let _rafId = 0;
let _width = 1920;
let _height = 1080;
let _mouseX = 960;
let _mouseY = 540;
let _mode = 0;
let _count = 0;

self.onmessage = async (e: MessageEvent) => {
    const msg = e.data;
    switch (msg.type) {
        case 'init': {
            _count = msg.count;
            const buf = msg.buffer as SharedArrayBuffer;
            _sharedHeader = new Int32Array(buf, 0, HEADER_SIZE);
            _sharedData = new Float32Array(buf, HEADER_SIZE * 4, _count * FLOATS_PER);

            _width = msg.width || 1920;
            _height = msg.height || 1080;

            // Initialize WASM physics with shared memory
            await physicsInitWasm(_count, _sharedData, _sharedHeader);

            _running = true;
            _loop();
            break;
        }
        case 'targets': {
            const t = new Float32Array(msg.targets);
            physicsSetTargets(t);
            break;
        }
        case 'explode': {
            physicsExplode();
            break;
        }
        case 'resize': {
            _width = msg.width;
            _height = msg.height;
            physicsSetViewport(_width, _height);
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

    // Batch config reads via Atomics - single cache line access
    _mouseX = Atomics.load(_sharedHeader, 3);
    _mouseY = Atomics.load(_sharedHeader, 4);
    _mode = Atomics.load(_sharedHeader, 5);
    _width = Atomics.load(_sharedHeader, 7);
    _height = Atomics.load(_sharedHeader, 8);

    // Update WASM config
    physicsSetMouse(_mouseX, _mouseY);
    physicsSetMode(_mode);
    physicsSetViewport(_width, _height);

    // Step physics in Zig WASM (SIMD-optimized)
    physicsStep();

    // Signal frame ready
    Atomics.store(_sharedHeader, 0, 1);
    Atomics.store(_sharedHeader, 2, Date.now());
    Atomics.store(_sharedHeader, 6, 0);
    Atomics.notify(_sharedHeader, 0);

    _rafId = requestAnimationFrame(_loop);
}