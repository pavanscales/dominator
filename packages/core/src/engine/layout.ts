/**
 * Incremental Layout Engine — flex/grid layout with dirty-subtree recompute.
 *
 * Maintains its own layout cache. Only dirty subtrees recompute.
 * Supports:
 *   - Block layout (vertical stack)
 *   - Flex layout (row/column, justify, align)
 *   - Padding/margin
 *   - Fixed dimensions
 *   - Auto-sizing (fill parent)
 *
 * ARCHITECTURE:
 *   Node → Measure → Constraints → Flex/Grid → Final Rect
 *
 * Only nodes with NEEDS_LAYOUT flag recompute.
 * Parent layouts propagate size constraints downward.
 * Child size reports propagate up for parent re-layout.
 */

import {
    getWorld, Flag,
    STYLE_X, STYLE_Y, STYLE_W, STYLE_H,
    STYLE_PL, STYLE_PR, STYLE_PT, STYLE_PB,
    STYLE_ML, STYLE_MR, STYLE_MT, STYLE_MB,
    STYLE_FLOATS_PER_ENTITY,
    LAYOUT_X, LAYOUT_Y, LAYOUT_W, LAYOUT_H, LAYOUT_CW, LAYOUT_CH,
    LAYOUT_FLOATS_PER_ENTITY,
    markLayoutDirty,
} from './ecs';
import { _getDirtyCount } from './ecs';

// ═══════════════════════════════════════════════════════════════════════════
// LAYOUT MODE
// ═══════════════════════════════════════════════════════════════════════════

export const enum LayoutMode {
    BLOCK  = 0,  // vertical stack
    FLEX   = 1,  // flex container
    TEXT   = 2,  // text node (leaf)
    ROOT   = 3,  // root container
}

export const enum FlexDirection {
    ROW    = 0,
    COLUMN = 1,
}

export const enum JustifyContent {
    FLEX_START = 0,
    CENTER     = 1,
    FLEX_END   = 2,
    SPACE_BETWEEN = 3,
    SPACE_AROUND  = 4,
}

