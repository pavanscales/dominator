import { signal, computed, Signal } from '@dominator/core';

export const GRID_SIZE = 64;
export const TOTAL_PIXELS = GRID_SIZE * GRID_SIZE;
export const WHITE = '#ffffff';

export const currentColor = signal<string>('#000000');
export const tool = signal<'draw' | 'erase'>('draw');

const _pixelSignals: Signal<string>[] = new Array(TOTAL_PIXELS);
for (let i = 0; i < TOTAL_PIXELS; i++) {
    _pixelSignals[i] = signal<string>(WHITE);
}
export const pixelSignals = _pixelSignals;

const MAX_HISTORY = 5000;
const _undoIdx = new Uint16Array(MAX_HISTORY);
const _undoColor = new Array<string>(MAX_HISTORY);
let _undoLen = 0;
let _undoPos = 0;

const _redoIdx = new Uint16Array(MAX_HISTORY);
const _redoColor = new Array<string>(MAX_HISTORY);
let _redoLen = 0;

export const historyLength = signal<number>(0);
export const redoLength = signal<number>(0);

export const setPixel = (x: number, y: number) => {
    if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return;
    const idx = y * GRID_SIZE + x;
    const prevColor = _pixelSignals[idx]();

    if (tool() === 'erase') {
        if (prevColor === WHITE) return;
        _pushUndo(idx, prevColor);
        _pixelSignals[idx].set(WHITE);
        _redoLen = 0;
        redoLength.set(0);
    } else {
        const color = currentColor();
        if (prevColor === color) return;
        _pushUndo(idx, prevColor);
        _pixelSignals[idx].set(color);
        _redoLen = 0;
        redoLength.set(0);
    }
};

function _pushUndo(idx: number, color: string): void {
    if (_undoLen < MAX_HISTORY) {
        _undoIdx[_undoLen] = idx;
        _undoColor[_undoLen] = color;
        _undoLen++;
    } else {
        _undoIdx.copyWithin(0, 1);
        _undoColor.copyWithin(0, 1);
        _undoIdx[MAX_HISTORY - 1] = idx;
        _undoColor[MAX_HISTORY - 1] = color;
    }
    historyLength.set(_undoLen);
}

export const undo = () => {
    if (_undoLen === 0) return;
    _undoLen--;
    const idx = _undoIdx[_undoLen];
    const color = _undoColor[_undoLen];

    const currentColorVal = _pixelSignals[idx]();

    if (_redoLen < MAX_HISTORY) {
        _redoIdx[_redoLen] = idx;
        _redoColor[_redoLen] = currentColorVal;
        _redoLen++;
    }
    redoLength.set(_redoLen);

    _pixelSignals[idx].set(color);
    historyLength.set(_undoLen);
};

export const redo = () => {
    if (_redoLen === 0) return;
    _redoLen--;
    const idx = _redoIdx[_redoLen];
    const color = _redoColor[_redoLen];

    const prevColor = _pixelSignals[idx]();
    _pushUndo(idx, prevColor);
    _pixelSignals[idx].set(color);
    redoLength.set(_redoLen);
};

let _isDrawing = false;
let _lastIdx = -1;

export const startDrawing = (e: MouseEvent) => {
    _isDrawing = true;
    _drawAt(e);
};

export const handleDrawing = (e: MouseEvent) => {
    if (!_isDrawing) return;
    _drawAt(e);
};

export const ifDrawing = handleDrawing;

export const stopDrawing = () => {
    _isDrawing = false;
    _lastIdx = -1;
};

function _drawAt(e: MouseEvent) {
    const target = e.target as HTMLElement;
    const idxAttr = target.dataset.idx;
    if (idxAttr === undefined) return;

    const idx = Number(idxAttr);
    if (Number.isNaN(idx) || idx === _lastIdx) return;
    _lastIdx = idx;

    const x = idx % GRID_SIZE;
    const y = (idx - x) / GRID_SIZE;
    setPixel(x, y);
}

export const colorCounts = computed(() => {
    const counts = new Map<string, number>();
    for (let i = 0; i < TOTAL_PIXELS; i++) {
        const c = _pixelSignals[i]();
        counts.set(c, (counts.get(c) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
});

export const exportToPNG = () => {
    const canvas = document.createElement('canvas');
    canvas.width = GRID_SIZE;
    canvas.height = GRID_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    for (let i = 0; i < TOTAL_PIXELS; i++) {
        const x = i % GRID_SIZE;
        const y = (i - x) / GRID_SIZE;
        ctx.fillStyle = _pixelSignals[i]();
        ctx.fillRect(x, y, 1, 1);
    }
    const link = document.createElement('a');
    link.download = 'dominator-pixel.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
};

let _randomTimer: ReturnType<typeof setInterval> | null = null;

export const startRandomPaint = () => {
    if (_randomTimer !== null) return;
    _randomTimer = setInterval(() => {
        if (Math.random() > 0.9) {
            const x = Math.floor(Math.random() * GRID_SIZE);
            const y = Math.floor(Math.random() * GRID_SIZE);
            setPixel(x, y);
        }
    }, 1000);
};

export const stopRandomPaint = () => {
    if (_randomTimer !== null) {
        clearInterval(_randomTimer);
        _randomTimer = null;
    }
};
