import { signal, Signal } from './signal';
import { removeAllEventListeners } from './events';

export const path: Signal<string> = signal(
    typeof window !== 'undefined' ? window.location.pathname : '/'
);

let _popstateHandler: (() => void) | null = null;

if (typeof window !== 'undefined') {
    _popstateHandler = () => {
        path.set(window.location.pathname);
    };
    window.addEventListener('popstate', _popstateHandler);
}

export function teardownRouter(): void {
    if (typeof window !== 'undefined' && _popstateHandler) {
        window.removeEventListener('popstate', _popstateHandler);
        _popstateHandler = null;
    }
}

export const navigate = (to: string): void => {
    if (typeof window !== 'undefined') {
        window.history.pushState({}, '', to);
    }
    path.set(to);
};

export interface Route {
    path: string;
    component: () => HTMLElement;
}

interface TrieNode {
    children: Map<string, TrieNode>;
    route: Route | null;
}

function _buildTrie(routes: Route[]): TrieNode {
    const root: TrieNode = { children: new Map(), route: null };

    for (const route of routes) {
        if (route.path === '*') continue;
        const segments = _splitSegments(route.path);
        let node = root;
        for (let i = 0; i < segments.length; i++) {
            let child = node.children.get(segments[i]!);
            if (!child) {
                child = { children: new Map(), route: null };
                node.children.set(segments[i]!, child);
            }
            node = child;
        }
        node.route = route;
    }

    return root;
}

function _matchTrie(root: TrieNode, pathname: string): Route | null {
    const segments = _splitSegments(pathname);
    let node = root;

    for (let i = 0; i < segments.length; i++) {
        const child = node.children.get(segments[i]!);
        if (!child) return null;
        node = child;
    }

    return node.route;
}

// Zero-allocation segment splitter: avoids split+filter on every call
function _splitSegments(path: string): string[] {
    const segments: string[] = [];
    let start = -1;
    for (let i = 0; i < path.length; i++) {
        if (path.charCodeAt(i) === 47) { // '/'
            if (start >= 0) {
                segments.push(path.substring(start, i));
                start = -1;
            }
        } else {
            if (start < 0) start = i;
        }
    }
    if (start >= 0) segments.push(path.substring(start));
    return segments;
}

export const createRouter = (routes: Route[]): { element: HTMLElement; destroy: () => void } => {
    const root = document.createElement('div');
    root.className = 'dominator-router';

    const trie = _buildTrie(routes);
    const wildcardRoute = routes.find((r) => r.path === '*') || null;

    let currentElement: HTMLElement | null = null;

    const resolve = (pathname: string): Route | null => {
        return _matchTrie(trie, pathname) || wildcardRoute;
    };

    const renderRoute = () => {
        const route = resolve(path.get());
        if (route) {
            const nextElement = route.component();
            if (currentElement) {
                removeAllEventListeners(currentElement);
                root.replaceChild(nextElement, currentElement);
            } else {
                root.appendChild(nextElement);
            }
            currentElement = nextElement;
        }
    };

    renderRoute();

    const unsub = path.subscribe(renderRoute);

    return {
        element: root,
        destroy: () => {
            unsub();
            if (currentElement) {
                removeAllEventListeners(currentElement);
                root.removeChild(currentElement);
                currentElement = null;
            }
        },
    };
};
