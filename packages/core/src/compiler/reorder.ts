/**
 * Compiler pass: Instruction Reordering
 * 
 * Groups instructions by type for better cache locality:
 * 1. All create() calls first — batch DOM node allocation
 * 2. All static attr() calls — batch attribute setup
 * 3. All event() calls — batch event listener setup
 * 4. All text() calls — batch text node creation
 * 5. All append() calls — batch tree assembly
 * 6. Dynamic expr/attr with effects last — these are the hot path
 * 
 * This ordering means:
 * - Browser can optimize element creation (single pass over tag names)
 * - Static attributes are set before effects run (no unnecessary invalidation)
 * - Appends happen once after all elements exist
 * - Effects only run for actual dynamic content
 */

import type { Instruction } from './ssa';

const OP_PRIORITY: Record<string, number> = {
    'create': 0,
    'text': 1,
    'attr': 2,  // static attrs sorted before dynamic
    'event': 3,
    'append': 4,
    'expr': 5,  // dynamic text — effect
    'each': 6,  // blocks — preserve relative order
    'if': 7,    // conditionals — preserve relative order
};

function _isStatic(ins: Instruction): boolean {
    if (ins.op === 'attr') {
        const val = ins.args[1];
        return typeof val !== 'string' || !val.startsWith('{');
    }
    if (ins.op === 'expr') return false;
    return true;
}

export function reorderInstructions(instructions: Instruction[]): Instruction[] {
    // Only reorder top-level flat instruction blocks
    // Nested blocks (each, if) are reordered recursively but their
    // relative position within parent is preserved
    
    // Separate into groups
    const creates: Instruction[] = [];
    const staticAttrs: Instruction[] = [];
    const events: Instruction[] = [];
    const texts: Instruction[] = [];
    const appends: Instruction[] = [];
    const dynamicExprs: Instruction[] = [];
    const blocks: Instruction[] = [];

    for (let i = 0; i < instructions.length; i++) {
        const ins = instructions[i]!;

        // Recurse into nested blocks
        if (ins.nested) {
            ins.nested = reorderInstructions(ins.nested);
        }

        switch (ins.op) {
            case 'create':
                creates.push(ins);
                break;
            case 'text':
                texts.push(ins);
                break;
            case 'attr':
                if (_isStatic(ins)) {
                    staticAttrs.push(ins);
                } else {
                    dynamicExprs.push(ins);
                }
                break;
            case 'event':
                events.push(ins);
                break;
            case 'append':
                appends.push(ins);
                break;
            case 'expr':
                creates.push(ins);
                break;
            case 'each':
            case 'if':
                blocks.push(ins);
                break;
        }
    }

    // Rebuild in optimized order
    return [
        ...creates,
        ...texts,
        ...staticAttrs,
        ...events,
        ...appends,
        ...dynamicExprs,
        ...blocks,
    ];
}
