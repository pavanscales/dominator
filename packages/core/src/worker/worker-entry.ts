/**
 * Worker entry point — runs in WebWorker context.
 *
 * Receives SharedArrayBuffer from main thread.
 * Loads Zig WASM physics module, runs physics loop at 60fps.
 * Main thread reads positions via shared memory — zero postMessage overhead.
 */

import {
    physicsInitWasm, physicsStep, physicsExplode,
    physicsSetTargets, physicsSetMouse, physicsSetMode, physicsSetViewport,
} from './physics';
import { CMD_READY, CMD_SHUTDOWN, HEADER_SIZE, FLOATS_PER_PARTICLE } from './scheduler';

let _running = false;
let _rafId = 0;

self.onmessage = async (e: MessageEvent) => {
    const msg = e.data;

    switch (msg.type) {
        case 'init': {
            const count = msg.count as number;
            const buffer = msg.buffer as SharedArrayBuffer;

            const header = new Int32Array(buffer, 0, HEADER_SIZE);
            const data = new Float32Array(buffer, HEADER_SIZE * 4, count * FLOATS_PER_PARTICLE);

            // Load and initialize Zig WASM physics module
            const wasmUrl = msg.wasmUrl || '/zig/physics.wasm';
            await physicsInitWasm(count, data, header, wasmUrl);

            // Set initial targets if provided
            if (msg.targets) {
                physicsSetTargets(new Float32Array(msg.targets));
            }

            _running = true;
            _loop();
            break;
        }

        case 'targets': {
            const targets = new Float32Array(msg.targets);
            physicsSetTargets(targets);
            break;
        }

        case 'explode': {
            physicsExplode();
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

    // Step physics
    physicsStep();

    // Schedule next frame
    _rafId = requestAnimationFrame(_loop);
}
