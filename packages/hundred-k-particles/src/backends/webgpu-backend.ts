// @ts-nocheck — WebGPU types unavailable; experimental file
/**
 * WEBGPU COMPUTE BACKEND — BARE METAL GPU PERFORMANCE
 * 
 * - 100K particles simulated in parallel on GPU compute shaders
 * - Double-buffered storage buffers for ping-pong simulation
 * - Single render pipeline draw call (instanced points)
 * - Uniform buffer for config (mouse, viewport, mode, time)
 * - Zero CPU physics after initialization
 */

import { registerBackend } from './worker-main.js';

const PARTICLE_COUNT = 100_000;
const WORKGROUP_SIZE = 256;
const DISPATCH_COUNT = Math.ceil(PARTICLE_COUNT / WORKGROUP_SIZE);
const SUBSTEPS = 2;
const FIXED_DT = 1 / 120;

// ┌─────────────────────────────────────────────────────────────────────────────
// WGSL SHADERS — Inlined for zero fetch overhead
// ┌─────────────────────────────────────────────────────────────────────────────

const COMPUTE_SHADER = `
struct Particle {
    position: vec2<f32>,
    velocity: vec2<f32>,
    target: vec2<f32>,
    color: vec4<f32>,
}

struct Uniforms {
    viewport_size: vec2<f32>,
    mouse_pos: vec2<f32>,
    mode: u32,
    particle_count: u32,
    dt: f32,
    substeps: u32,
    time: f32,
    explode: u32,
    _pad: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read_write> particles_in: array<Particle>;
@group(0) @binding(2) var<storage, read_write> particles_out: array<Particle>;

// Xorshift32 RNG
fn xorshift32(state: ptr<function, u32>) -> u32 {
    var x = *state;
    x ^= x << 13u;
    x ^= x >> 17u;
    x ^= x << 5u;
    *state = x;
    return x;
}

fn rand_f32(state: ptr<function, u32>) -> f32 {
    return f32(xorshift32(state) & 0x7FFFFFFFu) / 2147483647.0;
}

fn rand_vec2(state: ptr<function, u32>) -> vec2<f32> {
    return vec2<f32>(rand_f32(state) - 0.5, rand_f32(state) - 0.5);
}

const MOUSE_REPULSE_RADIUS: f32 = 500.0;
const MOUSE_REPULSE_RADIUS_SQ: f32 = 250000.0;
const FORM_SPRING: f32 = 0.05;
const FORM_DAMP: f32 = 0.85;
const CHAOS_BROWNIAN: f32 = 0.2;
const CHAOS_DAMP: f32 = 0.96;
const EXPLODE_FORCE: f32 = 50.0;
const REPULSE_FACTOR: f32 = 0.1;

@compute @workgroup_size(256)
fn physics_compute(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let i = global_id.x;
    if (i >= uniforms.particle_count) { return; }

    var rng_state = i + uniforms.particle_count * u32(uniforms.time * 1000.0);
    var p = particles_in[i];

    var sub = 0u;
    loop {
        if (sub >= uniforms.substeps) { break; }
        
        var pos = p.position;
        var vel = p.velocity;

        if (uniforms.mode == 1u) {
            // FORM MODE
            let dx = p.target.x - pos.x;
            let dy = p.target.y - pos.y;
            vel.x += dx * FORM_SPRING;
            vel.y += dy * FORM_SPRING;
            vel *= FORM_DAMP;
            pos += vel * uniforms.dt * 60.0;
        } else {
            // CHAOS MODE
            let dx = uniforms.mouse_pos.x - pos.x;
            let dy = uniforms.mouse_pos.y - pos.y;
            let dist_sq = dx * dx + dy * dy;

            if (dist_sq < MOUSE_REPULSE_RADIUS_SQ && dist_sq > 0.001) {
                let dist = sqrt(dist_sq);
                let force = (MOUSE_REPULSE_RADIUS - dist) / MOUSE_REPULSE_RADIUS;
                vel.x -= dx * force * REPULSE_FACTOR;
                vel.y -= dy * force * REPULSE_FACTOR;
            }

            vel += rand_vec2(&rng_state) * CHAOS_BROWNIAN;
            vel *= CHAOS_DAMP;
            pos += vel * uniforms.dt * 60.0;

            // Branchless toroidal wrapping
            pos.x = select(pos.x, pos.x - uniforms.viewport_size.x, pos.x > uniforms.viewport_size.x);
            pos.x = select(pos.x, pos.x + uniforms.viewport_size.x, pos.x < 0.0);
            pos.y = select(pos.y, pos.y - uniforms.viewport_size.y, pos.y > uniforms.viewport_size.y);
            pos.y = select(pos.y, pos.y + uniforms.viewport_size.y, pos.y < 0.0);
        }

        p.position = pos;
        p.velocity = vel;
        sub += 1u;
    }

    // Color computation
    if (uniforms.mode == 1u) {
        p.color = vec4<f32>(0.0, 1.0, 1.0, 0.9);
    } else {
        let dx = uniforms.mouse_pos.x - p.position.x;
        let dy = uniforms.mouse_pos.y - p.position.y;
        let dist_sq = dx * dx + dy * dy;
        
        if (dist_sq < MOUSE_REPULSE_RADIUS_SQ) {
            p.color = vec4<f32>(1.0, 0.2, 0.1, 0.95);
        } else {
            p.color = vec4<f32>(0.0, 0.7, 1.0, 0.7);
        }
    }

    if (uniforms.explode == 1u) {
        p.velocity += rand_vec2(&rng_state) * EXPLODE_FORCE;
    }

    particles_out[i] = p;
}

@compute @workgroup_size(256)
fn init_compute(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let i = global_id.x;
    if (i >= uniforms.particle_count) { return; }

    var rng_state = i + 123456789u;
    
    let pos = vec2<f32>(
        rand_f32(&rng_state) * uniforms.viewport_size.x,
        rand_f32(&rng_state) * uniforms.viewport_size.y
    );
    
    let vel = rand_vec2(&rng_state) * 5.0;
    
    particles_out[i] = Particle(pos, vel, vec2<f32>(0.0, 0.0), vec4<f32>(0.0, 0.7, 1.0, 0.7));
}

@compute @workgroup_size(256)
fn set_targets_compute(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let i = global_id.x;
    if (i >= uniforms.particle_count) { return; }
    
    @group(0) @binding(3) var<storage, read> targets: array<vec2<f32>>;
    let target_idx = i % arrayLength(&targets);
    particles_out[i].target = targets[target_idx];
}

@compute @workgroup_size(256)
fn explode_compute(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let i = global_id.x;
    if (i >= uniforms.particle_count) { return; }
    
    var rng_state = i + 987654321u;
    particles_out[i].velocity += rand_vec2(&rng_state) * EXPLODE_FORCE;
}
`;

