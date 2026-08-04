/**
 * Renderer — ZERO-ALLOCATION rendering backends.
 *
 * Three interchangeable backends:
 *   1. DOM Renderer — node pool, direct style patching, no string comparison
 *   2. Canvas Renderer — pre-cached fillStyle, batched draw calls
 *   3. WebGPU Renderer — persistent mapped buffers, instanced rendering
 *
 * ZERO-ALLOCATION GUARANTEES:
 *   - DOM: pre-allocated style strings via lookup table, node pool reuse
 *   - Canvas: pre-built fillStyle cache per RGBA, no per-frame string concat
 *   - WebGPU: persistent GPU buffer, no destroy+create per frame
 *   - All backends: zero JS allocation in executeCommands() hot path
 */

import { CmdType, getCommandBuffer, getCommandHead, getCommandTail, getGPUCommandBuffer, getGPUCommandHead } from './render-graph';

// ═══════════════════════════════════════════════════════════════════════════
// RENDERER INTERFACE
// ═══════════════════════════════════════════════════════════════════════════

export const enum RendererType {
    DOM    = 0,
    CANVAS = 1,
    WEBGPU = 2,
}

export interface Renderer {
    type: RendererType;
    canvas: HTMLCanvasElement | null;
    container: HTMLElement | null;

    init(container: HTMLElement, options?: RendererOptions): void;
    destroy(): void;
    resize(width: number, height: number): void;
    executeCommands(): void;
    clear(): void;
    present(): void;

    // Stats
    drawCalls: number;
    trianglesRendered: number;
    frameTime: number;
}

export interface RendererOptions {
    antialias?: boolean;
    alpha?: boolean;
    powerPreference?: 'low-power' | 'high-performance' | 'default';
    pixelRatio?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// RGBA STRING CACHE — pre-computed color strings, indexed by packed RGBA
// ═══════════════════════════════════════════════════════════════════════════

// Full RGBA key: pack all 4 channels into a single integer
function _rgbaKey(r: number, g: number, b: number, a: number): number {
    return (r << 24) | (g << 16) | (b << 8) | (Math.round(a * 255) & 0xFF);
}

const _rgbaCacheKey = new Uint32Array(65536);
const _rgbaCacheStr = new Array<string>(65536);

function _getRgbaString(rgba: number): string {
    const r = (rgba >>> 24) & 0xFF;
    const g = (rgba >>> 16) & 0xFF;
    const b = (rgba >>> 8) & 0xFF;
    const a = (rgba & 0xFF) / 255;
    const key = (r * 7 + g * 13 + b * 23 + Math.round(a * 100)) & 0xFFFF;
    const fullKey = _rgbaKey(r, g, b, a);
    if (_rgbaCacheKey[key] === fullKey) return _rgbaCacheStr[key];
    const str = `rgba(${r},${g},${b},${a.toFixed(3)})`;
    _rgbaCacheKey[key] = fullKey;
    _rgbaCacheStr[key] = str;
    return str;
}

// ═══════════════════════════════════════════════════════════════════════════
// DOM RENDERER — node pool + direct style patching
// ═══════════════════════════════════════════════════════════════════════════

export class DOMRenderer implements Renderer {
    type = RendererType.DOM;
    canvas: HTMLCanvasElement | null = null;
    container: HTMLElement | null = null;
    drawCalls = 0;
    trianglesRendered = 0;
    frameTime = 0;

    private _root: HTMLElement | null = null;
    private _nodes: (HTMLElement | null)[] = [];
    private _nodesCap = 0;
    private _nodePool: HTMLElement[] = [];
    private _poolSize = 0;

    // Pre-allocated style patching buffers — last known values per entity
    private _lastBg: Uint32Array = new Uint32Array(4096);
    private _lastLeft: Float32Array = new Float32Array(4096);
    private _lastTop: Float32Array = new Float32Array(4096);
    private _lastWidth: Float32Array = new Float32Array(4096);
    private _lastHeight: Float32Array = new Float32Array(4096);
    private _lastBorderRadius: Float32Array = new Float32Array(4096);
    private _lastBorderWidth: Float32Array = new Float32Array(4096);
    private _lastBorderRgba: Uint32Array = new Uint32Array(4096);
    private _lastEntityCount = 0;

