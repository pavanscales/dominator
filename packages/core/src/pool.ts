export class Pool<T> {
    private _buf: (T | null)[];
    private _mask: number;
    private _head = 0;
    private _count = 0;

    constructor(
        private _factory: () => T,
        private _reset: (obj: T) => void,
        capacity = 1024
    ) {
        let cap = 1;
        while (cap < capacity) cap <<= 1;
        this._buf = new Array(cap);
        this._mask = cap - 1;
    }

    get(): T {
        if (this._count > 0) {
            this._head = (this._head - 1) & this._mask;
            const obj = this._buf[this._head] as T;
            this._buf[this._head] = null;
            this._count--;
            return obj;
        }
        return this._factory();
    }

    release(obj: T): void {
        if (this._count < this._buf.length) {
            this._reset(obj);
            this._buf[this._head] = obj;
            this._head = (this._head + 1) & this._mask;
            this._count++;
        }
    }

    get size(): number {
        return this._count;
    }

    clear(): void {
        for (let i = 0; i < this._buf.length; i++) {
            this._buf[i] = null;
        }
        this._head = 0;
        this._count = 0;
    }
}

import { VNode } from './vnode';

export const vnodePool = new Pool<VNode>(
    () => ({ tag: null, props: null, children: null, key: null, el: null }),
    (v) => {
        v.tag = null;
        v.props = null;
        v.children = null;
        v.key = null;
        v.el = null;
    }
);
