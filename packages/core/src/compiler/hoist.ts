/**
 * Compiler pass: Effect Hoisting
 * 
 * Merges adjacent effects that target the same element into a single effect.
 * Reduces function call overhead and improves cache locality.
 * 
 * Before (2 effects, 2 function calls per batch):
 *   effect(() => { v0.style.transform = expr1; });
 *   effect(() => { v0.style.color = expr2; });
 * 
 * After (1 effect, 1 function call per batch):
 *   effect(() => { v0.style.transform = expr1; v0.style.color = expr2; });
 */

import type { Instruction } from './ssa';

/**
 * Identify dynamic attribute/effect instructions that can be merged.
 * Two instructions can merge if they:
 * 1. Target the same DOM element
 * 2. Are adjacent (no static instructions between them)
 * 3. Are both dynamic (produce effects)
 */
function _isDynamicEffect(ins: Instruction): boolean {
    if (ins.op === 'expr') return true;
    if (ins.op === 'attr') {
        const val = ins.args[1];
        return typeof val === 'string' && val.startsWith('{');
    }
    if (ins.op === 'event') return false; // events don't merge
    return false;
}

function _getEffectTarget(ins: Instruction): string {
    return ins.target;
}

export function hoistEffects(instructions: Instruction[]): Instruction[] {
    const result: Instruction[] = [];
    let i = 0;

    while (i < instructions.length) {
        const insOrig = instructions[i]!;
        let ins = insOrig;
        if (insOrig.nested || insOrig.elseNested) {
            ins = {
                ...insOrig,
                nested: insOrig.nested ? hoistEffects(insOrig.nested) : undefined,
                elseNested: insOrig.elseNested ? hoistEffects(insOrig.elseNested) : undefined,
            };
        }

        if (_isDynamicEffect(ins)) {
            const target = _getEffectTarget(ins);
            const group: Instruction[] = [ins];
            let j = i + 1;

            while (j < instructions.length) {
                const nextOrig = instructions[j]!;
                let next = nextOrig;
                if (_isDynamicEffect(next) && _getEffectTarget(next) === target) {
                    if (nextOrig.nested || nextOrig.elseNested) next = {
                        ...nextOrig,
                        nested: nextOrig.nested ? hoistEffects(nextOrig.nested) : undefined,
                        elseNested: nextOrig.elseNested ? hoistEffects(nextOrig.elseNested) : undefined,
                    };
                    group.push(next);
                    j++;
                } else {
                    break;
                }
            }

            if (group.length > 1) {
                result.push({
                    op: 'hoisted',
                    target: target,
                    args: [],
                    nested: group,
                });
                i = j;
                continue;
            }
        }

        result.push(ins);
        i++;
    }

    return result;
}

/**
 * Check if an instruction is a hoisted group.
 */
export function isHoisted(ins: Instruction): boolean {
    return ins.op === 'hoisted';
}