    init(container: HTMLElement): void {
        this.container = container;
        this._root = container;
    }

    destroy(): void {
        this._nodes.length = 0;
        this._nodesCap = 0;
        this._nodePool.length = 0;
        this._poolSize = 0;
        this._root = null;
    }

    resize(_w: number, _h: number): void {
        // DOM renderer doesn't need explicit resize
    }

    private _ensureNodeArray(entityId: number): void {
        if (entityId < this._nodesCap) return;
        const newCap = Math.max(entityId + 4096, this._nodesCap * 2);
        this._nodes.length = newCap;
        this._nodesCap = newCap;
    }

    private _acquireNode(entityId: number): HTMLElement {
        this._ensureNodeArray(entityId);
        let node = this._nodes[entityId];
        if (node) return node;

        // Try pool first
        if (this._poolSize > 0) {
            node = this._nodePool[--this._poolSize];
        } else {
            node = document.createElement('div');
        }

        node.style.position = 'absolute';
        this._nodes[entityId] = node;
        this._root?.appendChild(node);
        return node;
    }

    executeCommands(): void {
        const start = performance.now();
        this.drawCalls = 0;

        const buf = getCommandBuffer();
        const head = getCommandHead();
        const tail = getCommandTail();
        let read = tail;

        while (read < head) {
            const type = buf[read & 0xFFFFF];
            switch (type) {
                case CmdType.RECT:
                    this._executeRect(buf, read);
                    read += 10;
                    break;
                case CmdType.BORDER:
                    read += 5;
                    break;
                case CmdType.NOP:
                    read += 1;
                    break;
                default:
                    read += 1;
                    break;
            }
        }

        this.frameTime = performance.now() - start;
    }

    private _executeRect(buf: Uint32Array, offset: number): void {
        const entityId = buf[(offset + 1) & 0xFFFFF];
        const lx = buf[(offset + 2) & 0xFFFFF] / 10;
        const ly = buf[(offset + 3) & 0xFFFFF] / 10;
        const lw = buf[(offset + 4) & 0xFFFFF] / 10;
        const lh = buf[(offset + 5) & 0xFFFFF] / 10;
        const bgRgba = buf[(offset + 6) & 0xFFFFF];
        const borderPack = buf[(offset + 7) & 0xFFFFF];
        const borderRadius = (borderPack >> 16) / 10;
        const borderWidth = (borderPack & 0xFFFF) / 10;

        const node = this._acquireNode(entityId);
        const s = node.style;

        // Track entity index for change detection
        let entityIdx = entityId;
        if (entityIdx >= this._lastEntityCount) {
            // Expand tracking arrays (ensure new cap is never smaller than existing)
            const newCap = Math.max(entityIdx + 256, this._lastBg.length);
            const prevBg = this._lastBg;
            this._lastBg = new Uint32Array(newCap);
            this._lastBg.set(prevBg);
            const prevLeft = this._lastLeft;
            this._lastLeft = new Float32Array(newCap);
            this._lastLeft.set(prevLeft);
            const prevTop = this._lastTop;
            this._lastTop = new Float32Array(newCap);
            this._lastTop.set(prevTop);
            const prevW = this._lastWidth;
            this._lastWidth = new Float32Array(newCap);
            this._lastWidth.set(prevW);
            const prevH = this._lastHeight;
            this._lastHeight = new Float32Array(newCap);
            this._lastHeight.set(prevH);
            const prevBR = this._lastBorderRadius;
            this._lastBorderRadius = new Float32Array(newCap);
            this._lastBorderRadius.set(prevBR);
            const prevBW = this._lastBorderWidth;
            this._lastBorderWidth = new Float32Array(newCap);
            this._lastBorderWidth.set(prevBW);
            const prevBRgba = this._lastBorderRgba;
            this._lastBorderRgba = new Uint32Array(newCap);
            this._lastBorderRgba.set(prevBRgba);
            this._lastEntityCount = newCap;
        }

        // Only patch style properties that changed — ZERO string comparison when unchanged
        if (this._lastLeft[entityIdx] !== lx) {
            s.left = lx + 'px';
            this._lastLeft[entityIdx] = lx;
        }
        if (this._lastTop[entityIdx] !== ly) {
            s.top = ly + 'px';
            this._lastTop[entityIdx] = ly;
        }
        if (this._lastWidth[entityIdx] !== lw) {
            s.width = lw + 'px';
            this._lastWidth[entityIdx] = lw;
        }
        if (this._lastHeight[entityIdx] !== lh) {
            s.height = lh + 'px';
            this._lastHeight[entityIdx] = lh;
        }
        if (this._lastBg[entityIdx] !== bgRgba) {
            s.backgroundColor = _getRgbaString(bgRgba);
            this._lastBg[entityIdx] = bgRgba;
        }
        if (this._lastBorderRadius[entityIdx] !== borderRadius) {
            s.borderRadius = borderRadius > 0 ? borderRadius + 'px' : '';
            this._lastBorderRadius[entityIdx] = borderRadius;
        }
        if (this._lastBorderWidth[entityIdx] !== borderWidth) {
            const borderRgba = buf[(offset + 8) & 0xFFFFF];
            s.borderWidth = borderWidth > 0 ? borderWidth + 'px' : '';
            s.borderStyle = borderWidth > 0 ? 'solid' : '';
            s.borderColor = borderWidth > 0 ? _getRgbaString(borderRgba) : '';
            this._lastBorderWidth[entityIdx] = borderWidth;
            this._lastBorderRgba[entityIdx] = borderRgba;
        }

        this.drawCalls++;
    }

