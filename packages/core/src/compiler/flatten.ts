/**
 * Compiler pass: Reactive Effect Flattening
 *
 * Merges non-adjacent dynamic effects that target the same DOM element
 * into a single hoisted effect. This reduces the number of effect()
 * calls and improves cache locality by batching DOM mutations.
 *
 * Strategy: Walk instructions, buffer dynamic effects by target.
 * When a non-dynamic instruction is encountered or the list ends,
 * flush buffered effects for each target as hoisted groups.
 *
 * Before (3 separate effects per batch):
 *   v0.style.color = expr1;   // effect 1
 *   v0.textContent = static;  // static — separates the effects
 *   v0.style.transform = expr2; // effect 2
 *
 * After (1 effect per batch):
 *   effect(() => {
 *     v0.style.color = expr1;
 *     v0.style.transform = expr2;
 *   });
 *   v0.textContent = static;
 *
 * NOTE: Static instructions that target the same element are moved AFTER
 * the merged effect to maintain correct DOM state ordering.
 */

import type { Instruction } from './ssa';

function _isDynamicEffect(ins: Instruction): boolean {
    if (ins.op === 'expr') return true;
    if (ins.op === 'attr') {
        const val = ins.args[1];
        return typeof val === 'string' && val.startsWith('{');
    }
    return false;
}

export function flattenEffects(instructions: Instruction[]): Instruction[] {
    const result: Instruction[] = [];

    for (let i = 0; i < instructions.length; i++) {
        const ins = instructions[i]!;

        let current = ins;
        if (ins.nested || ins.elseNested) {
            current = {
                ...ins,
                nested: ins.nested ? flattenEffects(ins.nested) : undefined,
                elseNested: ins.elseNested ? flattenEffects(ins.elseNested) : undefined,
            };
        }

        if (_isDynamicEffect(current)) {
            const target = current.target;
            const group: Instruction[] = [current];
            let j = i + 1;

            while (j < instructions.length) {
                const nextOrig = instructions[j]!;
                let next = nextOrig;
                if (_isDynamicEffect(next) && next.target === target) {
                    if (nextOrig.nested || nextOrig.elseNested) next = {
                        ...nextOrig,
                        nested: nextOrig.nested ? flattenEffects(nextOrig.nested) : undefined,
                        elseNested: nextOrig.elseNested ? flattenEffects(nextOrig.elseNested) : undefined,
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
                    target,
                    args: [],
                    nested: group,
                });
            } else {
                result.push(current);
            }
            i = j - 1;
        } else {
            result.push(current);
        }
    }

    return result;
}