const RENDER_SHADER = `
struct Uniforms {
    viewport_size: vec2<f32>,
    _pad: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;

struct Particle {
    position: vec2<f32>,
    velocity: vec2<f32>,
    target: vec2<f32>,
    color: vec4<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) size: f32,
}

@vertex
fn vs_main(@builtin(instance_index) instance_idx: u32) -> VertexOutput {
    let p = particles[instance_idx];
    let ndc = vec2<f32>(
        (p.position.x / uniforms.viewport_size.x) * 2.0 - 1.0,
        1.0 - (p.position.y / uniforms.viewport_size.y) * 2.0
    );
    
    var out: VertexOutput;
    out.position = vec4<f32>(ndc, 0.0, 1.0);
    out.color = p.color;
    out.size = 2.0;
    return out;
}

@fragment
fn fs_main(@location(0) color: vec4<f32>, @location(1) size: f32) -> @location(0) vec4<f32> {
    let dist = length(gl_FragCoord.xy - vec2<f32>(size * 0.5));
    let alpha = smoothstep(size * 0.5, 0.0, dist) * color.a;
    return vec4<f32>(color.rgb, alpha);
}
`;

// ┌─────────────────────────────────────────────────────────────────────────────
// WEBGPU BACKEND IMPLEMENTATION
// ┌─────────────────────────────────────────────────────────────────────────────

