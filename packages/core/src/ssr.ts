export interface SSRInstruction {
    type: 'create' | 'attr' | 'append' | 'text';
    tag?: string;
    id: string;
    name?: string;
    value?: string;
    target?: string;
    parent?: string;
}

interface SSRNode {
    tag: string;
    attrs: Record<string, string>;
    children: string[];
    text: string;
}

const _escapeChars = new Map<number, string>([
    [38, '&amp;'],
    [60, '&lt;'],
    [62, '&gt;'],
    [34, '&quot;'],
    [39, '&#39;'],
]);

const _escapeHtml = (str: string): string => {
    let out = '';
    let last = 0;
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        const escaped = _escapeChars.get(code);
        if (escaped !== undefined) {
            if (i > last) out += str.substring(last, i);
            out += escaped;
            last = i + 1;
        }
    }
    return last === 0 ? str : (last < str.length ? out + str.substring(last) : out);
};

export const renderToString = (instructions: SSRInstruction[]): string => {
    const nodeCount = instructions.length;
    const nodes = new Map<string, SSRNode>();
    let rootId: string | null = null;

    for (let i = 0; i < nodeCount; i++) {
        const inst = instructions[i]!;
        const t = inst.type;
        if (t === 'create') {
            nodes.set(inst.id, { tag: inst.tag!, attrs: {}, children: [], text: '' });
            if (!rootId) rootId = inst.id;
        } else if (t === 'attr') {
            const node = nodes.get(inst.target!);
            if (node) node.attrs[inst.name!] = inst.value!;
        } else if (t === 'append') {
            const parent = nodes.get(inst.parent!);
            if (parent) parent.children.push(inst.id);
        } else if (t === 'text') {
            nodes.set(inst.id, { tag: 'text', attrs: {}, children: [], text: inst.value || '' });
        }
    }

    if (!rootId) return '';

    // Pre-allocate output buffer estimate
    const estimatedSize = nodeCount * 64;
    const parts: string[] = new Array(Math.min(estimatedSize, 4096));
    let partCount = 0;

    const push = (s: string): void => {
        if (partCount < parts.length) {
            parts[partCount++] = s;
        } else {
            parts.push(s);
            partCount = parts.length;
        }
    };

    const stack: { id: string; phase: number }[] = [{ id: rootId, phase: 0 }];

    while (stack.length > 0) {
        const frame = stack[stack.length - 1]!;
        const node = nodes.get(frame.id);

        if (!node || node.tag === 'text') {
            if (node) push(_escapeHtml(node.text));
            stack.pop();
            continue;
        }

        if (frame.phase === 0) {
            push('<');
            push(_escapeHtml(node.tag));
            const attrKeys = Object.keys(node.attrs);
            for (let i = 0; i < attrKeys.length; i++) {
                push(' ');
                push(_escapeHtml(attrKeys[i]!));
                push('="');
                push(_escapeHtml(node.attrs[attrKeys[i]!]!));
                push('"');
            }
            push('>');
            frame.phase = 1;
            const children = node.children;
            for (let i = children.length - 1; i >= 0; i--) {
                stack.push({ id: children[i]!, phase: 0 });
            }
        } else {
            push('</');
            push(node.tag);
            push('>');
            stack.pop();
        }
    }

    return parts.join('');
};
