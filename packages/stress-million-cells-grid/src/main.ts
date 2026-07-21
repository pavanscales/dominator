import { setupDelegation, batch, effect } from '@dominator/core';
import './style.css';
import * as S from './state';
import { updateViewport, throttle } from './utils/virtual-scroll';

const root = document.getElementById('app')!;
setupDelegation(root);

const MAX_ROWS = 120;
const MAX_COLS = 60;

const app = document.createElement('div');
app.className = 'million-cells-app';

const header = document.createElement('header');
header.className = 'header';

const title = document.createElement('h1');
title.textContent = 'MILLION CELLS';
header.appendChild(title);

const headerPerf = document.createElement('div');
headerPerf.className = 'perf-overlay';
const hpFPS = document.createElement('div');
hpFPS.className = 'perf-item';
hpFPS.innerHTML = '<span class="perf-label">FPS</span><span class="perf-value" id="hp-fps">--</span>';
const hpRender = document.createElement('div');
hpRender.className = 'perf-item';
hpRender.innerHTML = '<span class="perf-label">RENDER</span><span class="perf-value" id="hp-render">--</span>';
const hpBatch = document.createElement('div');
hpBatch.className = 'perf-item';
hpBatch.innerHTML = '<span class="perf-label">BATCH</span><span class="perf-value" id="hp-batch">--</span>';
headerPerf.appendChild(hpFPS);
headerPerf.appendChild(hpRender);
headerPerf.appendChild(hpBatch);
header.appendChild(headerPerf);
app.appendChild(header);

const gridMain = document.createElement('div');
gridMain.className = 'grid-main';

const gridScroll = document.createElement('div');
gridScroll.className = 'grid-scroll';

const gridSpacer = document.createElement('div');
gridSpacer.style.position = 'relative';
gridSpacer.style.height = `${S.TOTAL_ROWS * S.ROW_HEIGHT}px`;
gridSpacer.style.width = `${S.TOTAL_COLS * S.COL_WIDTH}px`;

const gridViewport = document.createElement('div');
gridViewport.className = 'grid-viewport';
gridViewport.style.position = 'absolute';
gridViewport.style.top = '0';
gridViewport.style.left = '0';
gridViewport.style.willChange = 'transform';

gridSpacer.appendChild(gridViewport);
gridScroll.appendChild(gridSpacer);
gridMain.appendChild(gridScroll);

const sidebar = document.createElement('div');
sidebar.className = 'sidebar';

const statsSection = document.createElement('div');
statsSection.className = 'stats-section';
statsSection.innerHTML = `
<h3>GRID STATS</h3>
<div class="stat-row"><span>Cells</span><strong>1,000,000</strong></div>
<div class="stat-row"><span>Rows</span><strong>1,000</strong></div>
<div class="stat-row"><span>Cols</span><strong>1,000</strong></div>
<div class="stat-row"><span>Cell Size</span><strong>80 x 24</strong></div>
<div class="stat-row" id="stat-avg"><span>AVG VAL</span><strong>--</strong></div>
<div class="stat-row" id="stat-high"><span>HIGH</span><strong>--</strong></div>
`;
sidebar.appendChild(statsSection);

const controlsSection = document.createElement('div');
controlsSection.className = 'controls-section';
controlsSection.innerHTML = `
<h3>CONTROLS</h3>
<p class="hint">Click a cell to select it</p>
<p class="hint">Arrow keys to navigate</p>
<p class="hint">Ctrl+Z to undo</p>
<button class="action-btn" id="btn-reset">Reset Grid</button>
`;
sidebar.appendChild(controlsSection);
gridMain.appendChild(sidebar);
app.appendChild(gridMain);
root.appendChild(app);

const perfOverlay = document.createElement('div');
perfOverlay.className = 'perf-overlay-fixed';
perfOverlay.innerHTML = `
<div class="perf-title">DOMINATOR STRESS 1M</div>
<div class="perf-row"><span>FPS</span><span id="po-fps" class="perf-mono">--</span></div>
<div class="perf-row"><span>RENDER</span><span id="po-render" class="perf-mono">--ms</span></div>
<div class="perf-row"><span>BATCH</span><span id="po-batch" class="perf-mono">--</span></div>
<div class="perf-divider"></div>
<div class="perf-row"><span>AVG VAL</span><span id="po-avg" class="perf-mono">--</span></div>
<div class="perf-row"><span>HIGH</span><span id="po-high" class="perf-mono">--</span></div>
`;
root.appendChild(perfOverlay);

