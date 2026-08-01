import { describe, it, expect, beforeEach } from 'vitest';
import {
    createEngineSync, destroyEngine, createEntity, setEntityStyle, tickEngine,
} from '../engine/engine';
import {
    createWorld, destroyWorld, spawn, despawn, setStyleFloat, setStyleColor,
    STYLE_X, STYLE_Y, STYLE_W, STYLE_H,
    getDirtyEntityCount, getDirtyEntities, clearDirtyFlags,
    getLayoutRect,
} from '../engine/ecs';

beforeEach(() => {
    destroyEngine();
    destroyWorld();
    createWorld();
});

describe('ECS dirty tracking', () => {
    it('spawn adds entity to the dirty list', () => {
        const id = spawn(0);
        expect(id).toBeGreaterThan(0);
        expect(getDirtyEntityCount()).toBeGreaterThan(0);
        expect(Array.from(getDirtyEntities())).toContain(id);
    });

    it('setStyleFloat flags NEEDS_PAINT and propagates to root', () => {
        const id = spawn(0);
        clearDirtyFlags();
        setStyleFloat(id, STYLE_X, 10);
        const dirty = Array.from(getDirtyEntities());
        expect(dirty).toContain(id);
        expect(dirty).toContain(0);
    });

    it('clearDirtyFlags resets the dirty list to zero', () => {
        spawn(0);
        spawn(0);
        expect(getDirtyEntityCount()).toBeGreaterThan(0);
        clearDirtyFlags();
        expect(getDirtyEntityCount()).toBe(0);
    });

    it('despawn marks the parent layout dirty', () => {
        const child = spawn(0);
        clearDirtyFlags();
        despawn(child);
        expect(Array.from(getDirtyEntities())).toContain(0);
    });
});

describe('engine frame pipeline', () => {
    it('default API lays out and paints entities in one frame', () => {
        const container = document.createElement('div');
        const engine = createEngineSync(container, { viewportWidth: 800, viewportHeight: 600 });

        const id = createEntity();
        setEntityStyle(id, { width: 100, height: 50, bgR: 255, bgG: 0, bgB: 0 });

        const stats = tickEngine();

        const rect = getLayoutRect(id);
        expect(rect.w).toBe(100);
        expect(rect.h).toBe(50);

        expect(engine.renderer.drawCalls).toBeGreaterThan(0);
        expect(stats.layoutNodes).toBeGreaterThan(0);
        expect(stats.paintNodes).toBeGreaterThan(0);
        expect(getDirtyEntityCount()).toBe(0);
    });

    it('style float changes repaint entities on the next frame', () => {
        const container = document.createElement('div');
        const engine = createEngineSync(container, { viewportWidth: 800, viewportHeight: 600 });

        const id = createEntity();
        setEntityStyle(id, { width: 100, height: 50, bgR: 255, bgG: 0, bgB: 0 });
        tickEngine();

        const drawCallsBefore = engine.renderer.drawCalls;
        setStyleFloat(id, STYLE_Y, 42);
        tickEngine();

        expect(engine.renderer.drawCalls).toBeGreaterThan(0);
        expect(engine.renderer.drawCalls).toBeGreaterThanOrEqual(drawCallsBefore);
        expect(getDirtyEntityCount()).toBe(0);
    });

    it('dirty list does not grow monotonically across frames', () => {
        const container = document.createElement('div');
        createEngineSync(container, { viewportWidth: 800, viewportHeight: 600 });

        for (let i = 0; i < 50; i++) createEntity();
        tickEngine();
        expect(getDirtyEntityCount()).toBe(0);

        setStyleFloat(1, STYLE_X, 5);
        expect(getDirtyEntityCount()).toBeGreaterThan(0);
        tickEngine();
        expect(getDirtyEntityCount()).toBe(0);
    });

    it('setStyleColor alone triggers a repaint without relayout churn', () => {
        const container = document.createElement('div');
        createEngineSync(container, { viewportWidth: 800, viewportHeight: 600 });

        const id = createEntity();
        setEntityStyle(id, { width: 50, height: 50, bgR: 10, bgG: 10, bgB: 10 });
        tickEngine();

        setStyleColor(id, 0, 200, 100, 50, 255);
        tickEngine();

        expect(getDirtyEntityCount()).toBe(0);
    });
});
