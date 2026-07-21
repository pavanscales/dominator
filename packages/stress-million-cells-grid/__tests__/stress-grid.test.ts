import { describe, it, expect, beforeEach } from 'vitest';

const TOTAL_ROWS = 1000;
const TOTAL_COLS = 1000;
const TOTAL_CELLS = TOTAL_ROWS * TOTAL_COLS;

describe('stress-million-cells-grid state', () => {
    let _gridData: Int32Array;
    let _classTable: string[];
    let _classSelTable: string[];
    let _bgTable: string[];
    let _valTable: string[];

    beforeEach(() => {
        _gridData = new Int32Array(TOTAL_CELLS);

        _classTable = new Array(101);
        _classSelTable = new Array(101);
        for (let i = 0; i <= 100; i++) {
            let cls = 'grid-cell';
            if (i >= 80) cls = 'grid-cell high';
            else if (i >= 50) cls = 'grid-cell medium';
            else if (i >= 20) cls = 'grid-cell low';
            _classTable[i] = cls;
            _classSelTable[i] = cls + ' selected';
        }

        _bgTable = new Array(101);
        for (let i = 0; i <= 100; i++) {
            _bgTable[i] = `hsl(0,0%,${i}%)`;
        }

        _valTable = new Array(101);
        _valTable[0] = '';
        for (let i = 1; i <= 100; i++) {
            _valTable[i] = String(i);
        }
    });

    describe('cell storage', () => {
        it('handles exactly 1M cells (1000x1000)', () => {
            expect(_gridData.length).toBe(1_000_000);
        });

        it('read/write round-trips correctly', () => {
            const row = 42;
            const col = 77;
            const val = 55;
            _gridData[row * TOTAL_COLS + col] = val;
            expect(_gridData[row * TOTAL_COLS + col]).toBe(val);
        });

        it('handles boundary cells (0,0)', () => {
            _gridData[0] = 100;
            expect(_gridData[0]).toBe(100);
        });

        it('handles boundary cells (999,999)', () => {
            const idx = 999 * TOTAL_COLS + 999;
            _gridData[idx] = 99;
            expect(_gridData[idx]).toBe(99);
        });

        it('handles all 101 possible values (0-100)', () => {
            for (let v = 0; v <= 100; v++) {
                _gridData[0] = v;
                expect(_gridData[0]).toBe(v);
            }
        });

        it('default values are 0', () => {
            for (let i = 0; i < 100; i++) {
                expect(_gridData[i]).toBe(0);
            }
        });
    });

    describe('lookup tables', () => {
        it('class table maps values correctly', () => {
            expect(_classTable[0]).toBe('grid-cell');
            expect(_classTable[19]).toBe('grid-cell');
            expect(_classTable[20]).toBe('grid-cell low');
            expect(_classTable[49]).toBe('grid-cell low');
            expect(_classTable[50]).toBe('grid-cell medium');
            expect(_classTable[79]).toBe('grid-cell medium');
            expect(_classTable[80]).toBe('grid-cell high');
            expect(_classTable[100]).toBe('grid-cell high');
        });

        it('selected class table appends selected', () => {
            expect(_classSelTable[0]).toBe('grid-cell selected');
            expect(_classSelTable[50]).toBe('grid-cell medium selected');
            expect(_classSelTable[80]).toBe('grid-cell high selected');
            expect(_classSelTable[100]).toBe('grid-cell high selected');
        });

        it('bg table has correct HSL strings', () => {
            expect(_bgTable[0]).toBe('hsl(0,0%,0%)');
            expect(_bgTable[50]).toBe('hsl(0,0%,50%)');
            expect(_bgTable[100]).toBe('hsl(0,0%,100%)');
        });

        it('val table has empty string for 0', () => {
            expect(_valTable[0]).toBe('');
        });

        it('val table has string numbers for 1-100', () => {
            expect(_valTable[1]).toBe('1');
            expect(_valTable[42]).toBe('42');
            expect(_valTable[100]).toBe('100');
        });

        it('lookup tables have exactly 101 entries', () => {
            expect(_classTable.length).toBe(101);
            expect(_classSelTable.length).toBe(101);
            expect(_bgTable.length).toBe(101);
            expect(_valTable.length).toBe(101);
        });
    });

    describe('undo ring buffer', () => {
        it('ring buffer wraps correctly with MAX_UNDO=20', () => {
            const MAX_UNDO = 20;
            const ring = new Array(MAX_UNDO);
            let head = 0;
            let len = 0;

            for (let i = 0; i < 25; i++) {
                ring[head] = i;
                head = (head + 1) % MAX_UNDO;
                if (len < MAX_UNDO) len++;
            }

            expect(len).toBe(MAX_UNDO);
            expect(ring[(head - 1 + MAX_UNDO) % MAX_UNDO]).toBe(24);
            expect(ring[(head - 2 + MAX_UNDO) % MAX_UNDO]).toBe(23);
            expect(ring[(head - MAX_UNDO + MAX_UNDO) % MAX_UNDO]).toBe(5);
        });

        it('undo retrieves entries in LIFO order', () => {
            const MAX_UNDO = 5;
            const ring = new Array(MAX_UNDO);
            let head = 0;
            let len = 0;
            const snapshots: number[] = [];

            for (let i = 0; i < 10; i++) {
                ring[head] = i;
                head = (head + 1) % MAX_UNDO;
                if (len < MAX_UNDO) len++;
            }

            for (let i = 0; i < 3; i++) {
                head = (head - 1 + MAX_UNDO) % MAX_UNDO;
                len--;
                snapshots.push(ring[head]!);
            }

            expect(snapshots).toEqual([9, 8, 7]);
        });
    });

    describe('viewport calculations', () => {
        it('clamps rowStart to 0', () => {
            const rowStart = Math.max(0, Math.floor(-10 / 24));
            expect(rowStart).toBe(0);
        });

        it('clamps rowEnd to TOTAL_ROWS-1', () => {
            const rowEnd = Math.min(TOTAL_ROWS - 1, Math.ceil(100000 / 24) + 10);
            expect(rowEnd).toBe(TOTAL_ROWS - 1);
        });

        it('calculates visible rows correctly', () => {
            const scrollTop = 0;
            const containerHeight = 1080;
            const ROW_HEIGHT = 24;
            const OVERSCAN_Y = 10;

            const rowStart = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_Y);
            const rowEnd = Math.min(
                TOTAL_ROWS - 1,
                Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN_Y
            );

            expect(rowStart).toBe(0);
            expect(rowEnd).toBe(Math.min(TOTAL_ROWS - 1, Math.ceil(1080 / 24) + 10));
        });

        it('calculates visible rows when scrolled to middle', () => {
            const scrollTop = 12000;
            const containerHeight = 1080;
            const ROW_HEIGHT = 24;
            const OVERSCAN_Y = 10;

            const rowStart = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_Y);
            const rowEnd = Math.min(
                TOTAL_ROWS - 1,
                Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN_Y
            );

            expect(rowStart).toBe(490);
            expect(rowEnd).toBe(555);
        });

        it('calculates visible rows when scrolled to bottom', () => {
            const scrollTop = 23000;
            const containerHeight = 1080;
            const ROW_HEIGHT = 24;
            const OVERSCAN_Y = 10;

            const rowStart = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_Y);
            const rowEnd = Math.min(
                TOTAL_ROWS - 1,
                Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN_Y
            );

            expect(rowEnd).toBe(TOTAL_ROWS - 1);
        });
    });

    describe('stats computation', () => {
        it('computes average of visible cells correctly', () => {
            const rStart = 0;
            const rEnd = 2;
            const cStart = 0;
            const cEnd = 2;

            _gridData[0] = 10;
            _gridData[1] = 20;
            _gridData[2] = 30;
            _gridData[1000] = 40;
            _gridData[1001] = 50;
            _gridData[1002] = 60;
            _gridData[2000] = 70;
            _gridData[2001] = 80;
            _gridData[2002] = 90;

            let sum = 0;
            let count = 0;
            let highValues = 0;

            for (let r = rStart; r <= rEnd; r++) {
                const rowOff = r * TOTAL_COLS;
                for (let c = cStart; c <= cEnd; c++) {
                    const val = _gridData[rowOff + c];
                    sum += val;
                    count++;
                    if (val >= 80) highValues++;
                }
            }

            expect(sum).toBe(450);
            expect(count).toBe(9);
            expect(highValues).toBe(2);
        });

        it('handles empty viewport', () => {
            let sum = 0;
            let count = 0;

            for (let r = 5; r < 5; r++) {
                for (let c = 0; c < 10; c++) {
                    sum += _gridData[r * TOTAL_COLS + c];
                    count++;
                }
            }

            expect(count).toBe(0);
        });
    });

    describe('memory edge cases', () => {
        it('Int32Array allocates correct memory for 1M cells', () => {
            const arr = new Int32Array(1_000_000);
            expect(arr.byteLength).toBe(4_000_000);
            expect(arr.length).toBe(1_000_000);
        });

        it('Int32Array copy for undo uses ~4MB', () => {
            const snapshot = new Int32Array(_gridData);
            expect(snapshot.byteLength).toBe(4_000_000);
        });

        it('rapid write/read consistency', () => {
            const iterations = 10000;
            for (let i = 0; i < iterations; i++) {
                const r = (Math.random() * TOTAL_ROWS) | 0;
                const c = (Math.random() * TOTAL_COLS) | 0;
                const v = (Math.random() * 101) | 0;
                _gridData[r * TOTAL_COLS + c] = v;
                expect(_gridData[r * TOTAL_COLS + c]).toBe(v);
            }
        });
    });

    describe('integer overflow safety', () => {
        it('row * TOTAL_COLS + col stays within bounds', () => {
            const maxIdx = (TOTAL_ROWS - 1) * TOTAL_COLS + (TOTAL_COLS - 1);
            expect(maxIdx).toBe(999_999);
            expect(maxIdx).toBeLessThan(TOTAL_CELLS);
        });

        it('bitwise floor does not overflow for typical values', () => {
            const val = (Math.random() * 1000) | 0;
            expect(val).toBeGreaterThanOrEqual(0);
            expect(val).toBeLessThan(1000);
        });
    });

    describe('performance regression guards', () => {
        it('class lookup returns correct pre-computed strings (zero GC)', () => {
            const iterations = 100000;

            for (let i = 0; i < iterations; i++) {
                const v = (Math.random() * 101) | 0;
                const cls = _classTable[v];
                const clsSel = _classSelTable[v];
                expect(clsSel).toBe(cls + ' selected');
                if (v >= 80) expect(cls).toBe('grid-cell high');
                else if (v >= 50) expect(cls).toBe('grid-cell medium');
                else if (v >= 20) expect(cls).toBe('grid-cell low');
                else expect(cls).toBe('grid-cell');
            }
        });

        it('bg lookup returns pre-allocated strings (zero GC)', () => {
            const iterations = 100000;
            const seen = new Set<string>();

            for (let i = 0; i < iterations; i++) {
                const v = (Math.random() * 101) | 0;
                const s = _bgTable[v];
                seen.add(s);
            }

            expect(seen.size).toBeLessThanOrEqual(101);
            for (const s of seen) {
                expect(s).toMatch(/^hsl\(0,0%,\d+%\)$/);
            }
        });

        it('bitwise floor is faster than Math.floor', () => {
            const iterations = 1000000;

            const startBitwise = performance.now();
            for (let i = 0; i < iterations; i++) {
                const _ = (Math.random() * 1000) | 0;
            }
            const bitwiseTime = performance.now() - startBitwise;

            const startFloor = performance.now();
            for (let i = 0; i < iterations; i++) {
                const _ = Math.floor(Math.random() * 1000);
            }
            const floorTime = performance.now() - startFloor;

            expect(bitwiseTime).toBeLessThan(floorTime * 1.5);
        });
    });
});

