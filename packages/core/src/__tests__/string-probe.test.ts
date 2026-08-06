import { it, expect, beforeEach } from 'vitest';
import { signal, effect, _resetSignals } from '../signal';
import { _getStrWriteOffset } from '../wasm-glue';
import { arenaSize } from '../arena';

beforeEach(() => {
    _resetSignals();
});

it('PROBE: first string signal offsets', () => {
    console.log('offset-before:', _getStrWriteOffset(), 'arenaSize-before:', arenaSize());
    const s = signal('hello');
    console.log('offset-after:', _getStrWriteOffset(), 'arenaSize-after:', arenaSize());
    expect(s()).toBe('hello');
});

it('PROBE: number signal then string signal offsets', () => {
    const n = signal(0);
    console.log('num-alloc offset:', _getStrWriteOffset(), 'arenaSize:', arenaSize());
    console.log('before-str offset:', _getStrWriteOffset(), 'arenaSize:', arenaSize());
    const s = signal('hello');
    console.log('after-str offset:', _getStrWriteOffset(), 'arenaSize:', arenaSize());
    expect(s()).toBe('hello');
});

it('PROBE: string created inside a running effect', () => {
    const n = signal(0);
    console.log('before-effect-str offset:', _getStrWriteOffset(), 'arenaSize:', arenaSize());
    let inside = '';
    effect(() => {
        const inner = signal('hello');
        inside = inner();
    });
    console.log('after-effect-str offset:', _getStrWriteOffset(), 'arenaSize:', arenaSize());
    expect(inside).toBe('hello');
});
