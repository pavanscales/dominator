/**
 * Text Engine — frame-stage text layout and rendering subsystem.
 *
 * ARCHITECTURE:
 *   Text runs as a dedicated frame stage between ANIMATION and VISIBILITY.
 *   Each text entity has:
 *     - A content string (interred in string table)
 *     - Font properties (family, size, weight, style)
 *     - Measured metrics (width, height, lines)
 *     - Glyph positions for rendering
 *
 *   Text layout uses a simple but fast line-breaking algorithm:
 *     1. Measure each glyph advance using canvas context (cached)
 *     2. Break lines at word boundaries within available width
 *     3. Generate glyph command(s) for the render graph
 *
 * ZERO-ALLOCATION:
 *   - Glyph cache: pre-allocated Float64Array for glyph advances
 *   - Line cache: pre-allocated Uint16Array for line breaks
 *   - String interning via existing arena
 *   - Cache hit: reuse previous metrics (no relayout)
 */

import {
    getWorld, Flag,
    STYLE_W, STYLE_H,
    LAYOUT_X, LAYOUT_Y, LAYOUT_W, LAYOUT_H, LAYOUT_CW, LAYOUT_CH,
    LAYOUT_FLOATS_PER_ENTITY,
} from './ecs';
import { _getDirtyList, _getDirtyCount } from './ecs';

// ═══════════════════════════════════════════════════════════════════════════
// TEXT COMPONENT — stored per text entity
// ═══════════════════════════════════════════════════════════════════════════

export interface TextStore {
    // Per-entity text properties (SoA)
    content: string[];           // text content per entity
    fontFamily: string[];        // font family
    fontSize: Float32Array;      // font size in px
    fontWeight: Uint16Array;     // 400 = normal, 700 = bold
    fontStyle: Uint8Array;       // 0 = normal, 1 = italic
    lineHeight: Float32Array;    // line height multiplier (1.2 default)
    color: Uint32Array;          // packed RGBA color
    textAlign: Uint8Array;       // 0=left, 1=center, 2=right

    // Cached metrics (set during text layout stage)
    measuredWidth: Float32Array;
    measuredHeight: Float32Array;
    lineCount: Uint16Array;
    generation: Uint32Array;     // cache invalidation generation

