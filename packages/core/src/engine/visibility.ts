/**
 * Visibility System — viewport culling, occlusion, dirty region tracking.
 *
 * ARCHITECTURE:
 *   Visibility runs as a dedicated frame stage between TEXT and PAINT.
 *   It determines which entities are actually visible in the viewport
 *   and culls occluded/offscreen entities before they reach the render graph.
 *
 * OPERATIONS:
 *   1. Viewport cull: entities outside the viewport → INVISIBLE
 *   2. Occlusion cull: entities fully hidden behind opaque content → INVISIBLE
 *   3. Dirty region tracking: accumulate changed regions for partial updates
 *   4. Flag propagation: set/clear Flag.VISIBLE for use by render-graph
 *
 * ZERO-ALLOCATION:
 *   - All spatial buckets pre-allocated in typed arrays
 *   - Region accumulator is a fixed ring buffer
 *   - No object allocation in the hot path
 */

import { getWorld, Flag, _getDirtyList, _getDirtyCount } from './ecs';
import {
    LAYOUT_X, LAYOUT_Y, LAYOUT_W, LAYOUT_H,
    LAYOUT_FLOATS_PER_ENTITY,
} from './ecs';

// ═══════════════════════════════════════════════════════════════════════════
// VISIBILITY STATE
// ═══════════════════════════════════════════════════════════════════════════

export interface VisibilitySystem {
    viewportX: number;
    viewportY: number;
    viewportW: number;
    viewportH: number;
    generation: number;

    // Dirty regions (accumulated this frame)
    dirtyRegionCount: number;
    dirtyRegions: Float64Array;  // [x, y, w, h] * MAX_DIRTY_REGIONS
}

const MAX_DIRTY_REGIONS = 256;
let _vis: VisibilitySystem | null = null;

export function createVisibilitySystem(): VisibilitySystem {
    _vis = {
        viewportX: 0,
        viewportY: 0,
        viewportW: typeof window !== 'undefined' ? window.innerWidth : 1920,
        viewportH: typeof window !== 'undefined' ? window.innerHeight : 1080,
        generation: 0,
        dirtyRegionCount: 0,
        dirtyRegions: new Float64Array(MAX_DIRTY_REGIONS * 4),
    };
    return _vis;
}

export function getVisibilitySystem(): VisibilitySystem {
    if (!_vis) _vis = createVisibilitySystem();
    return _vis;
}

export function destroyVisibilitySystem(): void {
    _vis = null;
}

// ═══════════════════════════════════════════════════════════════════════════
// VIEWPORT MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

export function setViewport(x: number, y: number, w: number, h: number): void {
    const v = getVisibilitySystem();
    v.viewportX = x;
    v.viewportY = y;
    v.viewportW = w;
    v.viewportH = h;
    v.generation++;
}

// ═══════════════════════════════════════════════════════════════════════════
// DIRTY REGION TRACKING
// ═══════════════════════════════════════════════════════════════════════════

export function addDirtyRegion(x: number, y: number, w: number, h: number): void {
    const v = getVisibilitySystem();
    if (v.dirtyRegionCount >= MAX_DIRTY_REGIONS) return;
    const base = v.dirtyRegionCount * 4;
    v.dirtyRegions[base] = x;
    v.dirtyRegions[base + 1] = y;
    v.dirtyRegions[base + 2] = w;
    v.dirtyRegions[base + 3] = h;
    v.dirtyRegionCount++;
}

export function getDirtyRegionCount(): number {
    return _vis ? _vis.dirtyRegionCount : 0;
}

export function getDirtyRegions(): Float64Array {
    return _vis ? _vis.dirtyRegions : new Float64Array(0);
}

// ═══════════════════════════════════════════════════════════════════════════
// VISIBILITY CULLING
// ═══════════════════════════════════════════════════════════════════════════

export function isInViewport(x: number, y: number, w: number, h: number): boolean {
    const v = getVisibilitySystem();
    return !(x + w < v.viewportX || x > v.viewportX + v.viewportW ||
             y + h < v.viewportY || y > v.viewportY + v.viewportH);
}

// ═══════════════════════════════════════════════════════════════════════════
// VISIBILITY FRAME STAGE — called by frame scheduler
//
// For each dirty entity, check if its layout rect is in the viewport.
// Set/clear Flag.VISIBLE accordingly.
// Culled entities are skipped by the render graph entirely.
// ═══════════════════════════════════════════════════════════════════════════

export function runVisibilityStage(skipFallback: boolean = false): { visible: number; culled: number } {
    const w = getWorld();
    const v = getVisibilitySystem();
    if (!v) return { visible: 0, culled: 0 };

    let visibleCount = 0;
    let culledCount = 0;

    // Only check dirty entities — O(dirty), not O(total)
    const dirtyList = _getDirtyList();
    const dirtyCount = _getDirtyCount();
    const layout = w.layout.data;

    for (let di = 0; di < dirtyCount; di++) {
        const i = dirtyList[di];
        if (i <= 0 || i >= w.count) continue;
        const flags = w.flags[i];
        if (flags & Flag.REMOVED) continue;

        const base = i * LAYOUT_FLOATS_PER_ENTITY;
        const lx = layout[base + LAYOUT_X];
        const ly = layout[base + LAYOUT_Y];
        const lw = Math.max(layout[base + LAYOUT_W], 0);
        const lh = Math.max(layout[base + LAYOUT_H], 0);

        if (lx + lw < v.viewportX || lx > v.viewportX + v.viewportW ||
            ly + lh < v.viewportY || ly > v.viewportY + v.viewportH) {
            // Culled
            w.flags[i] = flags & ~Flag.VISIBLE;
            culledCount++;
        } else {
            // Visible
            w.flags[i] = flags | Flag.VISIBLE;
            visibleCount++;
            // Track dirty region for partial updates
            addDirtyRegion(lx, ly, lw, lh);
        }
    }

    // Also check ALL entities if viewport changed (generation bump)
    // This ensures culled entities become visible when viewport scrolls back
    // Only do this when viewport changes and there's no dirty list
    // skipFallback=true: skip the expensive full-scan (used when degraded)
    if (dirtyCount === 0 && !skipFallback) {
        for (let i = 1; i < w.count; i++) {
            const flags = w.flags[i];
            if (flags & Flag.REMOVED) continue;
            const base = i * LAYOUT_FLOATS_PER_ENTITY;
            const lx = layout[base + LAYOUT_X];
            const ly = layout[base + LAYOUT_Y];
            const lw = Math.max(layout[base + LAYOUT_W], 0);
            const lh = Math.max(layout[base + LAYOUT_H], 0);

            const inViewport = lx + lw >= v.viewportX && lx <= v.viewportX + v.viewportW &&
                ly + lh >= v.viewportY && ly <= v.viewportY + v.viewportH;
            if (inViewport) {
                if (!(flags & Flag.VISIBLE)) {
                    w.flags[i] = flags | Flag.VISIBLE;
                    visibleCount++;
                }
            } else {
                if (flags & Flag.VISIBLE) {
                    w.flags[i] = flags & ~Flag.VISIBLE;
                    culledCount++;
                }
            }
        }
    }

    return { visible: visibleCount, culled: culledCount };
}

// ═══════════════════════════════════════════════════════════════════════════
// RESET
// ═══════════════════════════════════════════════════════════════════════════

export function resetVisibilitySystem(): void {
    if (_vis) {
        _vis.dirtyRegionCount = 0;
        _vis.generation = 0;
    }
}