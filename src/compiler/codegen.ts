// src/compiler/codegen.ts
import { SSAIR, SSAInstruction, buildSSA } from './ssa';
import { parse, ASTNode } from './parser';

export interface CodeGenOptions {
  target: 'js' | 'wasm';
  minify: boolean;
  inlineCache: boolean;
  staticOptimization: boolean;
}

class CodeGenerator {
  private options: CodeGenOptions;
  private output: string[] = [];
  private indent = 0;
  private varMap = new Map<string, string>();
  private staticCache = new Map<string, string>();

  constructor(options: Partial<CodeGenOptions> = {}) {
    this.options = {
      target: options.target || 'js',
      minify: options.minify ?? true,
      inlineCache: options.inlineCache ?? true,
      staticOptimization: options.staticOptimization ?? true,
    };
  }

  generate(ir: SSAIR): string {
    this.output = [];
    this.indent = 0;

    this.emitHeader();
    this.emitBlocks(ir);
    this.emitFooter();

    return this.output.join(this.options.minify ? '' : '\n');
  }

  private emitHeader(): void {
    this.emit('(function(h, mount, patch) {');
    this.indentInc();
    this.emit('"use strict";');

    if (this.options.staticOptimization) {
      this.emit('const _cache = new Map();');
    }
  }

  private emitFooter(): void {
    this.indentDec();
    this.emit('})(h, mount, patch);');
  }

  private emitBlocks(ir: SSAIR): void {
    const entryBlock = ir.blocks.get(ir.entry);
    if (!entryBlock) return;

    this.emit('return (function render(props, state) {');
    this.indentInc();

    for (const inst of entryBlock.instructions) {
      this.emitInstruction(inst);
    }

    this.indentDec();
    this.emit('});');
  }

  private emitInstruction(inst: SSAInstruction): void {
    switch (inst.op) {
      case 'alloc': this.emitAlloc(inst); break;
      case 'load': this.emitLoad(inst); break;
      case 'store': this.emitStore(inst); break;
      case 'call': this.emitCall(inst); break;
      case 'create_element': this.emitCreateElement(inst); break;
      case 'create_text': this.emitCreateText(inst); break;
      case 'set_prop': this.emitSetProp(inst); break;
      case 'append_child': this.emitAppendChild(inst); break;
      case 'mount': this.emitMount(inst); break;
      case 'patch': this.emitPatch(inst); break;
      case 'return': this.emitReturn(inst); break;
    }
  }

  private emitAlloc(inst: SSAInstruction): void {
    const dest = this.getVarName(inst.dest!);
    const value = JSON.stringify(inst.value);

    if (inst.metadata?.isStatic && this.options.staticOptimization) {
      const cacheKey = `alloc_${value}`;
      if (this.staticCache.has(cacheKey)) {
        this.emit(`const ${dest} = ${this.staticCache.get(cacheKey)};`);
      } else {
        this.emit(`const ${dest} = ${value};`);
        this.staticCache.set(cacheKey, dest);
      }
    } else {
      this.emit(`const ${dest} = ${value};`);
    }
  }

  private emitLoad(inst: SSAInstruction): void {
    const dest = this.getVarName(inst.dest!);
    const expr = inst.value;
    this.emit(`const ${dest} = ${expr};`);
  }

  private emitStore(inst: SSAInstruction): void {
    const [target, value] = inst.args!;
    this.emit(`${this.getVarName(target)} = ${this.getVarName(value)};`);
  }

  private emitCall(inst: SSAInstruction): void {
    const dest = inst.dest ? this.getVarName(inst.dest) : '_';
    const [fn, ...args] = inst.args!;
    const argStr = args.map((a: string) => this.getVarName(a)).join(', ');

    if (inst.metadata?.component) {
      this.emit(`const ${dest} = ${inst.metadata.component}(${argStr});`);
    } else {
      this.emit(`const ${dest} = ${this.getVarName(fn)}(${argStr});`);
    }
  }

