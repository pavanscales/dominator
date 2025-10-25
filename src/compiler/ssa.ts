// --------------------------
// src/compiler/ssa.ts
// --------------------------
import { ASTNode } from './parser';

export type SSAOpType =
  | 'alloc'
  | 'assign'
  | 'load'
  | 'store'
  | 'call'
  | 'branch'
  | 'phi'
  | 'return'
  | 'create_element'
  | 'create_text'
  | 'set_prop'
  | 'append_child'
  | 'mount'
  | 'patch';

export interface SSAInstruction {
  op: SSAOpType;
  dest?: string;
  args?: string[];
  value?: any;
  metadata?: Record<string, any>;
  blockId?: number;
}

export interface SSABasicBlock {
  id: number;
  instructions: SSAInstruction[];
  predecessors: number[];
  successors: number[];
  dominates: Set<number>;
}

export interface SSAIR {
  blocks: Map<number, SSABasicBlock>;
  entry: number;
  variables: Map<string, string>;
  nextVarId: number;
  nextBlockId: number;
}

class SSABuilder {
  private ir: SSAIR;
  private currentBlock: SSABasicBlock;
  private varCounter = 0;
  private blockCounter = 0;

  constructor() {
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

  private createBlock(): SSABasicBlock {
    const block: SSABasicBlock = {
      id: this.blockCounter++,
      instructions: [],
      predecessors: [],
      successors: [],
      dominates: new Set(),
    };
    this.ir.blocks.set(block.id, block);
    return block;
  }

  private newVar(prefix: string = 'v'): string {
    return `${prefix}${this.varCounter++}`;
  }

  private emit(instruction: SSAInstruction): string {
    this.currentBlock.instructions.push(instruction);
    return instruction.dest || '';
  }

  build(ast: ASTNode): SSAIR {
    this.visitNode(ast);
    this.optimize();
    return this.ir;
  }

  private visitNode(node: ASTNode): string {
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

  private visitProgram(node: ASTNode): string {
    const results = (node.children ?? []).map((c: ASTNode) => this.visitNode(c)).filter(Boolean);
    return results[results.length - 1] || '';
  }

  private visitElement(node: ASTNode): string {
    if (!node.tag) throw new Error('Element node missing tag');

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
        if (childVar) this.emit({ op: 'append_child', args: [dest, childVar] });
      }
    }

    return dest;
  }

  private visitText(node: ASTNode): string {
    const dest = this.newVar('txt');
    this.emit({ op: 'create_text', dest, value: node.value, metadata: { isStatic: true } });
    return dest;
  }

  private visitExpression(node: ASTNode): string {
    const dest = this.newVar('expr');
    this.emit({ op: 'load', dest, value: node.expression, metadata: { isStatic: false } });
    return dest;
  }

  private visitComponent(node: ASTNode): string {
    const dest = this.newVar('comp');
    const propsVar = this.newVar('props');

    this.emit({ op: 'alloc', dest: propsVar, value: node.attributes ?? {} });
    this.emit({ op: 'call', dest, args: [node.tag! as string, propsVar], metadata: { component: node.tag } });

    return dest;
  }

  private visitFragment(node: ASTNode): string {
    const dest = this.newVar('frag');
    const children = (node.children ?? []).map((c: ASTNode) => this.visitNode(c));
    this.emit({ op: 'alloc', dest, args: children, metadata: { type: 'fragment' } });
    return dest;
  }

  private visitValue(value: unknown): string {
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

  private optimize(): void {
    this.deadCodeElimination();
    this.constantFolding();
    this.commonSubexpressionElimination();
  }

  private deadCodeElimination(): void {
    const used = new Set<string>();
    for (const block of this.ir.blocks.values()) {
      for (const inst of block.instructions) {
        inst.args?.forEach(arg => used.add(arg));
      }
    }
    for (const block of this.ir.blocks.values()) {
      block.instructions = block.instructions.filter(
        inst => !inst.dest || used.has(inst.dest) || inst.op === 'call' || inst.op === 'store'
      );
    }
  }

  private constantFolding(): void {
    const constants = new Map<string, any>();
    for (const block of this.ir.blocks.values()) {
      for (const inst of block.instructions) {
        if (inst.op === 'alloc' && inst.metadata?.isStatic) constants.set(inst.dest!, inst.value);
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

  private commonSubexpressionElimination(): void {
    const expressions = new Map<string, string>();
    for (const block of this.ir.blocks.values()) {
      for (const inst of block.instructions) {
        if (inst.op === 'create_element' || inst.op === 'create_text') {
          const key = `${inst.op}:${JSON.stringify(inst.args)}:${inst.value}`;
          if (expressions.has(key) && inst.dest) {
            this.ir.variables.set(inst.dest, expressions.get(key)!);
          } else if (inst.dest) expressions.set(key, inst.dest);
        }
      }
    }
  }
}

// --------------------------
// Exported helpers
// --------------------------
export function buildSSA(ast: ASTNode): SSAIR {
  const builder = new SSABuilder();
  return builder.build(ast);
}

export function printSSA(ir: SSAIR): string {
  const lines: string[] = [];
  for (const [blockId, block] of ir.blocks.entries()) {
    lines.push(`Block ${blockId}:`);
    for (const inst of block.instructions) {
      let line = inst.dest ? `${inst.dest} = ${inst.op}` : inst.op;
      if (inst.args?.length) line += ` ${inst.args.join(', ')}`;
      if (inst.value !== undefined) line += ` [${JSON.stringify(inst.value)}]`;
      lines.push('  ' + line);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function analyzeSSA(ir: SSAIR) {
  let instructionCount = 0, staticNodes = 0, dynamicNodes = 0;
  for (const block of ir.blocks.values()) {
    instructionCount += block.instructions.length;
    for (const inst of block.instructions) {
      if (inst.metadata?.isStatic) staticNodes++;
      else if (inst.metadata?.isStatic === false) dynamicNodes++;
    }
  }
  return {
    instructionCount,
    blockCount: ir.blocks.size,
    staticNodes,
    dynamicNodes,
  };
}
