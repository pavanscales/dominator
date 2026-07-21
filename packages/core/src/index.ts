export { signal, effect, computed, batch, flushSync, _resetSignals, getSignalCount, getEffectCount } from './signal';
export type { Signal, EffectScope } from './signal';
export { setupDelegation, addEventListener, removeEventListener, removeAllEventListeners } from './events';
export type { VNode, VNodeProps, VNodeValue } from './vnode';
export { createVNode, createTextVNode } from './vnode';
export { mount } from './mount';
export { patch } from './patch';
export { Pool } from './pool';
export type { ReconcileItem } from './reconcile';
export { reconcile } from './reconcile';
export { path, navigate, createRouter } from './router';
export type { Route } from './router';
export { renderToString } from './ssr';
export type { SSRInstruction } from './ssr';

export interface DominatorApp<T> {
    state: T;
    render: (state: T) => void;
}

export const createApp = <T>(initialState: T, renderFn: (state: T) => void): DominatorApp<T> => ({
    state: initialState,
    render: renderFn,
});
