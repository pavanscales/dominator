export type VNodeValue = string | number | boolean | null | undefined;

export type VNodeProps = Record<string, string | number | boolean | ((e: Event) => void) | undefined>;

export interface VNode {
    tag: string | null;
    props: VNodeProps | null;
    children: (VNode | string)[] | null;
    key: string | number | null;
    el: Node | null;
}

export const createVNode = (
    tag: string | null,
    props: VNodeProps | null = null,
    children: (VNode | string)[] | null = null,
    key: string | number | null = null
): VNode => ({
    tag,
    props,
    children,
    key,
    el: null,
});

const _textCache = new Map<string, Text>();
const TEXT_CACHE_MAX = 256;

export const createTextVNode = (text: string): Node => {
    if (text.length <= 32) {
        let cached = _textCache.get(text);
        if (cached) return cached.cloneNode(true);
        if (_textCache.size < TEXT_CACHE_MAX) {
            cached = document.createTextNode(text);
            _textCache.set(text, cached);
            return cached.cloneNode(true);
        }
    }
    return document.createTextNode(text);
};