class WebGPUBackend {
    readonly name = 'WebGPU Compute';
    readonly isGPU = true;

    private device: GPUDevice | null = null;
    private context: GPUCanvasContext | null = null;
    private canvas: OffscreenCanvas | null = null;
    
    private computePipeline: GPUComputePipeline | null = null;
    private initPipeline: GPUComputePipeline | null = null;
    private targetsPipeline: GPUComputePipeline | null = null;
    private explodePipeline: GPUComputePipeline | null = null;
    private renderPipeline: GPURenderPipeline | null = null;
    
    private particlesBufferA: GPUBuffer | null = null;
    private particlesBufferB: GPUBuffer | null = null;
    private currentParticlesBuffer: GPUBuffer | null = null;
    private nextParticlesBuffer: GPUBuffer | null = null;
    
    private uniformBuffer: GPUBuffer | null = null;
    private uniformValues: Float32Array;
    private uniformUint32: Uint32Array;
    
    private targetsBuffer: GPUBuffer | null = null;
    private bindGroupLayout: GPUBindGroupLayout | null = null;
    private bindGroupA: GPUBindGroup | null = null;
    private bindGroupB: GPUBindGroup | null = null;
    private renderBindGroup: GPUBindGroup | null = null;
    
    private particleCount = PARTICLE_COUNT;
    private time = 0;
    private explodeTrigger = 0;
    
    private stats = {
        fps: 0,
        physicsTime: 0,
        renderTime: 0,
        totalTime: 0,
    };

    async isAvailable(): Promise<boolean> {
        if (!('gpu' in navigator)) return false;
        const adapter = await (navigator as any).gpu?.requestAdapter();
        if (!adapter) return false;
        const device = await adapter.requestDevice();
        return !!device;
    }

