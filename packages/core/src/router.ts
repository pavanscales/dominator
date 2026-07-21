import { signal, Signal } from './signal';

export const path: Signal<string> = signal(
    typeof window !== 'undefined' ? window.location.pathname : '/'
);

if (typeof window !== 'undefined') {
    window.addEventListener('popstate', () => {
        path.set(window.location.pathname);
    });
}

export const navigate = (to: string): void => {
    window.history.pushState({}, '', to);
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
        const segments = route.path.split('/').filter(Boolean);
        let node = root;
        for (const seg of segments) {
            let child = node.children.get(seg);
            if (!child) {
                child = { children: new Map(), route: null };
                node.children.set(seg, child);
            }
            node = child;
        }
        node.route = route;
    }

    return root;
}

function _matchTrie(root: TrieNode, pathname: string): Route | null {
    const segments = pathname.split('/').filter(Boolean);
    let node = root;

    for (const seg of segments) {
        const child = node.children.get(seg);
        if (!child) return null;
        node = child;
    }

    return node.route;
}

export const createRouter = (routes: Route[]): HTMLElement => {
    const root = document.createElement('div');
    root.className = 'dominator-router';

    const trie = _buildTrie(routes);
    const wildcardRoute = routes.find((r) => r.path === '*') || null;

    let currentElement: HTMLElement | null = null;

    const resolve = (pathname: string): Route | null => {
        return _matchTrie(trie, pathname) || wildcardRoute;
    };

    path.subscribe(() => {
        const route = resolve(path.get());
        if (route) {
            const nextElement = route.component();
            if (currentElement) {
                root.replaceChild(nextElement, currentElement);
            } else {
                root.appendChild(nextElement);
            }
            currentElement = nextElement;
        }
    });

    const initialRoute = resolve(path.get());
    if (initialRoute) {
        currentElement = initialRoute.component();
        root.appendChild(currentElement);
    }

    return root;
};
