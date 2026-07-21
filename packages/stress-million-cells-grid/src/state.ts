import { signal, computed } from '@dominator/core';

export const TOTAL_ROWS = 1000;
export const TOTAL_COLS = 1000;
export const TOTAL_CELLS = TOTAL_ROWS * TOTAL_COLS;
export const ROW_HEIGHT = 24;
export const COL_WIDTH = 80;
export const MAX_UNDO = 20;

const _gridData = new Int32Array(TOTAL_CELLS);
let _gridVersion = 0;

export const gridData = signal<number>(0);

const _dirtyBitmap = new Uint8Array(TOTAL_CELLS);
const _dirtyList: number[] = [];
let _fullRerender = false;

export function readCell(row: number, col: number): number {
    return _gridData[row * TOTAL_COLS + col];
}

export function writeCell(row: number, col: number, val: number): void {
    const idx = row * TOTAL_COLS + col;
    if (_gridData[idx] !== val) {
        _gridData[idx] = val;
        if (!_dirtyBitmap[idx]) {
            _dirtyBitmap[idx] = 1;
            _dirtyList.push(idx);
        }
    }
}

export function getGridData(): Int32Array {
    return _gridData;
}

export function bumpGrid(): void {
    _gridVersion++;
    gridData.set(_gridVersion);
}

export function markAllDirty(): void {
    _fullRerender = true;
}

export function getDirtyCount(): number {
    return _dirtyList.length;
}

export function getDirtyIndex(i: number): number {
    return _dirtyList[i];
}

export function needsFullRerender(): boolean {
    return _fullRerender;
}

export function clearDirty(): void {
    for (let i = 0; i < _dirtyList.length; i++) {
        _dirtyBitmap[_dirtyList[i]] = 0;
    }
    _dirtyList.length = 0;
    _fullRerender = false;
}

export const viewport = {
    rowStart: signal(0),
    rowEnd: signal(80),
    colStart: signal(0),
    colEnd: signal(60),
};

export const selectedCell = signal<number>(-1);

const _CLASS_BASE = 'grid-cell';
const _CLASS_LOW = 'grid-cell low';
const _CLASS_MED = 'grid-cell medium';
const _CLASS_HIGH = 'grid-cell high';
const _CLASS_SEL = ' selected';

const _classTable = new Array<string>(101);
const _classSelTable = new Array<string>(101);
for (let i = 0; i <= 100; i++) {
    let cls = _CLASS_BASE;
    if (i >= 80) cls = _CLASS_HIGH;
    else if (i >= 50) cls = _CLASS_MED;
    else if (i >= 20) cls = _CLASS_LOW;
    _classTable[i] = cls;
    _classSelTable[i] = cls + _CLASS_SEL;
}

const _bgTable = new Array<string>(101);
for (let i = 0; i <= 100; i++) {
    _bgTable[i] = `hsl(0,0%,${i}%)`;
}

const _valTable = new Array<string>(101);
_valTable[0] = '';
for (let i = 1; i <= 100; i++) {
    _valTable[i] = String(i);
}

export function getCellClassName(val: number): string {
    return _classTable[val];
}

export function getCellClassSelected(val: number): string {
    return _classSelTable[val];
}

export function getCellBg(val: number): string {
    return _bgTable[val];
}

export function getCellText(val: number): string {
    return _valTable[val];
}

export function getCellValue(row: number, col: number): string {
    return _valTable[_gridData[row * TOTAL_COLS + col]];
}

export function getCellBgByCoord(row: number, col: number): string {
    return _bgTable[_gridData[row * TOTAL_COLS + col]];
}

export function getCellFullClass(row: number, col: number): string {
    const val = _gridData[row * TOTAL_COLS + col];
    return selectedCell() === row * TOTAL_COLS + col ? _classSelTable[val] : _classTable[val];
}

export function getViewportTransform(): string {
    const r = viewport.rowStart();
    const c = viewport.colStart();
    return `translate(${c * COL_WIDTH}px,${r * ROW_HEIGHT}px)`;
}

export const domNodes = () => 0;

interface UndoEntry {
    data: Int32Array;
    selected: number;
}

const _undoRing = new Array<UndoEntry>(MAX_UNDO);
let _undoHead = 0;
let _undoLen = 0;

export function pushUndo(): void {
    const snapshot = new Int32Array(_gridData);
    const entry: UndoEntry = { data: snapshot, selected: selectedCell() };
    if (_undoLen >= MAX_UNDO) {
        _undoRing[_undoHead] = entry;
        _undoHead = (_undoHead + 1) % MAX_UNDO;
    } else {
        _undoRing[_undoHead] = entry;
        _undoHead = (_undoHead + 1) % MAX_UNDO;
        _undoLen++;
    }
}

export function undo(): void {
    if (_undoLen === 0) return;
    _undoHead = (_undoHead - 1 + MAX_UNDO) % MAX_UNDO;
    _undoLen--;
    const entry = _undoRing[_undoHead]!;
    _gridData.set(entry.data);
    selectedCell.set(entry.selected);
    markAllDirty();
    bumpGrid();
}

export const perf = {
    lastUpdateBatchSize: signal(0),
    fps: signal(0),
    avgRenderTime: signal(0),
};

export const visibleRows = computed(() => {
    const start = viewport.rowStart();
    const end = viewport.rowEnd();
    const len = Math.min(end, TOTAL_ROWS - 1) - start + 1;
    const rows = new Array<number>(len);
    for (let i = 0; i < len; i++) rows[i] = start + i;
    return rows;
});

export const visibleCols = computed(() => {
    const start = viewport.colStart();
    const end = viewport.colEnd();
    const len = Math.min(end, TOTAL_COLS - 1) - start + 1;
    const cols = new Array<number>(len);
    for (let i = 0; i < len; i++) cols[i] = start + i;
    return cols;
});

let _lastStatsTime = 0;
let _lastStatsResult: { avg: string; total: number; highValues: number } | null = null;

export const stats = computed(() => {
    gridData();
    const rStart = viewport.rowStart();
    const rEnd = viewport.rowEnd();
    const cStart = viewport.colStart();
    const cEnd = viewport.colEnd();

    const now = performance.now();
    if (now - _lastStatsTime < 500 && _lastStatsResult !== null) {
        return _lastStatsResult;
    }
    _lastStatsTime = now;

    const rEndClamped = Math.min(rEnd, TOTAL_ROWS - 1);
    const cEndClamped = Math.min(cEnd, TOTAL_COLS - 1);
    let sum = 0;
    let count = 0;
    let highValues = 0;

    for (let r = rStart; r <= rEndClamped; r++) {
        const rowOff = r * TOTAL_COLS;
        for (let c = cStart; c <= cEndClamped; c++) {
            const val = _gridData[rowOff + c];
            sum += val;
            count++;
            if (val >= 80) highValues++;
        }
    }

    _lastStatsResult = {
        avg: count > 0 ? (sum / count).toFixed(2) : '0',
        total: sum,
        highValues,
    };
    return _lastStatsResult;
});
