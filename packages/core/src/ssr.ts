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

const _escapeHtml = (str: string): string =>
    str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const renderToString = (instructions: SSRInstruction[]): string => {
    const nodeCount = instructions.length;
    const nodes = new Map<string, SSRNode>();
    let rootId: string | null = null;

    for (let i = 0; i < nodeCount; i++) {
        const inst = instructions[i]!;
        switch (inst.type) {
            case 'create': {
                const node: SSRNode = { tag: inst.tag!, attrs: {}, children: [], text: '' };
                nodes.set(inst.id, node);
                if (!rootId) rootId = inst.id;
                break;
            }
            case 'attr': {
                const node = nodes.get(inst.target!);
                if (node) node.attrs[inst.name!] = inst.value!;
                break;
            }
            case 'append': {
                const parent = nodes.get(inst.parent!);
                const child = nodes.get(inst.id);
                if (parent && child) parent.children.push(inst.id);
                break;
            }
            case 'text': {
                nodes.set(inst.id, { tag: 'text', attrs: {}, children: [], text: inst.value || '' });
                break;
            }
        }
    }

    if (!rootId) return '';

    const parts: string[] = [];
    const stack: { id: string; phase: number }[] = [{ id: rootId, phase: 0 }];

    while (stack.length > 0) {
        const frame = stack[stack.length - 1]!;
        const node = nodes.get(frame.id)!;

        if (node.tag === 'text') {
            parts.push(_escapeHtml(node.text));
            stack.pop();
            continue;
        }

        if (frame.phase === 0) {
            parts.push('<', node.tag);
            const attrKeys = Object.keys(node.attrs);
            for (let i = 0; i < attrKeys.length; i++) {
                parts.push(' ', _escapeHtml(attrKeys[i]!), '="', _escapeHtml(node.attrs[attrKeys[i]!]!), '"');
            }
            parts.push('>');
            frame.phase = 1;
            const children = node.children;
            for (let i = children.length - 1; i >= 0; i--) {
                stack.push({ id: children[i]!, phase: 0 });
            }
        } else {
            parts.push('</', node.tag, '>');
            stack.pop();
        }
    }

    return parts.join('');
};
