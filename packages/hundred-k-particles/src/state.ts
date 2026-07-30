/**
 * State for 100K particle demo.
 * 
 * In the pure worker mode, state lives in SharedArrayBuffer.
 * This module provides the reactive interface for non-worker features
 * (FPS display, mode toggle, etc.)
 */

import { signal, computed } from '@dominator/core';

export const fps = signal(0);
export const mode = signal<'chaos' | 'form'>('chaos');
export const particleCount = signal(100_000);

export const fpsDisplay = computed(() => {
    const f = fps();
    return f >= 55 ? `${f} FPS` : f >= 45 ? `${f} FPS` : `${f} FPS`;
});

export const modeLabel = computed(() => {
    return mode() === 'chaos' ? 'CHAOS' : 'FORM';
});
