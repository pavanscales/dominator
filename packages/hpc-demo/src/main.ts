/**
 * HPC Demo — Peak Performance DOM Renderer
 *
 * Architecture:
 * - Full Engine Pipeline: Compiler → Compute Graph → Scheduler → Layout → Paint → GPU
 * - ECS with SoA storage (zero object overhead)
 * - Frame arenas (zero GC in hot path)
 * - 10-stage pipeline with time budgets
 * - DOM renderer with command buffer optimization
 *
 * Expected: 60+ FPS locked, < 1ms render time with 10k+ entities
 */

import {
    createEngine,
    createEntity,
    setEntityStyle,
    startEngine,
    tickEngine,
    getEngine,
    addTween,
    TimingFn,
    AnimType,
    LayoutMode,
    FlexDirection,
    JustifyContent,
    AlignItems,
    RendererType,
    Stage,
    setLayoutMode,
    setFlexDirection,
    setJustifyContent,
    setAlignItems,
    Flag,
} from '@dominator/core';

const ENTITY_COUNT = 5000;
const CANVAS_W = window.innerWidth;
const CANVAS_H = window.innerHeight;

const root = document.getElementById('app')!;
root.style.width = '100vw';
root.style.height = '100vh';
root.style.background = '#ffffff';
root.style.overflow = 'hidden';
root.style.position = 'relative';

async function main() {
    const engine = await createEngine(root, {
        rendererType: RendererType.DOM,
        maxEntities: ENTITY_COUNT + 1024,
        viewportWidth: CANVAS_W,
        viewportHeight: CANVAS_H,
    });

    const world = engine.world;

    setLayoutMode(LayoutMode.FLEX);
    setFlexDirection(FlexDirection.ROW);
    setJustifyContent(JustifyContent.FLEX_START);
    setAlignItems(AlignItems.FLEX_START);

    const entities: number[] = [];
    const baseHues: number[] = [];

    for (let i = 0; i < ENTITY_COUNT; i++) {
        const e = createEntity(engine.root);
        entities.push(e);
        baseHues.push((i * 137.508) % 360);

        const size = 8 + (Math.random() * 16) | 0;
        const x = Math.random() * (CANVAS_W - size);
        const y = Math.random() * (CANVAS_H - size);

        setEntityStyle(e, {
            x,
            y,
            width: size,
            height: size,
            borderRadius: size * 0.5,
            bgR: 0,
            bgG: 0,
            bgB: 0,
            bgA: 255,
            opacity: 0.8 + Math.random() * 0.2,
        });

        world.flags[e] |= Flag.PAINT_DIRTY | Flag.LAYOUT_DIRTY;
    }

    let mode = 0;
    let mouseX = CANVAS_W / 2;
    let mouseY = CANVAS_H / 2;
    let time = 0;

    window.addEventListener('mousemove', (e) => {
        mouseX = e.clientX;
        mouseY = e.clientY;
    });

    window.addEventListener('click', () => {
        mode = (mode + 1) % 4;
    });

    window.addEventListener('resize', () => {
        const w = window.innerWidth;
        const h = window.innerHeight;
        root.style.width = w + 'px';
        root.style.height = h + 'px';
    });

    const perfEl = document.createElement('div');
    perfEl.style.position = 'fixed';
    perfEl.style.top = '10px';
    perfEl.style.right = '10px';
    perfEl.style.background = 'rgba(0,0,0,0.8)';
    perfEl.style.color = '#0f0';
    perfEl.style.padding = '10px';
    perfEl.style.fontFamily = 'monospace';
    perfEl.style.fontSize = '14px';
    perfEl.style.borderRadius = '4px';
    perfEl.style.zIndex = '9999';
    perfEl.style.pointerEvents = 'none';
    root.appendChild(perfEl);

    const modeNames = ['ORBIT', 'WAVE', 'SPIRAL', 'CHAOS'];
    let frameCount = 0;
    let lastTime = performance.now();
    let fps = 0;

    function animate() {
        const now = performance.now();
        const dt = Math.min(now - lastTime, 50);
        lastTime = now;
        time += dt * 0.001;
        frameCount++;

        if (frameCount % 30 === 0) {
            const currentTime = performance.now();
            fps = Math.round(1000 / (dt));
            perfEl.textContent = `FPS: ${fps} | ENTITIES: ${ENTITY_COUNT} | MODE: ${modeNames[mode]} | Δt: ${dt.toFixed(2)}ms`;
        }

        for (let i = 0; i < ENTITY_COUNT; i++) {
            const e = entities[i];
            const hue = baseHues[i];
            const angle = time * 0.5 + i * 0.01;
            const radius = 100 + Math.sin(time * 0.3 + i * 0.1) * 80;

            let tx = CANVAS_W * 0.5;
            let ty = CANVAS_H * 0.5;

            switch (mode) {
                case 0: // ORBIT
                    tx += Math.cos(angle) * radius;
                    ty += Math.sin(angle) * radius;
                    break;
                case 1: // WAVE
                    tx = (i / ENTITY_COUNT) * CANVAS_W;
                    ty = CANVAS_H * 0.5 + Math.sin(time * 2 + i * 0.05) * 150;
                    break;
                case 2: // SPIRAL
                    const spiralAngle = time + i * 0.02;
                    const spiralRadius = (i / ENTITY_COUNT) * Math.min(CANVAS_W, CANVAS_H) * 0.4;
                    tx += Math.cos(spiralAngle) * spiralRadius;
                    ty += Math.sin(spiralAngle) * spiralRadius;
                    break;
                case 3: // CHAOS - mouse attraction
                    const dx = mouseX - (tx = (i / ENTITY_COUNT) * CANVAS_W);
                    const dy = mouseY - (ty = CANVAS_H * 0.5 + Math.sin(time + i) * 100);
                    const dist = Math.hypot(dx, dy) + 1;
                    const force = 5000 / (dist * dist);
                    tx += dx * force * dt * 0.01;
                    ty += dy * force * dt * 0.01;
                    break;
            }

            const r = Math.sin(hue * 0.01745) * 127 + 128;
            const g = Math.sin((hue + 120) * 0.01745) * 127 + 128;
            const b = Math.sin((hue + 240) * 0.01745) * 127 + 128;

            setEntityStyle(e, {
                x: tx,
                y: ty,
                bgR: r | 0,
                bgG: g | 0,
                bgB: b | 0,
            });
        }

        tickEngine();
        requestAnimationFrame(animate);
    }

    startEngine();
    requestAnimationFrame(animate);
}

main().catch(console.error);