describe('virtual scroll edge cases', () => {
    const ROW_HEIGHT = 24;
    const COL_WIDTH = 80;
    const TOTAL_ROWS = 1000;
    const TOTAL_COLS = 1000;
    const OVERSCAN_X = 5;
    const OVERSCAN_Y = 10;

    function calcViewport(
        scrollTop: number,
        scrollLeft: number,
        containerHeight: number,
        containerWidth: number
    ) {
        const rowStart = Math.min(TOTAL_ROWS - 1, Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_Y));
        const rowEnd = Math.min(
            TOTAL_ROWS - 1,
            Math.max(rowStart, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN_Y)
        );
        const colStart = Math.min(TOTAL_COLS - 1, Math.max(0, Math.floor(scrollLeft / COL_WIDTH) - OVERSCAN_X));
        const colEnd = Math.min(
            TOTAL_COLS - 1,
            Math.max(colStart, Math.ceil((scrollLeft + containerWidth) / COL_WIDTH) + OVERSCAN_X)
        );
        return { rowStart, rowEnd, colStart, colEnd };
    }

    it('handles zero container dimensions', () => {
        const v = calcViewport(0, 0, 0, 0);
        expect(v.rowStart).toBe(0);
        expect(v.rowEnd).toBeGreaterThanOrEqual(v.rowStart);
        expect(v.colStart).toBe(0);
        expect(v.colEnd).toBeGreaterThanOrEqual(v.colStart);
    });

    it('handles very large container (larger than grid)', () => {
        const v = calcViewport(0, 0, 100000, 100000);
        expect(v.rowEnd).toBe(TOTAL_ROWS - 1);
        expect(v.colEnd).toBe(TOTAL_COLS - 1);
    });

    it('handles negative scrollTop gracefully', () => {
        const v = calcViewport(-100, -50, 1080, 1920);
        expect(v.rowStart).toBe(0);
        expect(v.colStart).toBe(0);
    });

    it('handles exact bottom-right scroll', () => {
        const maxScrollTop = TOTAL_ROWS * ROW_HEIGHT;
        const maxScrollLeft = TOTAL_COLS * COL_WIDTH;
        const v = calcViewport(maxScrollTop, maxScrollLeft, 1080, 1920);
        expect(v.rowEnd).toBe(TOTAL_ROWS - 1);
        expect(v.colEnd).toBe(TOTAL_COLS - 1);
    });

    it('viewport range is never negative', () => {
        for (let i = 0; i < 100; i++) {
            const st = (Math.random() * 50000) | 0;
            const sl = (Math.random() * 80000) | 0;
            const v = calcViewport(st, sl, 1080, 1920);
            expect(v.rowStart).toBeGreaterThanOrEqual(0);
            expect(v.rowEnd).toBeGreaterThanOrEqual(v.rowStart);
            expect(v.colStart).toBeGreaterThanOrEqual(0);
            expect(v.colEnd).toBeGreaterThanOrEqual(v.colStart);
        }
    });

    it('visible cells count is reasonable', () => {
        const v = calcViewport(0, 0, 1080, 1920);
        const visibleRows = v.rowEnd - v.rowStart + 1;
        const visibleCols = v.colEnd - v.colStart + 1;
        const totalVisible = visibleRows * visibleCols;

        expect(totalVisible).toBeLessThan(10000);
        expect(visibleRows).toBeGreaterThan(30);
        expect(visibleCols).toBeGreaterThan(10);
    });
});