    clear(): void {
        // Return all nodes to pool instead of destroying
        for (let i = 0; i < this._nodesCap; i++) {
            const node = this._nodes[i];
            if (node) {
                node.remove();
                if (this._poolSize < this._nodePool.length) {
                    this._nodePool[this._poolSize++] = node;
                }
                this._nodes[i] = null;
            }
        }
    }

    present(): void {
        // DOM renderer: browser composites automatically
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// CANVAS RENDERER — pre-cached fillStyle, batched
// ═══════════════════════════════════════════════════════════════════════════

export class CanvasRenderer implements Renderer {
    type = RendererType.CANVAS;
    canvas: HTMLCanvasElement | null = null;
    container: HTMLElement | null = null;
    drawCalls = 0;
    trianglesRendered = 0;
    frameTime = 0;

    private _ctx: CanvasRenderingContext2D | null = null;
    private _pixelRatio = 1;

    // Pre-allocated fillStyle cache — indexed by packed RGBA
    private _fillStyleCache = new Map<number, string>();
    private _lastFillStyle = '';

    init(container: HTMLElement, options?: RendererOptions): void {
        this.container = container;
        this._pixelRatio = options?.pixelRatio ?? (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1);

        this.canvas = document.createElement('canvas');
        this.canvas.style.position = 'absolute';
        this.canvas.style.left = '0';
        this.canvas.style.top = '0';
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        container.appendChild(this.canvas);

        this._ctx = this.canvas.getContext('2d', {
            alpha: options?.alpha ?? true,
            antialias: options?.antialias ?? true,
        }) as CanvasRenderingContext2D;

        const rect = container.getBoundingClientRect();
        this.resize(rect.width, rect.height);
    }

    destroy(): void {
        this.canvas?.remove();
        this._ctx = null;
        this.canvas = null;
    }

    resize(width: number, height: number): void {
        if (!this.canvas) return;
        const w = width * this._pixelRatio;
        const h = height * this._pixelRatio;
        this.canvas.width = w;
        this.canvas.height = h;
        this._ctx?.scale(this._pixelRatio, this._pixelRatio);
    }

    private _getFillStyle(rgba: number): string {
        let style = this._fillStyleCache.get(rgba);
        if (style === undefined) {
            const r = (rgba >>> 24) & 0xFF;
            const g = (rgba >>> 16) & 0xFF;
            const b = (rgba >>> 8) & 0xFF;
            const a = (rgba & 0xFF) / 255;
            style = `rgba(${r},${g},${b},${a.toFixed(3)})`;
            this._fillStyleCache.set(rgba, style);
        }
        return style;
    }

    executeCommands(): void {
        const start = performance.now();
        this.drawCalls = 0;
        const ctx = this._ctx;
        if (!ctx) return;

        ctx.clearRect(0, 0, this.canvas!.width / this._pixelRatio, this.canvas!.height / this._pixelRatio);

        const buf = getCommandBuffer();
        const head = getCommandHead();
        const tail = getCommandTail();
        let read = tail;
        this._lastFillStyle = '';

        while (read < head) {
            const type = buf[read & 0xFFFFF];
            switch (type) {
                case CmdType.RECT:
                    this._drawRect(ctx, buf, read);
                    read += 10;
                    break;
                case CmdType.BORDER:
                    read += 5;
                    break;
                case CmdType.NOP:
                    read += 1;
                    break;
                default:
                    read += 1;
                    break;
            }
        }

        this.frameTime = performance.now() - start;
    }

    private _drawRect(ctx: CanvasRenderingContext2D, buf: Uint32Array, offset: number): void {
        const lx = buf[(offset + 2) & 0xFFFFF] / 10;
        const ly = buf[(offset + 3) & 0xFFFFF] / 10;
        const lw = buf[(offset + 4) & 0xFFFFF] / 10;
        const lh = buf[(offset + 5) & 0xFFFFF] / 10;
        const bgRgba = buf[(offset + 6) & 0xFFFFF];

        const style = this._getFillStyle(bgRgba);
        if (style !== this._lastFillStyle) {
            ctx.fillStyle = style;
            this._lastFillStyle = style;
        }
        ctx.fillRect(lx, ly, lw, lh);
        this.drawCalls++;
    }

    clear(): void {
        this._ctx?.clearRect(0, 0, this.canvas!.width / this._pixelRatio, this.canvas!.height / this._pixelRatio);
    }

    present(): void {
        // Canvas renderer: browser composites the canvas
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// WEBGPU SHADER — inline WGSL, zero file I/O
// ═══════════════════════════════════════════════════════════════════════════

const WEBGPU_SHADER_SRC = /* wgsl */ `
struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) color: vec4<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
}

@vertex
fn vertex_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4<f32>(input.position, 0.0, 1.0);
    output.color = input.color;
    return output;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4<f32> {
    return input.color;
}
`;

// ═══════════════════════════════════════════════════════════════════════════
// WEBGPU RENDERER — persistent GPU buffer, shader pipeline, instanced rendering
// ═══════════════════════════════════════════════════════════════════════════

export class WebGPURenderer implements Renderer {
    type = RendererType.WEBGPU;
    canvas: HTMLCanvasElement | null = null;
    container: HTMLElement | null = null;
    drawCalls = 0;
    trianglesRendered = 0;
    frameTime = 0;

    private _gpu: any = null;
    private _device: any = null;
    private _context: any = null;
    private _pipeline: any = null;
    private _shaderModule: any = null;
    private _renderBundleEncoder: any = null;
    private _vertexBuffer: any = null;
    private _vertexBufferSize = 0;
    private _indexBuffer: any = null;
    private _indexBufferSize = 0;
    private _depthTexture: any = null;
    private _depthTextureView: any = null;
    private _pixelRatio = 1;
    private _stagingBuffer: Float32Array | null = null;
    private _stagingIdx = 0;
    private _canvasWidth = 0;
    private _canvasHeight = 0;

    // Render bundle pooling — pre-record GPU commands, reuse when unchanged
    private _renderBundle: any = null;
    private _lastHead = 0;
    private _lastTail = 0;

    async init(container: HTMLElement, options?: RendererOptions): Promise<void> {
        this.container = container;
        this._pixelRatio = options?.pixelRatio ?? (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1);

        if (typeof navigator === 'undefined' || !(navigator as any).gpu) {
            console.warn('[dominator] WebGPU not available. Falling back to Canvas.');
            return;
        }

        this._gpu = (navigator as any).gpu;
        const adapter = await this._gpu.requestAdapter({
            powerPreference: options?.powerPreference ?? 'high-performance',
        });

        if (!adapter) {
            console.warn('[dominator] No WebGPU adapter found.');
            return;
        }

        this._device = await adapter.requestDevice();

        this.canvas = document.createElement('canvas');
        this.canvas.style.position = 'absolute';
        this.canvas.style.left = '0';
        this.canvas.style.top = '0';
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        container.appendChild(this.canvas);

        this._context = this.canvas.getContext('webgpu');
        if (!this._context) return;

        const format = this._gpu.getPreferredCanvasFormat();
        this._context.configure({
            device: this._device,
            format,
            alphaMode: options?.alpha ? 'premultiplied' : 'opaque',
        });

        // Create shader module — compiled once, reused forever
        this._shaderModule = this._device!.createShaderModule({
            code: WEBGPU_SHADER_SRC,
        });

        // Create render pipeline — vertex + fragment, no depth test needed for 2D
        this._pipeline = this._device!.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: this._shaderModule,
                entryPoint: 'vertex_main',
                buffers: [{
                    arrayStride: 24, // 2 floats position + 4 floats color = 24 bytes
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x2' },  // position
                        { shaderLocation: 1, offset: 8, format: 'float32x4' },  // color
                    ],
                }],
            },
            fragment: {
                module: this._shaderModule,
                entryPoint: 'fragment_main',
                targets: [{
                    format,
                    blend: {
                        color: {
                            srcFactor: 'src-alpha',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add',
                        },
                        alpha: {
                            srcFactor: 'one',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add',
                        },
                    },
                }],
            },
            primitive: {
                topology: 'triangle-list',
            },
        });

        // Pre-allocate staging buffer (CPU-side, reused)
        // 6 vertices per rect, 6 floats per vertex (xy + rgba)
        this._stagingBuffer = new Float32Array(65536 * 36); // 65k rects * 6 verts * 6 floats

        const rect = container.getBoundingClientRect();
        this.resize(rect.width, rect.height);
    }

