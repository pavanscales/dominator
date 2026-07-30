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

        if (ins.nested) {
            ins.nested = flattenEffects(ins.nested);
        }

        if (_isDynamicEffect(ins)) {
            const target = ins.target;
            const group: Instruction[] = [ins];
            let j = i + 1;

            while (j < instructions.length) {
                const next = instructions[j]!;
                if (_isDynamicEffect(next) && next.target === target) {
                    if (next.nested) next.nested = flattenEffects(next.nested);
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
                result.push(ins);
            }
            i = j - 1;
        } else {
            result.push(ins);
        }
    }

    return result;
}
