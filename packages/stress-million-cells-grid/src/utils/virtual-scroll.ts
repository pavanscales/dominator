import { viewport, TOTAL_ROWS, TOTAL_COLS } from '../state';
import { batch } from '@dominator/core';

export const ROW_HEIGHT = 24;
export const COL_WIDTH = 80;
const OVERSCAN_X = 5;
const OVERSCAN_Y = 10;

let _pendingScrollTop = -1;
let _pendingScrollLeft = -1;
let _pendingHeight = -1;
let _pendingWidth = -1;
let _rafScheduled = false;

export function updateViewport(
    scrollTop: number,
    scrollLeft: number,
    containerHeight: number,
    containerWidth: number
): void {
    _pendingScrollTop = scrollTop;
    _pendingScrollLeft = scrollLeft;
    _pendingHeight = containerHeight;
    _pendingWidth = containerWidth;

    if (!_rafScheduled) {
        _rafScheduled = true;
        requestAnimationFrame(_applyViewport);
    }
}

function _applyViewport(): void {
    _rafScheduled = false;

    const scrollTop = _pendingScrollTop;
    const scrollLeft = _pendingScrollLeft;
    const containerHeight = _pendingHeight;
    const containerWidth = _pendingWidth;

    if (scrollTop < 0) return;

    const rowStart = Math.min(TOTAL_ROWS - 1, Math.max(0, ((scrollTop / ROW_HEIGHT) | 0) - OVERSCAN_Y));
    const rowEnd = Math.min(
        TOTAL_ROWS - 1,
        Math.max(rowStart, (((scrollTop + containerHeight) / ROW_HEIGHT) | 0) + OVERSCAN_Y + 1)
    );

    const colStart = Math.min(TOTAL_COLS - 1, Math.max(0, ((scrollLeft / COL_WIDTH) | 0) - OVERSCAN_X));
    const colEnd = Math.min(
        TOTAL_COLS - 1,
        Math.max(colStart, (((scrollLeft + containerWidth) / COL_WIDTH) | 0) + OVERSCAN_X + 1)
    );

    batch(() => {
        if (viewport.rowStart() !== rowStart) viewport.rowStart.set(rowStart);
        if (viewport.rowEnd() !== rowEnd) viewport.rowEnd.set(rowEnd);
        if (viewport.colStart() !== colStart) viewport.colStart.set(colStart);
        if (viewport.colEnd() !== colEnd) viewport.colEnd.set(colEnd);
    });
}

export function throttle<T extends (...args: any[]) => any>(fn: T, ms: number): T {
    let last = 0;
    let timer = 0;
    return ((...args: any[]) => {
        const now = performance.now();
        const elapsed = now - last;
        if (elapsed >= ms) {
            last = now;
            fn(...args);
        } else if (!timer) {
            timer = setTimeout(() => {
                last = performance.now();
                timer = 0;
                fn(...args);
            }, ms - elapsed) as unknown as number;
        }
    }) as T;
}