export const enum AlignItems {
    FLEX_START = 0,
    CENTER     = 1,
    FLEX_END   = 2,
    STRETCH    = 3,
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYOUT CONFIG per entity — stored in a separate SoA
// ═══════════════════════════════════════════════════════════════════════════

// LayoutConfig: 4 ints per entity
// [0] mode (LayoutMode)
// [1] flexDir (FlexDirection)
// [2] justify (JustifyContent)
// [3] align (AlignItems)
const CONFIG_INTS = 4;

let _configData: Int32Array = new Int32Array(4096 * CONFIG_INTS);
let _configCap = 4096;

function _ensureConfig(id: number): void {
    if (id < _configCap) return;
    let newCap = _configCap;
    while (newCap <= id) newCap *= 2;
    const n = new Int32Array(newCap * CONFIG_INTS);
    n.set(_configData.subarray(0, _configCap * CONFIG_INTS));
    _configData = n;
    _configCap = newCap;
}

export function setLayoutMode(entityId: number, mode: LayoutMode): void {
    _ensureConfig(entityId);
    _configData[entityId * CONFIG_INTS + 0] = mode;
    markLayoutDirty(entityId);
}

export function setFlexDirection(entityId: number, dir: FlexDirection): void {
    _ensureConfig(entityId);
    _configData[entityId * CONFIG_INTS + 1] = dir;
    markLayoutDirty(entityId);
}

export function setJustifyContent(entityId: number, justify: JustifyContent): void {
    _ensureConfig(entityId);
    _configData[entityId * CONFIG_INTS + 2] = justify;
    markLayoutDirty(entityId);
}

export function setAlignItems(entityId: number, align: AlignItems): void {
    _ensureConfig(entityId);
    _configData[entityId * CONFIG_INTS + 3] = align;
    markLayoutDirty(entityId);
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYOUT ENGINE
// ═══════════════════════════════════════════════════════════════════════════

export function runLayout(rootEntity: number, viewportW: number, viewportH: number): number {
    const w = getWorld();

    if (!(w.flags[rootEntity] & (Flag.NEEDS_LAYOUT | Flag.DIRTY))) return 0;

    _measureSubtree(w, rootEntity, viewportW, viewportH);
    _layoutSubtree(w, rootEntity, 0, 0, viewportW, viewportH);

    return _getDirtyCount();
}

function _measureSubtree(
    w: ReturnType<typeof getWorld>,
    entityId: number,
    availW: number,
    availH: number,
): void {
    const styleBase = entityId * STYLE_FLOATS_PER_ENTITY;
    const floats = w.style.floats;

    const pl = floats[styleBase + STYLE_PL];
    const pr = floats[styleBase + STYLE_PR];
    const pt = floats[styleBase + STYLE_PT];
    const pb = floats[styleBase + STYLE_PB];

    const contentAvailW = availW - pl - pr;
    const contentAvailH = availH - pt - pb;

    // If explicit width/height set, use them
    const explicitW = floats[styleBase + STYLE_W];
    const explicitH = floats[styleBase + STYLE_H];

    let measuredW = explicitW > 0 ? explicitW : contentAvailW;
    let measuredH = explicitH > 0 ? explicitH : 0;

    // Measure children to determine intrinsic height
    let child = w.children[entityId];
    const configBase = entityId * CONFIG_INTS;
    const mode = _configData[configBase];

    if (mode === LayoutMode.FLEX || mode === LayoutMode.BLOCK || mode === LayoutMode.ROOT) {
        const isRow = mode === LayoutMode.FLEX && _configData[configBase + 1] === FlexDirection.ROW;
        let childOffset = 0;
        let maxCrossSize = 0;

        while (child >= 0) {
            if (w.flags[child] & Flag.REMOVED) {
                child = w.nextSibling[child];
                continue;
            }

            // Skip children that don't need layout — O(1) check
            const childNeedsLayout = (w.flags[child] & Flag.NEEDS_LAYOUT) !== 0;

            const childStyleBase = child * STYLE_FLOATS_PER_ENTITY;
            const childML = floats[childStyleBase + STYLE_ML];
            const childMR = floats[childStyleBase + STYLE_MR];
            const childMT = floats[childStyleBase + STYLE_MT];
            const childMB = floats[childStyleBase + STYLE_MB];
            const childPL = floats[childStyleBase + STYLE_PL];
            const childPR = floats[childStyleBase + STYLE_PR];
            const childPT = floats[childStyleBase + STYLE_PT];
            const childPB = floats[childStyleBase + STYLE_PB];
            const childExplicitW = floats[childStyleBase + STYLE_W];
            const childExplicitH = floats[childStyleBase + STYLE_H];

            if (childNeedsLayout) {
                _measureSubtree(w, child, isRow ? (childExplicitW > 0 ? childExplicitW : contentAvailW / Math.max(1, w.childCount[entityId])) : contentAvailW - childML - childMR, contentAvailH);
            }

            const childLayoutBase = child * LAYOUT_FLOATS_PER_ENTITY;
            const childW = w.layout.data[childLayoutBase + LAYOUT_W];
            const childH = w.layout.data[childLayoutBase + LAYOUT_H];

            if (isRow) {
                childOffset += childML + childW + childMR;
                const crossSize = childMT + childH + childMB;
                if (crossSize > maxCrossSize) maxCrossSize = crossSize;
            } else {
                // Block layout — vertical stack
                childOffset += childMT + childH + childMB;
                const crossSize = childML + childW + childMR;
                if (crossSize > maxCrossSize) maxCrossSize = crossSize;
            }

            child = w.nextSibling[child];
        }

        // Auto-size height if not explicit
        if (explicitH <= 0) {
            measuredH = childOffset;
        }

        // Auto-size width for row flex
        if (isRow && explicitW <= 0) {
            measuredW = childOffset;
        }

        // Ensure at least cross-axis fills parent for stretch
        if (maxCrossSize > measuredW && !isRow && explicitW <= 0) {
            measuredW = maxCrossSize;
        }
    }

    // Write layout rect
    const layoutBase = entityId * LAYOUT_FLOATS_PER_ENTITY;
    w.layout.data[layoutBase + LAYOUT_W] = measuredW;
    w.layout.data[layoutBase + LAYOUT_H] = measuredH;
    w.layout.data[layoutBase + LAYOUT_CW] = measuredW - pl - pr;
    w.layout.data[layoutBase + LAYOUT_CH] = measuredH - pt - pb;

    // Clear dirty
    w.flags[entityId] &= ~Flag.NEEDS_LAYOUT;
}

function _layoutSubtree(
    w: ReturnType<typeof getWorld>,
    entityId: number,
    x: number,
    y: number,
    parentW: number,
    parentH: number,
): void {
    const styleBase = entityId * STYLE_FLOATS_PER_ENTITY;
    const floats = w.style.floats;

    const pl = floats[styleBase + STYLE_PL];
    const pr = floats[styleBase + STYLE_PR];
    const pt = floats[styleBase + STYLE_PT];
    const pb = floats[styleBase + STYLE_PB];

    const layoutBase = entityId * LAYOUT_FLOATS_PER_ENTITY;
    const w_ = w.layout.data[layoutBase + LAYOUT_W];
    const h_ = w.layout.data[layoutBase + LAYOUT_H];

    // Set final position
    w.layout.data[layoutBase + LAYOUT_X] = x;
    w.layout.data[layoutBase + LAYOUT_Y] = y;

    // Layout children
    const configBase = entityId * CONFIG_INTS;
    const mode = _configData[configBase];
    const isRow = mode === LayoutMode.FLEX && _configData[configBase + 1] === FlexDirection.ROW;
    const justify = _configData[configBase + 2];
    const align = _configData[configBase + 3];

    if (mode === LayoutMode.BLOCK || mode === LayoutMode.FLEX || mode === LayoutMode.ROOT) {
        // Count visible children and compute total main-axis size
        let childCount = 0;
        let totalMainSize = 0;
        let child = w.children[entityId];

        while (child >= 0) {
            if (w.flags[child] & Flag.REMOVED) {
                child = w.nextSibling[child];
                continue;
            }
            const childStyleBase = child * STYLE_FLOATS_PER_ENTITY;
            const childML = floats[childStyleBase + STYLE_ML];
            const childMR = floats[childStyleBase + STYLE_MR];
            const childMT = floats[childStyleBase + STYLE_MT];
            const childMB = floats[childStyleBase + STYLE_MB];
            const childLayoutBase = child * LAYOUT_FLOATS_PER_ENTITY;
            const childW = w.layout.data[childLayoutBase + LAYOUT_W];
            const childH = w.layout.data[childLayoutBase + LAYOUT_H];

            if (isRow) {
                totalMainSize += childML + childW + childMR;
            } else {
                totalMainSize += childMT + childH + childMB;
            }
            childCount++;
            child = w.nextSibling[child];
        }

        const contentW = w_ - pl - pr;
        const contentH = h_ - pt - pb;

        // Compute justify offset
        let mainOffset = 0;
        const freeSpace = isRow ? (contentW - totalMainSize) : (contentH - totalMainSize);

        if (freeSpace > 0) {
            if (justify === JustifyContent.CENTER) {
                mainOffset = freeSpace / 2;
            } else if (justify === JustifyContent.FLEX_END) {
                mainOffset = freeSpace;
            } else if (justify === JustifyContent.SPACE_BETWEEN && childCount > 1) {
                // handled per-child below
            } else if (justify === JustifyContent.SPACE_AROUND) {
                mainOffset = freeSpace / (childCount * 2);
            }
        }

        let gapSpace = 0;
        let gapOffset = 0;
        if (freeSpace > 0) {
            if (justify === JustifyContent.SPACE_BETWEEN && childCount > 1) {
                gapSpace = freeSpace / (childCount - 1);
            } else if (justify === JustifyContent.SPACE_AROUND && childCount > 0) {
                gapOffset = freeSpace / childCount;
            }
        }

        // Position each child
        child = w.children[entityId];
        let crossMaxSize = 0;

        while (child >= 0) {
            if (w.flags[child] & Flag.REMOVED) {
                child = w.nextSibling[child];
                continue;
            }

            const childStyleBase = child * STYLE_FLOATS_PER_ENTITY;
            const childML = floats[childStyleBase + STYLE_ML];
            const childMR = floats[childStyleBase + STYLE_MR];
            const childMT = floats[childStyleBase + STYLE_MT];
            const childMB = floats[childStyleBase + STYLE_MB];
            const childLayoutBase = child * LAYOUT_FLOATS_PER_ENTITY;
            const childW = w.layout.data[childLayoutBase + LAYOUT_W];
            const childH = w.layout.data[childLayoutBase + LAYOUT_H];

            let childX: number, childY: number;

            if (isRow) {
                childX = x + pl + mainOffset + childML;
                childY = y + pt + childMT;

                // Cross-axis alignment
                if (align === AlignItems.CENTER) {
                    childY += (contentH - childMT - childH - childMB) / 2;
                } else if (align === AlignItems.FLEX_END) {
                    childY += contentH - childMT - childH - childMB;
                } else if (align === AlignItems.STRETCH) {
                    // Child height stretches to fill
                }

                mainOffset += childML + childW + childMR;
                if (justify === JustifyContent.SPACE_BETWEEN) {
                    mainOffset += gapSpace;
                } else if (justify === JustifyContent.SPACE_AROUND) {
                    mainOffset += gapOffset;
                }
            } else {
                // Block/flex-column layout
                childX = x + pl + childML;
                childY = y + pt + mainOffset + childMT;

                // Cross-axis alignment
                if (align === AlignItems.CENTER) {
                    childX += (contentW - childW) / 2;
                } else if (align === AlignItems.FLEX_END) {
                    childX += contentW - childW - childMR;
                } else if (align === AlignItems.STRETCH) {
                    // Child width stretches to fill
                    const childStyleW = floats[childStyleBase + STYLE_W];
                    if (childStyleW <= 0) {
                        w.layout.data[childLayoutBase + LAYOUT_W] = contentW - childML - childMR;
                    }
                }

                mainOffset += childMT + childH + childMB;
                if (justify === JustifyContent.SPACE_BETWEEN) {
                    mainOffset += gapSpace;
                } else if (justify === JustifyContent.SPACE_AROUND) {
                    mainOffset += gapOffset;
                }
            }

            w.layout.data[childLayoutBase + LAYOUT_X] = childX;
            w.layout.data[childLayoutBase + LAYOUT_Y] = childY;

            const crossEnd = isRow ? (childMT + childH + childMB) : (childML + childW + childMR);
            if (crossEnd > crossMaxSize) crossMaxSize = crossEnd;

            // Recurse
            _layoutSubtree(w, child, childX, childY, childW, childH);

            child = w.nextSibling[child];
        }
    }
}

export function resetLayoutConfig(): void {
    _configData = new Int32Array(4096 * CONFIG_INTS);
    _configCap = 4096;
}