const _rowEls: HTMLDivElement[] = [];
const _cellEls: HTMLDivElement[][] = [];
const _textEls: Text[][] = [];
const _cellDataR: number[][] = [];
const _cellDataC: number[][] = [];

for (let r = 0; r < MAX_ROWS; r++) {
    const rowEl = document.createElement('div');
    rowEl.className = 'grid-row';
    const cells: HTMLDivElement[] = [];
    const texts: Text[] = [];
    const dataR: number[] = [];
    const dataC: number[] = [];

    for (let c = 0; c < MAX_COLS; c++) {
        const cell = document.createElement('div');
        cell.className = 'grid-cell';
        const text = document.createTextNode('');
        cell.appendChild(text);
        rowEl.appendChild(cell);
        cells.push(cell);
        texts.push(text);
        dataR.push(0);
        dataC.push(0);
    }

    _rowEls.push(rowEl);
    _cellEls.push(cells);
    _textEls.push(texts);
    _cellDataR.push(dataR);
    _cellDataC.push(dataC);
}

const _fragment = document.createDocumentFragment();
let _prevRs = -1;
let _prevRe = -1;
let _prevCs = -1;
let _prevCe = -1;
let _prevSel = -1;

const hpFpsEl = document.getElementById('hp-fps')!;
const hpRenderEl = document.getElementById('hp-render')!;
const hpBatchEl = document.getElementById('hp-batch')!;
const poFpsEl = document.getElementById('po-fps')!;
const poRenderEl = document.getElementById('po-render')!;
const poBatchEl = document.getElementById('po-batch')!;
const poAvgEl = document.getElementById('po-avg')!;
const poHighEl = document.getElementById('po-high')!;
const statAvgEl = document.getElementById('stat-avg')!;
const statHighEl = document.getElementById('stat-high')!;

