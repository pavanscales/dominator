class SSABuilder {
    constructor() {
        this.varCounter = 0;
        this.blockCounter = 0;
        this.ir = {
            blocks: new Map(),
            entry: 0,
            variables: new Map(),
            nextVarId: 0,
            nextBlockId: 0,
        };
        this.currentBlock = this.createBlock();
        this.ir.entry = this.currentBlock.id;
    }
    createBlock() {
        const block = {
            id: this.blockCounter++,
            instructions: [],
            predecessors: [],
            successors: [],
            dominates: new Set(),
        };
        this.ir.blocks.set(block.id, block);
        return block;
    }
    newVar(prefix = 'v') {
        return `${prefix}${this.varCounter++}`;
    }
    emit(instruction) {
        this.currentBlock.instructions.push(instruction);
        return instruction.dest || '';
    }
    build(ast) {
        this.visitNode(ast);
        this.optimize();
        return this.ir;
    }
    visitNode(node) {
        switch (node.type) {
            case 'Program': return this.visitProgram(node);
            case 'Element': return this.visitElement(node);
            case 'Text': return this.visitText(node);
            case 'Expression': return this.visitExpression(node);
            case 'Component': return this.visitComponent(node);
            case 'Fragment': return this.visitFragment(node);
            default: return '';
        }
    }
    visitProgram(node) {
        const results = (node.children ?? []).map((c) => this.visitNode(c)).filter(Boolean);
        return results[results.length - 1] || '';
    }
    visitElement(node) {
        if (!node.tag)
            throw new Error('Element node missing tag');
        const dest = this.newVar('el');
        this.emit({
            op: 'create_element',
            dest,
            args: [String(node.tag)],
            metadata: { tag: node.tag, isStatic: node.isStatic },
        });
        if (node.attributes) {
            for (const [key, value] of Object.entries(node.attributes)) {
                const valueVar = this.visitValue(value);
                this.emit({
                    op: 'set_prop',
                    args: [dest, key, valueVar],
                    metadata: { key, isStatic: typeof value !== 'string' || !value.startsWith('{') },
                });
            }
        }
        if (node.children) {
            for (const child of node.children) {
                const childVar = this.visitNode(child);
                if (childVar)
                    this.emit({ op: 'append_child', args: [dest, childVar] });
            }
        }
        return dest;
    }
    visitText(node) {
        const dest = this.newVar('txt');
        this.emit({ op: 'create_text', dest, value: node.value, metadata: { isStatic: true } });
        return dest;
    }
    visitExpression(node) {
        const dest = this.newVar('expr');
        this.emit({ op: 'load', dest, value: node.expression, metadata: { isStatic: false } });
        return dest;
    }
    visitComponent(node) {
        const dest = this.newVar('comp');
        const propsVar = this.newVar('props');
        this.emit({ op: 'alloc', dest: propsVar, value: node.attributes ?? {} });
        this.emit({ op: 'call', dest, args: [node.tag, propsVar], metadata: { component: node.tag } });
        return dest;
    }
    visitFragment(node) {
        const dest = this.newVar('frag');
        const children = (node.children ?? []).map((c) => this.visitNode(c));
        this.emit({ op: 'alloc', dest, args: children, metadata: { type: 'fragment' } });
        return dest;
    }
    visitValue(value) {
        if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
            const expr = value.slice(1, -1);
            const dest = this.newVar('val');
            this.emit({ op: 'load', dest, value: expr, metadata: { isStatic: false } });
            return dest;
        }
        const dest = this.newVar('const');
        this.emit({ op: 'alloc', dest, value, metadata: { isStatic: true } });
        return dest;
    }
    optimize() {
        this.deadCodeElimination();
        this.constantFolding();
        this.commonSubexpressionElimination();
    }
    deadCodeElimination() {
        const used = new Set();
        for (const block of this.ir.blocks.values()) {
            for (const inst of block.instructions) {
                inst.args?.forEach(arg => used.add(arg));
            }
        }
        for (const block of this.ir.blocks.values()) {
            block.instructions = block.instructions.filter(inst => !inst.dest || used.has(inst.dest) || inst.op === 'call' || inst.op === 'store');
        }
    }
    constantFolding() {
        const constants = new Map();
        for (const block of this.ir.blocks.values()) {
            for (const inst of block.instructions) {
                if (inst.op === 'alloc' && inst.metadata?.isStatic)
                    constants.set(inst.dest, inst.value);
            }
        }
        for (const block of this.ir.blocks.values()) {
            for (const inst of block.instructions) {
                if (inst.args) {
                    inst.args = inst.args.map(arg => {
                        if (constants.has(arg)) {
                            const val = constants.get(arg);
                            const newVar = this.newVar('fold');
                            constants.set(newVar, val);
                            return newVar;
                        }
                        return arg;
                    });
                }
            }
        }
    }
    commonSubexpressionElimination() {
        const expressions = new Map();
        for (const block of this.ir.blocks.values()) {
            for (const inst of block.instructions) {
                if (inst.op === 'create_element' || inst.op === 'create_text') {
                    const key = `${inst.op}:${JSON.stringify(inst.args)}:${inst.value}`;
                    if (expressions.has(key) && inst.dest) {
                        this.ir.variables.set(inst.dest, expressions.get(key));
                    }
                    else if (inst.dest)
                        expressions.set(key, inst.dest);
                }
            }
        }
    }
}
// --------------------------
// Exported helpers
// --------------------------
export function buildSSA(ast) {
    const builder = new SSABuilder();
    return builder.build(ast);
}
export function printSSA(ir) {
    const lines = [];
    for (const [blockId, block] of ir.blocks.entries()) {
        lines.push(`Block ${blockId}:`);
        for (const inst of block.instructions) {
            let line = inst.dest ? `${inst.dest} = ${inst.op}` : inst.op;
            if (inst.args?.length)
                line += ` ${inst.args.join(', ')}`;
            if (inst.value !== undefined)
                line += ` [${JSON.stringify(inst.value)}]`;
            lines.push('  ' + line);
        }
        lines.push('');
    }
    return lines.join('\n');
}
export function analyzeSSA(ir) {
    let instructionCount = 0, staticNodes = 0, dynamicNodes = 0;
    for (const block of ir.blocks.values()) {
        instructionCount += block.instructions.length;
        for (const inst of block.instructions) {
            if (inst.metadata?.isStatic)
                staticNodes++;
            else if (inst.metadata?.isStatic === false)
                dynamicNodes++;
        }
    }
    return {
        instructionCount,
        blockCount: ir.blocks.size,
        staticNodes,
        dynamicNodes,
    };
}
