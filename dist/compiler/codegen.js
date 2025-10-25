// src/compiler/codegen.ts
import { buildSSA } from './ssa';
import { parse } from './parser';
class CodeGenerator {
    constructor(options = {}) {
        this.output = [];
        this.indent = 0;
        this.varMap = new Map();
        this.staticCache = new Map();
        this.options = {
            target: options.target || 'js',
            minify: options.minify ?? true,
            inlineCache: options.inlineCache ?? true,
            staticOptimization: options.staticOptimization ?? true,
        };
    }
    generate(ir) {
        this.output = [];
        this.indent = 0;
        this.emitHeader();
        this.emitBlocks(ir);
        this.emitFooter();
        return this.output.join(this.options.minify ? '' : '\n');
    }
    emitHeader() {
        this.emit('(function(h, mount, patch) {');
        this.indentInc();
        this.emit('"use strict";');
        if (this.options.staticOptimization) {
            this.emit('const _cache = new Map();');
        }
    }
    emitFooter() {
        this.indentDec();
        this.emit('})(h, mount, patch);');
    }
    emitBlocks(ir) {
        const entryBlock = ir.blocks.get(ir.entry);
        if (!entryBlock)
            return;
        this.emit('return (function render(props, state) {');
        this.indentInc();
        for (const inst of entryBlock.instructions) {
            this.emitInstruction(inst);
        }
        this.indentDec();
        this.emit('});');
    }
    emitInstruction(inst) {
        switch (inst.op) {
            case 'alloc':
                this.emitAlloc(inst);
                break;
            case 'load':
                this.emitLoad(inst);
                break;
            case 'store':
                this.emitStore(inst);
                break;
            case 'call':
                this.emitCall(inst);
                break;
            case 'create_element':
                this.emitCreateElement(inst);
                break;
            case 'create_text':
                this.emitCreateText(inst);
                break;
            case 'set_prop':
                this.emitSetProp(inst);
                break;
            case 'append_child':
                this.emitAppendChild(inst);
                break;
            case 'mount':
                this.emitMount(inst);
                break;
            case 'patch':
                this.emitPatch(inst);
                break;
            case 'return':
                this.emitReturn(inst);
                break;
        }
    }
    emitAlloc(inst) {
        const dest = this.getVarName(inst.dest);
        const value = JSON.stringify(inst.value);
        if (inst.metadata?.isStatic && this.options.staticOptimization) {
            const cacheKey = `alloc_${value}`;
            if (this.staticCache.has(cacheKey)) {
                this.emit(`const ${dest} = ${this.staticCache.get(cacheKey)};`);
            }
            else {
                this.emit(`const ${dest} = ${value};`);
                this.staticCache.set(cacheKey, dest);
            }
        }
        else {
            this.emit(`const ${dest} = ${value};`);
        }
    }
    emitLoad(inst) {
        const dest = this.getVarName(inst.dest);
        const expr = inst.value;
        this.emit(`const ${dest} = ${expr};`);
    }
    emitStore(inst) {
        const [target, value] = inst.args;
        this.emit(`${this.getVarName(target)} = ${this.getVarName(value)};`);
    }
    emitCall(inst) {
        const dest = inst.dest ? this.getVarName(inst.dest) : '_';
        const [fn, ...args] = inst.args;
        const argStr = args.map((a) => this.getVarName(a)).join(', ');
        if (inst.metadata?.component) {
            this.emit(`const ${dest} = ${inst.metadata.component}(${argStr});`);
        }
        else {
            this.emit(`const ${dest} = ${this.getVarName(fn)}(${argStr});`);
        }
    }
    emitCreateElement(inst) {
        const dest = this.getVarName(inst.dest);
        const tag = inst.args[0];
        if (inst.metadata?.isStatic && this.options.inlineCache) {
            const cacheKey = `el_${tag}`;
            this.emit(`const ${dest} = _cache.has('${cacheKey}') ? _cache.get('${cacheKey}').cloneNode(true) : (function() {`);
            this.indentInc();
            this.emit(`const el = h('${tag}', {});`);
            this.emit(`_cache.set('${cacheKey}', el.cloneNode(true));`);
            this.emit(`return el;`);
            this.indentDec();
            this.emit(`})();`);
        }
        else {
            this.emit(`const ${dest} = h('${tag}', {});`);
        }
    }
    emitCreateText(inst) {
        const dest = this.getVarName(inst.dest);
        const text = JSON.stringify(inst.value);
        if (this.options.minify) {
            this.emit(`const ${dest} = ${text};`);
        }
        else {
            this.emit(`const ${dest} = createTextVNode(${text});`);
        }
    }
    emitSetProp(inst) {
        const [el, key, value] = inst.args;
        const elVar = this.getVarName(el);
        const valVar = this.getVarName(value);
        if (inst.metadata?.isStatic) {
            this.emit(`${elVar}.props = ${elVar}.props || {}; ${elVar}.props['${key}'] = ${valVar};`);
        }
        else {
            this.emit(`if (!${elVar}.props) ${elVar}.props = {};`);
            this.emit(`${elVar}.props['${key}'] = ${valVar};`);
        }
    }
    emitAppendChild(inst) {
        const [parent, child] = inst.args;
        const parentVar = this.getVarName(parent);
        const childVar = this.getVarName(child);
        this.emit(`if (!${parentVar}.children) ${parentVar}.children = [];`);
        this.emit(`${parentVar}.children.push(${childVar});`);
    }
    emitMount(inst) {
        const [vnode, container] = inst.args;
        this.emit(`mount(${this.getVarName(vnode)}, ${this.getVarName(container)});`);
    }
    emitPatch(inst) {
        const [oldVNode, newVNode, container] = inst.args;
        this.emit(`patch(${this.getVarName(oldVNode)}, ${this.getVarName(newVNode)}, ${this.getVarName(container)});`);
    }
    emitReturn(inst) {
        if (inst.args && inst.args.length > 0) {
            this.emit(`return ${this.getVarName(inst.args[0])};`);
        }
        else {
            this.emit(`return;`);
        }
    }
    emit(code) {
        if (this.options.minify) {
            this.output.push(code);
        }
        else {
            const padding = '  '.repeat(this.indent);
            this.output.push(padding + code);
        }
    }
    indentInc() { this.indent++; }
    indentDec() { this.indent = Math.max(0, this.indent - 1); }
    getVarName(original) {
        if (this.varMap.has(original))
            return this.varMap.get(original);
        if (this.options.minify) {
            const short = this.generateShortName(this.varMap.size);
            this.varMap.set(original, short);
            return short;
        }
        return original;
    }
    generateShortName(index) {
        const chars = 'abcdefghijklmnopqrstuvwxyz';
        let name = '';
        let n = index;
        do {
            name = chars[n % chars.length] + name;
            n = Math.floor(n / chars.length);
        } while (n > 0);
        return name;
    }
}
// --------------------------
// Exports
// --------------------------
export function generateCode(ir, options) {
    return new CodeGenerator(options).generate(ir);
}
export function generateOptimizedCode(ir) {
    return generateCode(ir, { minify: true, inlineCache: true, staticOptimization: true });
}
export function generateDebugCode(ir) {
    return generateCode(ir, { minify: false, inlineCache: false, staticOptimization: false });
}
export function compile(source) {
    const ast = parse(source);
    const ir = buildSSA(ast);
    return generateOptimizedCode(ir);
}
export function compileWithOptions(source, options) {
    const ast = parse(source);
    const ir = buildSSA(ast);
    return generateCode(ir, options);
}