effect(() => {
    const _ = S.gridData();
    const sel = S.selectedCell();
    const rs = S.viewport.rowStart();
    const re = S.viewport.rowEnd();
    const cs = S.viewport.colStart();
    const ce = S.viewport.colEnd();

    const vRows = Math.min(re, S.TOTAL_ROWS - 1) - rs + 1;
    const vCols = Math.min(ce, S.TOTAL_COLS - 1) - cs + 1;

    const vpChanged = rs !== _prevRs || re !== _prevRe || cs !== _prevCs || ce !== _prevCe;
    const fullRerender = S.needsFullRerender();

    if (vpChanged || fullRerender) {
        _prevRs = rs;
        _prevRe = re;
        _prevCs = cs;
        _prevCe = ce;
        _prevSel = sel;

        _fragment.textContent = '';
        const grid = S.getGridData();

        for (let r = 0; r < vRows; r++) {
            const rowEl = _rowEls[r];
            const actualRow = rs + r;

            for (let c = 0; c < vCols; c++) {
                const cell = _cellEls[r][c];
                const actualCol = cs + c;
                const idx = actualRow * S.TOTAL_COLS + actualCol;
                const val = grid[idx];

                _cellDataR[r][c] = actualRow;
                _cellDataC[r][c] = actualCol;
                cell.className = sel === idx ? S.getCellClassSelected(val) : S.getCellClassName(val);
                cell.style.background = S.getCellBg(val);
                _textEls[r][c].textContent = S.getCellText(val);
            }

            for (let c = vCols; c < MAX_COLS; c++) {
                _cellEls[r][c].style.display = 'none';
            }

            _fragment.appendChild(rowEl);
        }

        for (let r = vRows; r < MAX_ROWS; r++) {
            _rowEls[r].style.display = 'none';
        }

        gridViewport.textContent = '';
        gridViewport.appendChild(_fragment);

        for (let r = 0; r < vRows; r++) {
            _rowEls[r].style.display = '';
            for (let c = 0; c < vCols; c++) {
                _cellEls[r][c].style.display = '';
            }
        }

        S.clearDirty();
    } else if (sel !== _prevSel) {
        const grid = S.getGridData();

        if (_prevSel >= 0) {
            const or2 = (_prevSel / S.TOTAL_COLS) | 0;
            const oc = _prevSel % S.TOTAL_COLS;
            if (or2 >= rs && or2 <= re && oc >= cs && oc <= ce) {
                const val = grid[_prevSel];
                _cellEls[or2 - rs][oc - cs].className = S.getCellClassName(val);
            }
        }

        if (sel >= 0) {
            const nr = (sel / S.TOTAL_COLS) | 0;
            const nc = sel % S.TOTAL_COLS;
            if (nr >= rs && nr <= re && nc >= cs && nc <= ce) {
                const val = grid[sel];
                _cellEls[nr - rs][nc - cs].className = S.getCellClassSelected(val);
            }
        }

        _prevSel = sel;
        S.clearDirty();
    } else {
        const grid = S.getGridData();
        const dirtyCount = S.getDirtyCount();

        for (let d = 0; d < dirtyCount; d++) {
            const idx = S.getDirtyIndex(d);
            const r = (idx / S.TOTAL_COLS) | 0;
            const c = idx % S.TOTAL_COLS;

            if (r >= rs && r <= re && c >= cs && c <= ce) {
                const localR = r - rs;
                const localC = c - cs;
                const val = grid[idx];

                _cellEls[localR][localC].className = sel === idx ? S.getCellClassSelected(val) : S.getCellClassName(val);
                _cellEls[localR][localC].style.background = S.getCellBg(val);
                _textEls[localR][localC].textContent = S.getCellText(val);
            }
        }

        S.clearDirty();
    }

    gridViewport.style.transform = `translate(${cs * S.COL_WIDTH}px,${rs * S.ROW_HEIGHT}px)`;

    const statsSnap = S.stats();
    const avgText = `AVG: ${statsSnap.avg}`;
    const highText = `HIGH: ${statsSnap.highValues}`;
    statAvgEl.querySelector('strong')!.textContent = statsSnap.avg;
    statHighEl.querySelector('strong')!.textContent = String(statsSnap.highValues);
    poAvgEl.textContent = statsSnap.avg;
    poHighEl.textContent = String(statsSnap.highValues);
});

gridViewport.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const rAttr = target.dataset.r;
    const cAttr = target.dataset.c;
    if (rAttr === undefined || cAttr === undefined) return;
    const r = +rAttr;
    const c = +cAttr;
    batch(() => {
        S.selectedCell.set(r * S.TOTAL_COLS + c);
    });
});

const initialUpdate = () => {
    updateViewport(gridScroll.scrollTop, gridScroll.scrollLeft, gridScroll.clientHeight, gridScroll.clientWidth);
};
initialUpdate();
window.addEventListener('resize', throttle(initialUpdate, 100));

gridScroll.addEventListener(
    'scroll',
    throttle(() => {
        updateViewport(gridScroll.scrollTop, gridScroll.scrollLeft, gridScroll.clientHeight, gridScroll.clientWidth);
    }, 16)
);

const TOTAL_ROWS = S.TOTAL_ROWS;
const TOTAL_COLS = S.TOTAL_COLS;

window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'z') {
        S.undo();
        return;
    }

    const selected = S.selectedCell();
    if (selected < 0) return;

    let r = (selected / TOTAL_COLS) | 0;
    let c = selected % TOTAL_COLS;

    if (e.key === 'ArrowUp') r = r > 0 ? r - 1 : 0;
    else if (e.key === 'ArrowDown') r = r < TOTAL_ROWS - 1 ? r + 1 : TOTAL_ROWS - 1;
    else if (e.key === 'ArrowLeft') c = c > 0 ? c - 1 : 0;
    else if (e.key === 'ArrowRight') c = c < TOTAL_COLS - 1 ? c + 1 : TOTAL_COLS - 1;
    else return;

    e.preventDefault();

    const newIdx = r * TOTAL_COLS + c;
    if (newIdx !== selected) {
        S.selectedCell.set(newIdx);

        const targetScrollTop = r * S.ROW_HEIGHT;
        const targetScrollLeft = c * S.COL_WIDTH;
        if (targetScrollTop < gridScroll.scrollTop) gridScroll.scrollTop = targetScrollTop;
        if (targetScrollTop + S.ROW_HEIGHT > gridScroll.scrollTop + gridScroll.clientHeight) {
            gridScroll.scrollTop = targetScrollTop - gridScroll.clientHeight + S.ROW_HEIGHT;
        }
        if (targetScrollLeft < gridScroll.scrollLeft) gridScroll.scrollLeft = targetScrollLeft;
        if (targetScrollLeft + S.COL_WIDTH > gridScroll.scrollLeft + gridScroll.clientWidth) {
            gridScroll.scrollLeft = targetScrollLeft - gridScroll.clientWidth + S.COL_WIDTH;
        }
    }
});

