import type { Instruction } from './ssa';

export const optimize = (instructions: Instruction[]): Instruction[] => {
    let result = instructions;
    result = _dce(result);
    result = _foldStatic(result);
    result = _mergeStaticText(result);
    result = _liftStaticBranches(result);
    result = _inlineSmallEffects(result);
    return result;
};

function _dce(instrs: Instruction[]): Instruction[] {
    const removedTargets = new Set<string>();
    const filtered = instrs.filter((ins) => {
        if (ins.op === 'text' && !ins.args[0]) {
            removedTargets.add(ins.target);
            return false;
        }
        if (ins.op === 'attr' && ins.args[1] === undefined) return false;
        return true;
    });
    const result: Instruction[] = [];
    for (let i = 0; i < filtered.length; i++) {
        const ins = filtered[i]!;
        if (ins.op === 'append' && removedTargets.has(ins.args[0] as string)) continue;
        if (ins.nested || ins.elseNested) {
            result.push({
                ...ins,
                nested: ins.nested ? _dce(ins.nested) : undefined,
                elseNested: ins.elseNested ? _dce(ins.elseNested) : undefined,
            });
        } else {
            result.push(ins);
        }
    }
    return result;
}

const _CONSTANT_FOLDABLE = /^[0-9]+(\.[0-9]+)?$/;
const _STRING_LITERAL = /^['"](.*)['"]$/;

function _foldStatic(instrs: Instruction[]): Instruction[] {
    const result: Instruction[] = [];
    for (let i = 0; i < instrs.length; i++) {
        const ins = instrs[i]!;
        if (ins.op === 'attr' && typeof ins.args[1] === 'string') {
            const val = ins.args[1];
            const folded = _tryFoldExpression(val);
            if (folded !== null) {
                result.push({ ...ins, args: [ins.args[0], folded] });
            } else if (ins.nested || ins.elseNested) {
                result.push({
                    ...ins,
                    nested: ins.nested ? _foldStatic(ins.nested) : undefined,
                    elseNested: ins.elseNested ? _foldStatic(ins.elseNested) : undefined,
                });
            } else {
                result.push(ins);
            }
        } else if (ins.op === 'expr' && typeof ins.args[0] === 'string') {
            const folded = _tryFoldExpression(ins.args[0]);
            if (folded !== null) {
                result.push({ ...ins, args: [folded], op: 'text' });
            } else if (ins.nested || ins.elseNested) {
                result.push({
                    ...ins,
                    nested: ins.nested ? _foldStatic(ins.nested) : undefined,
                    elseNested: ins.elseNested ? _foldStatic(ins.elseNested) : undefined,
                });
            } else {
                result.push(ins);
            }
        } else if (ins.nested || ins.elseNested) {
            result.push({
                ...ins,
                nested: ins.nested ? _foldStatic(ins.nested) : undefined,
                elseNested: ins.elseNested ? _foldStatic(ins.elseNested) : undefined,
            });
        } else {
            result.push(ins);
        }
    }
    return result;
}

function _tryFoldExpression(expr: string): string | null {
    if (_CONSTANT_FOLDABLE.test(expr)) return expr;
    const strMatch = expr.match(_STRING_LITERAL);
    if (strMatch) return JSON.stringify(strMatch[1]);
    if (expr === 'true') return 'true';
    if (expr === 'false') return 'false';
    if (expr === 'null') return 'null';
    if (expr === 'undefined') return 'undefined';

    const arithmeticMatch = expr.match(
        /^(-?[0-9]+(\.[0-9]+)?)\s*([+\-*/%])\s*(-?[0-9]+(\.[0-9]+)?)$/
    );
    if (arithmeticMatch) {
        const a = Number(arithmeticMatch[1]);
        const op = arithmeticMatch[3];
        const b = Number(arithmeticMatch[4]);
        switch (op) {
            case '+': return String(a + b);
            case '-': return String(a - b);
            case '*': return String(a * b);
            case '/': return b !== 0 ? String(a / b) : null;
            case '%': return b !== 0 ? String(a % b) : null;
        }
    }
    return null;
}

function _mergeStaticText(instrs: Instruction[]): Instruction[] {
    const result: Instruction[] = [];
    let i = 0;
    while (i < instrs.length) {
        const ins = instrs[i]!;
        if (ins.op === 'text' && typeof ins.args[0] === 'string') {
            let mergedText = String(ins.args[0]);
            let j = i + 1;
            while (j < instrs.length && instrs[j]!.op === 'text' && typeof instrs[j]!.args[0] === 'string') {
                mergedText += String(instrs[j]!.args[0]);
                j++;
            }
            if (j > i + 1) {
                result.push({ ...ins, args: [mergedText] });
                i = j;
            } else {
                result.push(ins);
                i++;
            }
        } else {
            if (ins.nested || ins.elseNested) {
                result.push({
                    ...ins,
                    nested: ins.nested ? _mergeStaticText(ins.nested) : undefined,
                    elseNested: ins.elseNested ? _mergeStaticText(ins.elseNested) : undefined,
                });
            } else {
                result.push(ins);
            }
            i++;
        }
    }
    return result;
}

/**
 * Static branch elimination: if the condition is a compile-time constant
 * (e.g., `if {true}` or `if {false}`), replace the `if` block with just
 * the live branch contents (or nothing for dead branches).
 */
const _CONSTANT_TRUE = /^(true|1|"[^"]*"|'[^']*')$/;
const _CONSTANT_FALSE = /^(false|0|""|'')$/;

function _liftStaticBranches(instrs: Instruction[]): Instruction[] {
    const result: Instruction[] = [];
    for (let i = 0; i < instrs.length; i++) {
        const ins = instrs[i]!;
        if (ins.op === 'if' && ins.args[0] !== undefined) {
            const cond = String(ins.args[0]);
            if (_CONSTANT_TRUE.test(cond)) {
                if (ins.nested) {
                    const inlined = _liftStaticBranches(ins.nested);
                    for (let j = 0; j < inlined.length; j++) result.push(inlined[j]!);
                }
                continue;
            }
            if (_CONSTANT_FALSE.test(cond)) {
                if (ins.elseNested) {
                    const inlined = _liftStaticBranches(ins.elseNested);
                    for (let j = 0; j < inlined.length; j++) result.push(inlined[j]!);
                }
                continue;
            }
        }
        if (ins.nested || ins.elseNested) {
            result.push({
                ...ins,
                nested: ins.nested ? _liftStaticBranches(ins.nested) : undefined,
                elseNested: ins.elseNested ? _liftStaticBranches(ins.elseNested) : undefined,
            });
        } else {
            result.push(ins);
        }
    }
    return result;
}

/**
 * Inline small effects: if an `each` or `if` block contains only
 * static create+attr+append instructions (no dynamic expr), unwrap them
 * from the effect and emit them directly. Reduces function call overhead.
 */
function _isFullyStaticBlock(instrs: Instruction[]): boolean {
    for (let i = 0; i < instrs.length; i++) {
        const ins = instrs[i]!;
        if (ins.op === 'expr') return false;
        if (ins.op === 'attr' && typeof ins.args[1] === 'string' && ins.args[1].startsWith('{')) return false;
        if (ins.op === 'each' || ins.op === 'if') return false;
        if (ins.nested && !_isFullyStaticBlock(ins.nested)) return false;
        if (ins.elseNested && !_isFullyStaticBlock(ins.elseNested)) return false;
    }
    return true;
}

function _inlineSmallEffects(instrs: Instruction[]): Instruction[] {
    const result: Instruction[] = [];
    for (let i = 0; i < instrs.length; i++) {
        const ins = instrs[i]!;
        // Only inline `if` blocks with compile-time constant conditions, never `each` (dynamic loops)
        if (ins.op === 'if' && ins.nested && _isFullyStaticBlock(ins.nested) && (_CONSTANT_TRUE.test(String(ins.args[0])) || _CONSTANT_FALSE.test(String(ins.args[0])))) {
            const inlined = _inlineSmallEffects(ins.nested);
            for (let j = 0; j < inlined.length; j++) result.push(inlined[j]!);
        } else if (ins.nested || ins.elseNested) {
            result.push({
                ...ins,
                nested: ins.nested ? _inlineSmallEffects(ins.nested) : undefined,
                elseNested: ins.elseNested ? _inlineSmallEffects(ins.elseNested) : undefined,
            });
        } else {
            result.push(ins);
        }
    }
    return result;
}
