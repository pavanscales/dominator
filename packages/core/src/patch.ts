import { VNode, VNodeProps } from './vnode';
import { mount, _applyProps } from './mount';

const _isEventHandler = (key: string): boolean =>
    key.length > 2 && key.charCodeAt(0) === 111 && key.charCodeAt(1) === 110;

export const patch = (el: Node, oldVNode: VNode | string | null, newVNode: VNode | string | null): void => {
    if (oldVNode === newVNode) return;

    if (newVNode === null) {
        el.parentElement?.removeChild(el);
        return;
    }

    if (oldVNode === null || typeof oldVNode === 'string' || typeof newVNode === 'string') {
        if (oldVNode !== newVNode) {
            const newEl = mount(newVNode);
            el.parentElement?.replaceChild(newEl, el);
        }
        return;
    }

    if (oldVNode.tag !== newVNode.tag) {
        const newEl = mount(newVNode);
        el.parentElement?.replaceChild(newEl, el);
        return;
    }

    const domEl = el as HTMLElement;
    newVNode.el = domEl;

    const oldProps = oldVNode.props;
    const newProps = newVNode.props;

    if (newProps) {
        _applyProps(domEl, newProps, oldProps);
    }

    if (oldProps) {
        const oldKeys = Object.keys(oldProps);
        for (let i = 0; i < oldKeys.length; i++) {
            const key = oldKeys[i]!;
            if (!newProps || !(key in newProps)) {
                if (!_isEventHandler(key)) {
                    domEl.removeAttribute(key);
                }
            }
        }
    }

    patchChildren(domEl, oldVNode.children, newVNode.children);
};

function patchChildren(
    el: HTMLElement,
    oldCh: (VNode | string)[] | null,
    newCh: (VNode | string)[] | null
): void {
    const oLen = oldCh ? oldCh.length : 0;
    const nLen = newCh ? newCh.length : 0;
    const minLen = oLen < nLen ? oLen : nLen;

    for (let i = 0; i < minLen; i++) {
        patch(el.childNodes[i]!, oldCh![i], newCh![i]);
    }

    if (nLen > oLen) {
        const frag = document.createDocumentFragment();
        for (let i = oLen; i < nLen; i++) {
            frag.appendChild(mount(newCh![i]!));
        }
        el.appendChild(frag);
    } else if (oLen > nLen) {
        for (let i = oLen - 1; i >= nLen; i--) {
            el.removeChild(el.childNodes[i]!);
        }
    }
}