    async init(canvas: OffscreenCanvas, config: any): Promise<void> {
        this.canvas = canvas;
        this.particleCount = config.particleCount;
        
        // Request WebGPU device
        const adapter = await (navigator as any).gpu.requestAdapter({
            powerPreference: 'high-performance',
        });
        this.device = await adapter.requestDevice({
            requiredFeatures: ['shader-f16'], // Optional but nice
        });
        
        // Setup canvas context
        this.context = canvas.getContext('webgpu') as GPUCanvasContext;
        const format = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({
            device: this.device,
            format,
            alphaMode: 'opaque',
        });
        
        // Create shaders
        const computeShaderModule = this.device.createShaderModule({
            code: COMPUTE_SHADER,
        });
        
        const renderShaderModule = this.device.createShaderModule({
            code: RENDER_SHADER,
        });
        
        // Create buffers
        await this.createBuffers();
        
        // Create bind group layout
        this.bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            ],
        });
        
        // Create pipelines
        this.computePipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
            compute: { module: computeShaderModule, entryPoint: 'physics_compute' },
        });
        
        this.initPipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
            compute: { module: computeShaderModule, entryPoint: 'init_compute' },
        });
        
        this.targetsPipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
            compute: { module: computeShaderModule, entryPoint: 'set_targets_compute' },
        });
        
        this.explodePipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
            compute: { module: computeShaderModule, entryPoint: 'explode_compute' },
        });
        
        // Render pipeline
        this.renderPipeline = this.device.createRenderPipeline({
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
            vertex: {
                module: renderShaderModule,
                entryPoint: 'vs_main',
            },
            fragment: {
                module: renderShaderModule,
                entryPoint: 'fs_main',
                targets: [{ format, blend: { 
                    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }
                }}],
            },
            primitive: {
                topology: 'point-list',
            },
        });
        
        // Create bind groups
        this.createBindGroups();
        
        // Initialize particles
        await this.initializeParticles();
        
        // Setup uniform values
        this.uniformValues = new Float32Array(16); // 256 bytes
        this.uniformUint32 = new Uint32Array(this.uniformValues.buffer);
        
        this.updateUniforms(config.width, config.height);
    }

    private async createBuffers(): Promise<void> {
        const particleStride = 8 * 4; // 8 floats * 4 bytes = 32 bytes per particle
        const bufferSize = this.particleCount * particleStride;
        
        this.particlesBufferA = this.device!.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
        
        this.particlesBufferB = this.device!.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
        
        this.currentParticlesBuffer = this.particlesBufferA;
        this.nextParticlesBuffer = this.particlesBufferB;
        
        // Uniform buffer (256 bytes = 4 cache lines)
        this.uniformBuffer = this.device!.createBuffer({
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        
        // Targets buffer for form mode
        this.targetsBuffer = this.device!.createBuffer({
            size: this.particleCount * 8, // vec2<f32> = 8 bytes
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
    }

    private createBindGroups(): void {
        this.bindGroupA = this.device!.createBindGroup({
            layout: this.bindGroupLayout!,
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer! } },
                { binding: 1, resource: { buffer: this.particlesBufferA! } },
                { binding: 2, resource: { buffer: this.particlesBufferB! } },
                { binding: 3, resource: { buffer: this.targetsBuffer! } },
            ],
        });
        
        this.bindGroupB = this.device!.createBindGroup({
            layout: this.bindGroupLayout!,
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer! } },
                { binding: 1, resource: { buffer: this.particlesBufferB! } },
                { binding: 2, resource: { buffer: this.particlesBufferA! } },
                { binding: 3, resource: { buffer: this.targetsBuffer! } },
            ],
        });
        
        // Render bind group uses current particles buffer
        this.renderBindGroup = this.device!.createBindGroup({
            layout: this.bindGroupLayout!,
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer! } },
                { binding: 1, resource: { buffer: this.currentParticlesBuffer! } },
                { binding: 2, resource: { buffer: this.nextParticlesBuffer! } },
                { binding: 3, resource: { buffer: this.targetsBuffer! } },
            ],
        });
    }

    private async initializeParticles(): Promise<void> {
        const commandEncoder = this.device!.createCommandEncoder();
        const pass = commandEncoder.beginComputePass();
        pass.setPipeline(this.initPipeline!);
        pass.setBindGroup(0, this.bindGroupA!);
        pass.dispatchWorkgroups(DISPATCH_COUNT);
        pass.end();
        this.device!.queue.submit([commandEncoder.finish()]);
        await this.device!.queue.onSubmittedWorkDone();
    }

    private updateUniforms(width: number, height: number): void {
        this.uniformValues[0] = width;
        this.uniformValues[1] = height;
        this.uniformValues[2] = 0; // mouse_x
        this.uniformValues[3] = 0; // mouse_y
        this.uniformUint32[4] = 0; // mode
        this.uniformUint32[5] = this.particleCount;
        this.uniformValues[6] = FIXED_DT;
        this.uniformUint32[7] = SUBSTEPS;
        this.uniformValues[8] = this.time;
        this.uniformUint32[9] = 0; // explode
        // padding at 10, 11
    }

    step(deltaTime: number): void {
        const frameStart = performance.now();
        this.time += deltaTime;
        
        // Update uniforms
        this.uniformValues[2] = this.mouseX;
        this.uniformValues[3] = this.mouseY;
        this.uniformUint32[4] = this.mode;
        this.uniformValues[8] = this.time;
        this.uniformUint32[9] = this.explodeTrigger;
        this.explodeTrigger = 0;
        
        this.device!.queue.writeBuffer(this.uniformBuffer!, 0, this.uniformValues);
        
        // Physics compute pass
        const physicsStart = performance.now();
        const commandEncoder = this.device!.createCommandEncoder();
        
        // Swap buffers
        [this.currentParticlesBuffer, this.nextParticlesBuffer] = [this.nextParticlesBuffer, this.currentParticlesBuffer];
        [this.bindGroupA, this.bindGroupB] = [this.bindGroupB, this.bindGroupA];
        
        // Update render bind group to use current buffer
        this.renderBindGroup = this.device!.createBindGroup({
            layout: this.bindGroupLayout!,
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer! } },
                { binding: 1, resource: { buffer: this.currentParticlesBuffer! } },
                { binding: 2, resource: { buffer: this.nextParticlesBuffer! } },
                { binding: 3, resource: { buffer: this.targetsBuffer! } },
            ],
        });
        
        const computePass = commandEncoder.beginComputePass();
        computePass.setPipeline(this.computePipeline!);
        computePass.setBindGroup(0, this.bindGroupA!);
        computePass.dispatchWorkgroups(DISPATCH_COUNT);
        computePass.end();
        
        this.stats.physicsTime = performance.now() - physicsStart;
        
        // Render pass
        const renderStart = performance.now();
        const renderPassDesc: GPURenderPassDescriptor = {
            colorAttachments: [{
                view: this.context!.getCurrentTexture().createView(),
                clearValue: { r: 0.04, g: 0.04, b: 0.06, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
        };
        
        const renderPass = commandEncoder.beginRenderPass(renderPassDesc);
        renderPass.setPipeline(this.renderPipeline!);
        renderPass.setBindGroup(0, this.renderBindGroup!);
        renderPass.draw(1, this.particleCount, 0, 0);
        renderPass.end();
        
        this.device!.queue.submit([commandEncoder.finish()]);
        this.stats.renderTime = performance.now() - renderStart;
        this.stats.totalTime = performance.now() - frameStart;
    }

    private mouseX = 0;
    private mouseY = 0;
    private mode = 0;

    setMouse(x: number, y: number): void {
        this.mouseX = x;
        this.mouseY = y;
    }

    setMode(mode: number): void {
        this.mode = mode;
        if (mode === 1) {
            this.setFormTargets();
        }
    }

    setViewport(width: number, height: number): void {
        this.canvas!.width = width;
        this.canvas!.height = height;
        this.uniformValues[0] = width;
        this.uniformValues[1] = height;
        this.device!.queue.writeBuffer(this.uniformBuffer!, 0, this.uniformValues);
    }

    explode(): void {
        this.explodeTrigger = 1;
    }

    private async setFormTargets(): Promise<void> {
        // Generate form targets on CPU and upload
        const targets = new Float32Array(this.particleCount * 2);
        // Simple circle formation
        for (let i = 0; i < this.particleCount; i++) {
            const angle = (i / this.particleCount) * Math.PI * 2;
            const radius = 200 + Math.sin(this.time * 2) * 50;
            targets[i * 2] = this.uniformValues[0] * 0.5 + Math.cos(angle) * radius;
            targets[i * 2 + 1] = this.uniformValues[1] * 0.5 + Math.sin(angle) * radius;
        }
        
        this.device!.queue.writeBuffer(this.targetsBuffer!, 0, targets);
        
        // Run targets compute shader
        const commandEncoder = this.device!.createCommandEncoder();
        const pass = commandEncoder.beginComputePass();
        pass.setPipeline(this.targetsPipeline!);
        pass.setBindGroup(0, this.bindGroupA!);
        pass.dispatchWorkgroups(DISPATCH_COUNT);
        pass.end();
        this.device!.queue.submit([commandEncoder.finish()]);
    }

    getStats() {
        return {
            fps: this.stats.fps,
            physicsTime: this.stats.physicsTime,
            renderTime: this.stats.renderTime,
            totalTime: this.stats.totalTime,
            backend: this.name,
        };
    }

    destroy(): void {
        this.particlesBufferA?.destroy();
        this.particlesBufferB?.destroy();
        this.uniformBuffer?.destroy();
        this.targetsBuffer?.destroy();
    }
}

registerBackend('webgpu-compute', () => new WebGPUBackend());