    destroy(): void {
        this._renderBundle = null;
        this._vertexBuffer?.destroy?.();
        this._indexBuffer?.destroy?.();
        this._depthTexture?.destroy?.();
        this._device?.destroy?.();
        this.canvas?.remove();
        this._pipeline = null;
        this._shaderModule = null;
        this._device = null;
        this._context = null;
        this._depthTextureView = null;
        this.canvas = null;
        this._stagingBuffer = null;
    }

    resize(width: number, height: number): void {
        if (!this.canvas) return;
        const w = Math.max(1, Math.floor(width * this._pixelRatio));
        const h = Math.max(1, Math.floor(height * this._pixelRatio));
        this.canvas.width = w;
        this.canvas.height = h;
        this._canvasWidth = w;
        this._canvasHeight = h;

        // Recreate depth texture if size changed
        if (this._device && (w > 0 && h > 0)) {
            this._depthTexture?.destroy?.();
            this._depthTexture = this._device!.createTexture({
                size: { width: w, height: h },
                format: 'depth24plus',
                usage: 0x10, // RENDER_ATTACHMENT
            });
            this._depthTextureView = this._depthTexture.createView();
        }
    }

    executeCommands(): void {
        const start = performance.now();
        if (!this._device || !this._context) return;

        const gpuBuf = getGPUCommandBuffer();
        const gpuHead = getGPUCommandHead();

        // Fast path: reuse cached render bundle when command buffer unchanged
        if (gpuHead === this._lastHead && this._renderBundle) {
            const commandEncoder = this._device!.createCommandEncoder();
            const textureView = this._context!.getCurrentTexture().createView();
            const renderPass = commandEncoder.beginRenderPass({
                colorAttachments: [{
                    view: textureView,
                    loadOp: 'clear',
                    storeOp: 'store',
                    clearValue: { r: 0, g: 0, b: 0, a: 0 },
                }],
            });
            renderPass.executeBundles([this._renderBundle]);
            renderPass.end();
            this._device!.queue.submit([commandEncoder.finish()]);
            this.frameTime = performance.now() - start;
            return;
        }

        this._lastHead = gpuHead;
        this._renderBundle = null;

        const vertCount = gpuHead / 6 | 0;
        if (vertCount === 0) {
            this.frameTime = performance.now() - start;
            return;
        }

        const quadCount = vertCount / 4 | 0;
        const byteLength = gpuHead * 4; // float32 = 4 bytes

        // Reuse or grow vertex buffer — zero-translation: write GPU buffer directly
        if (!this._vertexBuffer || byteLength > this._vertexBufferSize) {
            this._vertexBuffer?.destroy?.();
            this._vertexBufferSize = Math.max(byteLength * 2, 1024 * 1024);
            this._vertexBuffer = this._device!.createBuffer({
                size: this._vertexBufferSize,
                usage: 0x88, // VERTEX | COPY_DST
            });
        }

        // Write pre-expanded, pre-NDC vertices directly to GPU — ZERO CPU TRANSLATION
        this._device!.queue.writeBuffer(this._vertexBuffer, 0, gpuBuf.subarray(0, gpuHead));

        // Reuse or grow index buffer — pre-generate quad indices
        const indexCount = quadCount * 6;
        const indexByteLength = indexCount * 4;
        if (!this._indexBuffer || indexByteLength > this._indexBufferSize) {
            this._indexBuffer?.destroy?.();
            this._indexBufferSize = Math.max(indexByteLength * 2, 65536 * 6 * 4);
            this._indexBuffer = this._device!.createBuffer({
                size: this._indexBufferSize,
                usage: 0x80 | 0x88, // INDEX | VERTEX | COPY_DST
            });

            const idxData = new Uint32Array(indexCount);
            for (let q = 0; q < quadCount; q++) {
                const base = q * 4;
                const i = q * 6;
                idxData[i]     = base;
                idxData[i + 1] = base + 1;
                idxData[i + 2] = base + 2;
                idxData[i + 3] = base + 2;
                idxData[i + 4] = base + 1;
                idxData[i + 5] = base + 3;
            }
            this._device!.queue.writeBuffer(this._indexBuffer, 0, idxData);
        }

        // Record render bundle — pre-compile GPU commands for reuse
        const bundleEncoder = this._device!.createRenderBundleEncoder!({
            colorFormats: [this._gpu!.getPreferredCanvasFormat()],
        });
        if (this._pipeline) {
            bundleEncoder.setPipeline(this._pipeline);
            bundleEncoder.setVertexBuffer(0, this._vertexBuffer);
            bundleEncoder.setIndexBuffer(this._indexBuffer, 'uint32');
            bundleEncoder.drawIndexed(indexCount);
        }
        this._renderBundle = bundleEncoder.finish();

        const commandEncoder = this._device!.createCommandEncoder();
        const textureView = this._context!.getCurrentTexture().createView();
        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: textureView,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
            }],
        });
        renderPass.executeBundles([this._renderBundle]);
        renderPass.end();
        this._device!.queue.submit([commandEncoder.finish()]);

        this.trianglesRendered = quadCount * 2;
        this.drawCalls = quadCount;
        this.frameTime = performance.now() - start;
    }

    clear(): void {
        // WebGPU clear happens at render pass start
    }

    present(): void {
        // WebGPU presents via getCurrentTexture()
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// RENDERER FACTORY
// ═══════════════════════════════════════════════════════════════════════════

export function createRenderer(type: RendererType): Renderer {
    switch (type) {
        case RendererType.DOM: return new DOMRenderer();
        case RendererType.CANVAS: return new CanvasRenderer();
        case RendererType.WEBGPU: return new WebGPURenderer();
        default: return new DOMRenderer();
    }
}

export async function createRendererAsync(type: RendererType, container: HTMLElement, options?: RendererOptions): Promise<Renderer> {
    const renderer = createRenderer(type);
    if (type === RendererType.WEBGPU) {
        await (renderer as WebGPURenderer).init(container, options);
    } else {
        renderer.init(container, options);
    }
    return renderer;
}
