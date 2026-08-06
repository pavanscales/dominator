import type { ASTNode } from './parse';

export interface Instruction {
    op: 'create' | 'attr' | 'event' | 'text' | 'expr' | 'append' | 'each' | 'if' | 'hoisted';
    target: string;
    args: (string | number | boolean)[];
    nested?: Instruction[];
    elseNested?: Instruction[];
}

export const ssa = (ast: ASTNode): Instruction[] => {
    let nextId = 0;

    const serialize = (nodes: ASTNode | ASTNode[], targetList: Instruction[]): string => {
        const nodeList = Array.isArray(nodes) ? nodes : [nodes];
        let lastId = '';

        const push = (ins: Instruction): void => {
            targetList.push(ins);
        };

        const process = (node: ASTNode): string => {
            const id = `v${nextId++}`;
            switch (node.type) {
                case 'Element':
                case 'Component': {
                    push({ op: 'create', target: id, args: [node.tag as string] });
                    if (node.attributes) {
                        const keys = Object.keys(node.attributes);
                        for (let i = 0; i < keys.length; i++) {
                            const key = keys[i]!;
                            const value = node.attributes[key];
                            if (key.charCodeAt(0) === 111 && key.charCodeAt(1) === 110) {
                                push({ op: 'event', target: id, args: [key.slice(2).toLowerCase(), String(value)] });
                            } else {
                                push({ op: 'attr', target: id, args: [key, String(value)] });
                            }
                        }
                    }
                    if (node.children) {
                        for (let i = 0; i < node.children.length; i++) {
                            const childId = process(node.children[i]!);
                            push({ op: 'append', target: id, args: [childId] });
                        }
                    }
                    break;
                }
                case 'Text': push({ op: 'text', target: id, args: [String(node.value ?? '')] }); break;
                case 'Expression': push({ op: 'expr', target: id, args: [String(node.expression ?? '')] }); break;
                case 'Each': {
                    const childInstructions: Instruction[] = [];
                    if (node.children) serialize(node.children, childInstructions);
                    push({ op: 'each', target: id, args: [String(node.expression ?? ''), String(node.context ?? '')], nested: childInstructions });
                    break;
                }
                case 'If': {
                    const childInstructions: Instruction[] = [];
                    if (node.children) serialize(node.children, childInstructions);
                    const elseInstructions: Instruction[] = [];
                    if (node.else?.children) serialize(node.else.children, elseInstructions);
                    push({ op: 'if', target: id, args: [String(node.expression ?? ''), String(node.elseCondition ?? '')], nested: childInstructions, elseNested: elseInstructions });
                    break;
                }
                case 'Program':
                    if (node.children) {
                        for (let i = 0; i < node.children.length; i++) { lastId = process(node.children[i]!); }
                    }
                    return id;
            }
            lastId = id;
            return id;
        };

        for (let i = 0; i < nodeList.length; i++) { lastId = process(nodeList[i]!); }
        return lastId;
    };

    const rootInstructions: Instruction[] = [];
    serialize(ast, rootInstructions);
    return rootInstructions;
};
