/**
 * Scene Editor State — Dominator Signals
 *
 * Reactive signals power the UI overlay.
 * The hot path (500K particle transforms) bypasses signals entirely
 * for maximum throughput. Signals handle the cold-path UI updates:
 * FPS display, mode labels, selection properties, stats.
 */

import { signal, computed } from '@dominator/core';

export const fps = signal(0);
export const mode = signal(0);
export const particleCount = signal(500_000);
export const selectedId = signal(-1);
export const physicsMs = signal(0);
export const renderMs = signal(0);

export const MODES = ['CHAOS', 'FORM', 'SPIRAL', 'VORTEX'] as const;
export const MODE_COLORS = ['#00ff88', '#00f0ff', '#c050ff', '#ff6030'] as const;

export const modeLabel = computed(() => MODES[mode()] ?? 'CHAOS');
export const modeColor = computed(() => MODE_COLORS[mode()] ?? '#00ff88');
export const fpsColor = computed(() => {
    const f = fps();
    return f >= 58 ? '#00ff88' : f >= 45 ? '#eab308' : '#ff4444';
});