const BATCH_MIN = 1000;
const BATCH_RANGE = 2000;
const RAND_BUF_SIZE = 8192;
const _randR = new Uint32Array(RAND_BUF_SIZE);
const _randC = new Uint32Array(RAND_BUF_SIZE);
const _randV = new Uint32Array(RAND_BUF_SIZE);
let _randPos = 0;

function _fillRandBuf(): void {
    for (let i = 0; i < RAND_BUF_SIZE; i++) {
        _randR[i] = (Math.random() * TOTAL_ROWS) | 0;
        _randC[i] = (Math.random() * TOTAL_COLS) | 0;
        _randV[i] = (Math.random() * 101) | 0;
    }
    _randPos = 0;
}

_fillRandBuf();

const FRAME_RING_SIZE = 16;
const frameDeltas = new Float64Array(FRAME_RING_SIZE);
let frameRingPos = 0;
let frameRingLen = 0;
let frameCount = 0;
let lastTime = performance.now();

let _hidden = false;

document.addEventListener('visibilitychange', () => {
    _hidden = document.hidden;
    if (!_hidden) {
        lastTime = performance.now();
        _fillRandBuf();
        requestAnimationFrame(loop);
    }
});

function loop() {
    if (_hidden) return;

    frameCount++;
    const now = performance.now();
    const delta = now - lastTime;
    lastTime = now;

    frameDeltas[frameRingPos] = delta;
    frameRingPos = (frameRingPos + 1) & (FRAME_RING_SIZE - 1);
    if (frameRingLen < FRAME_RING_SIZE) frameRingLen++;

    if ((frameCount & 15) === 0) {
        let sum = 0;
        for (let i = 0; i < frameRingLen; i++) sum += frameDeltas[i];
        const avgDelta = sum / frameRingLen;
        const fps = Math.round(1000 / avgDelta);
        S.perf.fps.set(fps);
        S.perf.avgRenderTime.set(Number(avgDelta.toFixed(2)));

        const fpsStr = String(fps);
        const isGood = fps >= 55;
        hpFpsEl.textContent = fpsStr;
        hpFpsEl.className = `perf-value ${isGood ? 'good' : fps >= 45 ? 'warn' : 'bad'}`;
        hpRenderEl.textContent = `${avgDelta.toFixed(2)}ms`;
        hpBatchEl.textContent = String(S.perf.lastUpdateBatchSize());
        poFpsEl.textContent = fpsStr;
        poFpsEl.style.color = isGood ? '#00ff00' : fps >= 45 ? '#eab308' : '#ff4444';
        poRenderEl.textContent = `${avgDelta.toFixed(2)}ms`;
        poBatchEl.textContent = String(S.perf.lastUpdateBatchSize());
    }

    const batchSize = BATCH_MIN + ((Math.random() * BATCH_RANGE) | 0);
    S.perf.lastUpdateBatchSize.set(batchSize);

    batch(() => {
        for (let i = 0; i < batchSize; i++) {
            if (_randPos >= RAND_BUF_SIZE) _fillRandBuf();
            const p = _randPos++;
            S.writeCell(_randR[p], _randC[p], _randV[p]);
        }
        S.bumpGrid();
    });

    requestAnimationFrame(loop);
}

requestAnimationFrame(loop);

setInterval(() => {
    S.pushUndo();
}, 5000);

document.getElementById('btn-reset')?.addEventListener('click', () => {
    batch(() => {
        for (let i = 0; i < S.TOTAL_CELLS; i++) {
            S.getGridData()[i] = 0;
        }
        S.markAllDirty();
        S.bumpGrid();
    });
});

(window as any).state = S;
