import { VNode, VNodeProps } from './vnode';
import { addEventListener } from './events';

const _isEventHandler = (key: string): boolean =>
    key.length > 2 && key.charCodeAt(0) === 111 && key.charCodeAt(1) === 110;

export const mount = (vnode: VNode | string): Node => {
    if (typeof vnode === 'string') {
        return document.createTextNode(vnode);
    }

    const el = document.createElement(vnode.tag!);
    vnode.el = el;

    const props = vnode.props;
    if (props) {
        _applyProps(el, props, null);
    }

    const children = vnode.children;
    if (children) {
        for (let i = 0; i < children.length; i++) {
            el.appendChild(mount(children[i]!));
        }
    }

    return el;
};

export const _applyProps = (el: HTMLElement, props: VNodeProps, prev: VNodeProps | null): void => {
    const keys = Object.keys(props);
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;
        const val = props[key];
        const oldVal = prev ? prev[key] : undefined;
        if (val === oldVal) continue;

        if (_isEventHandler(key)) {
            const eventName = key.slice(2).toLowerCase();
            if (typeof val === 'function') {
                addEventListener(el, eventName, val);
            }
        } else if (typeof val === 'string') {
            el.setAttribute(key, val);
        } else if (typeof val === 'number' || typeof val === 'boolean') {
            el.setAttribute(key, String(val));
        } else if (val === undefined) {
            el.removeAttribute(key);
        }
    }
};