  private emitCreateElement(inst: SSAInstruction): void {
    const dest = this.getVarName(inst.dest!);
    const tag = inst.args![0];

    if (inst.metadata?.isStatic && this.options.inlineCache) {
      const cacheKey = `el_${tag}`;
      this.emit(`const ${dest} = _cache.has('${cacheKey}') ? _cache.get('${cacheKey}').cloneNode(true) : (function() {`);
      this.indentInc();
      this.emit(`const el = h('${tag}', {});`);
      this.emit(`_cache.set('${cacheKey}', el.cloneNode(true));`);
      this.emit(`return el;`);
      this.indentDec();
      this.emit(`})();`);
    } else {
      this.emit(`const ${dest} = h('${tag}', {});`);
    }
  }

  private emitCreateText(inst: SSAInstruction): void {
    const dest = this.getVarName(inst.dest!);
    const text = JSON.stringify(inst.value);

    if (this.options.minify) {
      this.emit(`const ${dest} = ${text};`);
    } else {
      this.emit(`const ${dest} = createTextVNode(${text});`);
    }
  }

  private emitSetProp(inst: SSAInstruction): void {
    const [el, key, value] = inst.args!;
    const elVar = this.getVarName(el);
    const valVar = this.getVarName(value);

    if (inst.metadata?.isStatic) {
      this.emit(`${elVar}.props = ${elVar}.props || {}; ${elVar}.props['${key}'] = ${valVar};`);
    } else {
      this.emit(`if (!${elVar}.props) ${elVar}.props = {};`);
      this.emit(`${elVar}.props['${key}'] = ${valVar};`);
    }
  }

  private emitAppendChild(inst: SSAInstruction): void {
    const [parent, child] = inst.args!;
    const parentVar = this.getVarName(parent);
    const childVar = this.getVarName(child);

    this.emit(`if (!${parentVar}.children) ${parentVar}.children = [];`);
    this.emit(`${parentVar}.children.push(${childVar});`);
  }

  private emitMount(inst: SSAInstruction): void {
    const [vnode, container] = inst.args!;
    this.emit(`mount(${this.getVarName(vnode)}, ${this.getVarName(container)});`);
  }

  private emitPatch(inst: SSAInstruction): void {
    const [oldVNode, newVNode, container] = inst.args!;
    this.emit(`patch(${this.getVarName(oldVNode)}, ${this.getVarName(newVNode)}, ${this.getVarName(container)});`);
  }

  private emitReturn(inst: SSAInstruction): void {
    if (inst.args && inst.args.length > 0) {
      this.emit(`return ${this.getVarName(inst.args[0])};`);
    } else {
      this.emit(`return;`);
    }
  }

  private emit(code: string): void {
    if (this.options.minify) {
      this.output.push(code);
    } else {
      const padding = '  '.repeat(this.indent);
      this.output.push(padding + code);
    }
  }

  private indentInc(): void { this.indent++; }
  private indentDec(): void { this.indent = Math.max(0, this.indent - 1); }

  private getVarName(original: string): string {
    if (this.varMap.has(original)) return this.varMap.get(original)!;

    if (this.options.minify) {
      const short = this.generateShortName(this.varMap.size);
      this.varMap.set(original, short);
      return short;
    }

    return original;
  }

  private generateShortName(index: number): string {
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
export function generateCode(ir: SSAIR, options?: Partial<CodeGenOptions>): string {
  return new CodeGenerator(options).generate(ir);
}

export function generateOptimizedCode(ir: SSAIR): string {
  return generateCode(ir, { minify: true, inlineCache: true, staticOptimization: true });
}

export function generateDebugCode(ir: SSAIR): string {
  return generateCode(ir, { minify: false, inlineCache: false, staticOptimization: false });
}

export function compile(source: string): string {
  const ast: ASTNode = parse(source);
  const ir: SSAIR = buildSSA(ast);
  return generateOptimizedCode(ir);
}

export function compileWithOptions(source: string, options: Partial<CodeGenOptions>): string {
  const ast: ASTNode = parse(source);
  const ir: SSAIR = buildSSA(ast);
  return generateCode(ir, options);
}