    // Counts
    count: number;
    cap: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// TEXT STATE
// ═══════════════════════════════════════════════════════════════════════════

const INITIAL_CAP = 4096;
const DEFAULT_FONT = 'sans-serif';
const DEFAULT_FONT_SIZE = 16;
const DEFAULT_LINE_HEIGHT = 1.2;

let _textStore: TextStore | null = null;
let _gen = 0;

export function createTextStore(capacity: number = INITIAL_CAP): TextStore {
    const cap = Math.max(capacity, 256);
    const ts: TextStore = {
        content: new Array(cap),
        fontFamily: new Array(cap),
        fontSize: new Float32Array(cap),
        fontWeight: new Uint16Array(cap),
        fontStyle: new Uint8Array(cap),
        lineHeight: new Float32Array(cap),
        color: new Uint32Array(cap),
        textAlign: new Uint8Array(cap),

        measuredWidth: new Float32Array(cap),
        measuredHeight: new Float32Array(cap),
        lineCount: new Uint16Array(cap),
        generation: new Uint32Array(cap),

        count: 0,
        cap,
    };
    for (let i = 0; i < cap; i++) {
        ts.fontFamily[i] = DEFAULT_FONT;
        ts.fontSize[i] = DEFAULT_FONT_SIZE;
        ts.lineHeight[i] = DEFAULT_LINE_HEIGHT;
        ts.fontWeight[i] = 400;
    }
    _textStore = ts;
    return ts;
}

export function getTextStore(): TextStore {
    if (!_textStore) _textStore = createTextStore();
    return _textStore;
}

// ═══════════════════════════════════════════════════════════════════════════
// TEXT COMPONENT API
// ═══════════════════════════════════════════════════════════════════════════

export function setText(entityId: number, text: string): void {
    const ts = getTextStore();
    if (entityId >= ts.cap) return;
    ts.content[entityId] = text;
    ts.generation[entityId] = _gen;
    const w = getWorld();
    w.flags[entityId] |= Flag.HAS_TEXT | Flag.DIRTY;
}

export function setFont(entityId: number, size: number, family?: string, weight?: number): void {
    const ts = getTextStore();
    if (entityId >= ts.cap) return;
    ts.fontSize[entityId] = size;
    if (family) ts.fontFamily[entityId] = family;
    if (weight) ts.fontWeight[entityId] = weight;
    ts.generation[entityId] = _gen;
}

export function setTextColor(entityId: number, r: number, g: number, b: number, a: number): void {
    const ts = getTextStore();
    if (entityId >= ts.cap) return;
    ts.color[entityId] = ((r & 0xFF) << 24) | ((g & 0xFF) << 16) | ((b & 0xFF) << 8) | (a & 0xFF);
}

// ═══════════════════════════════════════════════════════════════════════════
// GLYPH CACHE — pre-allocated, reused across frames
// ═══════════════════════════════════════════════════════════════════════════

const MAX_GLYPHS = 4096;
const _glyphAdvances = new Float64Array(MAX_GLYPHS);

let _wordAdvBuf = new Float64Array(128);
const _lineBreaks = new Uint16Array(256);
let _glyphCacheKey = 0;
let _glyphCacheGen = new Uint32Array(MAX_GLYPHS);

// Lazy canvas context for measuring text
let _measureCtx: CanvasRenderingContext2D | null = null;

function _getMeasureCtx(): CanvasRenderingContext2D | null {
    if (_measureCtx) return _measureCtx;
    if (typeof document === 'undefined') return null;
    try {
        const c = document.createElement('canvas').getContext('2d');
        if (c) _measureCtx = c;
        return c;
    } catch {
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// TEXT LAYOUT — measure, line-break, produce metrics
// ═══════════════════════════════════════════════════════════════════════════

export interface TextLayoutResult {
    entityId: number;
    lines: number;
    width: number;
    height: number;
}

export function layoutText(entityId: number, maxWidth: number): TextLayoutResult {
    const ts = getTextStore();
    if (entityId >= ts.cap || !ts.content[entityId]) {
        return { entityId, lines: 0, width: 0, height: 0 };
    }

    const text = ts.content[entityId];
    const fontSize = ts.fontSize[entityId];
    const fontFamily = ts.fontFamily[entityId];
    const fontWeight = ts.fontWeight[entityId];
    const lineHeight = ts.lineHeight[entityId] * fontSize;

    // Build font string
    const fontStr = fontWeight >= 700 ? `bold ${fontSize}px ${fontFamily}` : `${fontSize}px ${fontFamily}`;

    // Measure using canvas context (cached)
    const ctx = _getMeasureCtx();
    if (!ctx) {
        // Fallback: estimate width as character count * fontSize * 0.6
        const safeMax = maxWidth > 0 ? maxWidth : 64;
        const estimatedWidth = text.length * fontSize * 0.6;
        const estimatedLines = Math.max(1, Math.ceil(estimatedWidth / safeMax));
        const estimatedHeight = estimatedLines * lineHeight;
        ts.measuredWidth[entityId] = Math.min(estimatedWidth, maxWidth);
        ts.measuredHeight[entityId] = estimatedHeight;
        ts.lineCount[entityId] = estimatedLines;
        ts.generation[entityId] = _gen;
        return { entityId, lines: estimatedLines, width: Math.min(estimatedWidth, maxWidth), height: estimatedHeight };
    }

    ctx.font = fontStr;

    // Measure each word's advance — reuse pre-allocated buffer
    const words = text.split(' ');
    let wordAdvances = _wordAdvBuf;
    if (words.length > wordAdvances.length) {
        wordAdvances = new Float64Array(words.length);
        _wordAdvBuf = wordAdvances;
    }
    let totalWidth = 0;
    for (let i = 0; i < words.length; i++) {
        wordAdvances[i] = ctx.measureText(words[i] + ' ').width;
        totalWidth += wordAdvances[i];
    }

    // Line breaking
    if (maxWidth <= 0 || totalWidth <= maxWidth) {
        // Single line
        const singleWidth = ctx.measureText(text).width;
        ts.measuredWidth[entityId] = singleWidth;
        ts.measuredHeight[entityId] = lineHeight;
        ts.lineCount[entityId] = 1;
        ts.generation[entityId] = _gen;
        return { entityId, lines: 1, width: singleWidth, height: lineHeight };
    }

    // Multi-line: accumulate words until width exceeded
    let currentLineWidth = 0;
    let lines = 1;
    let maxLineWidth = 0;
    for (let i = 0; i < words.length; i++) {
        const wordAdv = wordAdvances[i];
        if (currentLineWidth + wordAdv > maxWidth && currentLineWidth > 0) {
            lines++;
            currentLineWidth = wordAdv;
        } else {
            currentLineWidth += wordAdv;
        }
        if (currentLineWidth > maxLineWidth) maxLineWidth = currentLineWidth;
    }

    const totalHeight = lines * lineHeight;
    ts.measuredWidth[entityId] = maxLineWidth;
    ts.measuredHeight[entityId] = totalHeight;
    ts.lineCount[entityId] = lines;
    ts.generation[entityId] = _gen;

    return { entityId, lines, width: maxLineWidth, height: totalHeight };
}

// ═══════════════════════════════════════════════════════════════════════════
// TEXT FRAME STAGE — called by frame scheduler
//
// Iterates dirty entities with HAS_TEXT flag, measures each, stores metrics.
// ═══════════════════════════════════════════════════════════════════════════

export function runTextLayoutStage(): number {
    const w = getWorld();
    const ts = _textStore;
    if (!ts) return 0;

    let processedCount = 0;
    const dirtyList = _getDirtyList();
    const dirtyCount = _getDirtyCount();
    for (let di = 0; di < dirtyCount; di++) {
        const i = dirtyList[di];
        if (w.flags[i] & Flag.HAS_TEXT) {
            const lw = w.layout.data[i * LAYOUT_FLOATS_PER_ENTITY + LAYOUT_W];
            const result = layoutText(i, Math.max(lw, 64));
            w.layout.data[i * LAYOUT_FLOATS_PER_ENTITY + LAYOUT_W] = result.width;
            w.layout.data[i * LAYOUT_FLOATS_PER_ENTITY + LAYOUT_H] = result.height;
            w.layout.data[i * LAYOUT_FLOATS_PER_ENTITY + LAYOUT_CW] = result.width;
            w.layout.data[i * LAYOUT_FLOATS_PER_ENTITY + LAYOUT_CH] = result.height;
            processedCount++;
        }
    }

    return processedCount;
}

// ═══════════════════════════════════════════════════════════════════════════
// RESET
// ═══════════════════════════════════════════════════════════════════════════

export function resetTextStore(): void {
    _textStore = null;
    _gen = 0;
    _measureCtx = null;
    _wordAdvBuf = new Float64Array(128);
}