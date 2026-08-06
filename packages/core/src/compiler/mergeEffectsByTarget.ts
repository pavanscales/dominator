/**
 * Compiler pass: Dependency-Aware Effect Merging
 *
 * Merges ALL dynamic effects that target the same DOM element into a single
 * hoisted effect. Unlike flatten.ts (which only merges consecutive effects),
 * this pass merges ALL effects on the same target, regardless of their position.
 *
 * Reduces effect() call count at compile time — fewer closures, fewer
 * function calls per batch, better cache locality.
 *
 * Before (2 separate effects per batch):
 *   v0.style.color = expr1;   // effect 1
 *   v1.textContent = static;  // static — separates the effects
 *   v0.style.transform = expr2; // effect 2
 *
 * After (1 effect per batch):
 *   effect(() => {
 *     v0.style.color = expr1;
 *     v0.style.transform = expr2;
 *   });
 *   v1.textContent = static;
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

export function mergeEffectsByTarget(instructions: Instruction[]): Instruction[] {
    // Recurse into nested blocks first
    const processed = instructions.map(ins => {
        if (ins.nested || ins.elseNested) {
            return {
                ...ins,
                nested: ins.nested ? mergeEffectsByTarget(ins.nested) : undefined,
                elseNested: ins.elseNested ? mergeEffectsByTarget(ins.elseNested) : undefined,
            };
        }
        return ins;
    });

    // Pass 1: Collect all dynamic effects, group by target
    const targetGroups = new Map<string, number[]>();
    const dynamicSet = new Set<number>();

    for (let i = 0; i < processed.length; i++) {
        const ins = processed[i]!;
        if (_isDynamicEffect(ins)) {
            const target = ins.target;
            let group = targetGroups.get(target);
            if (!group) {
                group = [];
                targetGroups.set(target, group);
            }
            group.push(i);
            dynamicSet.add(i);
        }
    }

    // Check if any merging is needed
    let needsMerge = false;
    for (const group of targetGroups.values()) {
        if (group.length > 1) {
            needsMerge = true;
            break;
        }
    }
    if (!needsMerge) return processed;

    // Pass 2: Build result — replace first effect in each group with hoisted
    const result: Instruction[] = [];
    const consumed = new Set<number>();

    for (let i = 0; i < processed.length; i++) {
        const ins = processed[i]!;

        if (dynamicSet.has(i) && !consumed.has(i)) {
            const target = ins.target;
            const indices = targetGroups.get(target);
            if (indices && indices.length > 1) {
                // Mark all effects in this group as consumed
                for (const idx of indices) consumed.add(idx);
                // Create hoisted effect with all effects in group
                const nested = indices.map(idx => processed[idx]!);
                result.push({
                    op: 'hoisted',
                    target,
                    args: [],
                    nested,
                });
                continue;
            }
        }

        result.push(ins);
    }

    return result;
}
