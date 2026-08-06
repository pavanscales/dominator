import type { Instruction } from './ssa';

const _JS_KEYWORDS = new Set([
    'true', 'false', 'null', 'undefined', 'typeof', 'instanceof', 'void',
    'delete', 'new', 'this', 'if', 'else', 'return', 'function', 'const',
    'let', 'var', 'for', 'while', 'do', 'switch', 'case', 'break',
    'continue', 'class', 'extends', 'super', 'import', 'export', 'default',
    'try', 'catch', 'finally', 'throw', 'async', 'await', 'yield',
    'in', 'with', 'debugger', 'enum', 'implements', 'interface', 'package',
    'private', 'protected', 'public', 'static',
]);

const _DANGEROUS_PATTERNS = [
    /\brequire\s*\(/,
    /\beval\s*\(/,
    /\bFunction\s*\(/,
    /\barguments\b/,
    /\b__proto__\b/,
    /\bprototype\s*\[/,
    /\bimport\s*\(/,
    /\bfs\b/,
    /\bchild_process\b/,
    /\bprocess\b/,
];

export const validateExpression = (expr: string): boolean => {
    for (let i = 0; i < _DANGEROUS_PATTERNS.length; i++) {
        if (_DANGEROUS_PATTERNS[i]!.test(expr)) {
            return false;
        }
    }
    return true;
};

function _collectIdentifiers(instructions: Instruction[]): string[] {
    const idents = new Set<string>();
    const loopVars = new Set<string>();

    const extract = (expr: string): void => {
        const stripped = expr.replace(/'[^']*'|"[^"]*"/g, '""');
        const matches = stripped.match(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g);
        if (!matches) return;
        for (let i = 0; i < matches.length; i++) {
            const m = matches[i]!;
            if (!_JS_KEYWORDS.has(m) && m.length >= 1) {
                let dominated = true;
                let start = 0;
                while (start < stripped.length) {
                    const idx = stripped.indexOf(m, start);
                    if (idx === -1) break;
                    if (idx > 0 && stripped.charCodeAt(idx - 1) === 46) {
                        start = idx + m.length;
                    } else {
                        dominated = false;
                        break;
                    }
                }
                if (!dominated) {
                    idents.add(m);
                }
            }
        }
    };

    const walk = (instrs: Instruction[]): void => {
        for (let i = 0; i < instrs.length; i++) {
            const ins = instrs[i]!;
            if (ins.op === 'expr') {
                extract(String(ins.args[0]));
            } else if (ins.op === 'attr') {
                const val = ins.args[1];
                if (typeof val === 'string' && val.startsWith('{') && val.endsWith('}')) {
                    extract(val.slice(1, -1));
                }
            } else if (ins.op === 'event') {
                const val = ins.args[1];
                if (typeof val === 'string' && val.startsWith('{') && val.endsWith('}')) {
                    extract(val.slice(1, -1));
                }
            } else if (ins.op === 'each') {
                loopVars.add(String(ins.args[1]));
                extract(String(ins.args[0]));
            }
            if (ins.nested) walk(ins.nested);
            if (ins.elseNested) walk(ins.elseNested);
        }
    };

    walk(instructions);
    loopVars.forEach(v => idents.delete(v));

    return [...idents].sort();
}

export interface CodegenOptions {
    functionName?: string;
    stateImportPath?: string;
    aggressive?: boolean; // New flag for maximum aggression mode
}

function _hasInlineEvents(instrs: Instruction[]): boolean {
    for (let i = 0; i < instrs.length; i++) {
        const ins = instrs[i]!;
        if (ins.op === 'event') {
            const val = ins.args[1];
            if (typeof val === 'string' && val.startsWith('{') && val.endsWith('}')) return true;
        }
        if (ins.nested && _hasInlineEvents(ins.nested)) return true;
        if (ins.elseNested && _hasInlineEvents(ins.elseNested)) return true;
    }
    return false;
}

export const codegen = (instructions: Instruction[], options: CodegenOptions | string = {}): string => {
    const opts = typeof options === 'string' ? { functionName: options } : options;
    const functionName = opts.functionName ?? 'render';
    const stateImportPath = opts.stateImportPath ?? '../state';
    const aggressive = opts.aggressive ?? false; // Get aggressive flag

    const parts: string[] = [];
    const idents = _collectIdentifiers(instructions);

    parts.push(`import { effect } from '@dominator/core';\n`);
    parts.push(`import * as stateModule from ${JSON.stringify(stateImportPath)};\n\n`);
    if (_hasInlineEvents(instructions)) {
        parts.push('const _bind = (el: Element, type: string, handler: (e: any) => void) => el.addEventListener(type, handler as EventListener);\n\n');
    }
    parts.push(`export const ${functionName} = () => {\n`);
    parts.push('  const state = stateModule;\n');
    if (idents.length > 0) {
        parts.push(`  const { ${idents.join(', ')} } = state;\n\n`);
    } else {
        parts.push('\n');
    }
    _genBlock(parts, instructions, '  ', aggressive); // Pass aggressive flag
    const targets = new Set<string>();
    const children = new Set<string>();
    for (let i = 0; i < instructions.length; i++) {
        targets.add(instructions[i]!.target);
        if (instructions[i]!.op === 'append') { children.add(instructions[i]!.args[0] as string); }
    }
    let root: string | undefined;
    targets.forEach((t) => { if (!children.has(t)) root = t; });
    parts.push(`  return ${root};\n};`);
    return parts.join('');
};

function _toCamelCase(str: string): string {
    return str.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function _escapeStringArg(val: string): string {
    return JSON.stringify(val);
}

function _genBlock(parts: string[], instrs: Instruction[], indent: string, aggressive: boolean): void {
    for (let i = 0; i < instrs.length; i++) {
        const ins = instrs[i]!;
        const { op, target, args, nested } = ins;
        switch (op) {
            case 'create':
                parts.push(`${indent}const ${target} = document.createElement(${_escapeStringArg(String(args[0]))});\n`);
                break;
            case 'attr': {
                const [key, value] = args;
                const keyStr = String(key);

                if (aggressive && keyStr.startsWith('style:')) {
                    const styleProp = _toCamelCase(keyStr.split(':')[1]);
                    if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
                        const expr = value.slice(1, -1);
                        if (!validateExpression(expr)) {
                            throw new Error(`[dominator] Dangerous expression blocked in aggressive style binding: ${expr}`);
                        }
                        parts.push(`${indent}effect(() => { ${target}.style.${styleProp} = ${expr}; });\n`);
                    } else {
                        parts.push(`${indent}${target}.style.${styleProp} = ${JSON.stringify(value)};\n`);
                    }
                } else if (aggressive && (keyStr === 'className' || keyStr === 'textContent' || keyStr === 'value')) {
                    if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
                        const expr = value.slice(1, -1);
                        if (!validateExpression(expr)) {
                            throw new Error(`[dominator] Dangerous expression blocked in aggressive property binding: ${expr}`);
                        }
                        parts.push(`${indent}effect(() => { ${target}.${keyStr} = ${expr}; });\n`);
                    } else {
                        parts.push(`${indent}${target}.${keyStr} = ${JSON.stringify(value)};\n`);
                    }
                } else {
                    if (keyStr.startsWith('style:')) {
                        const styleProp = _toCamelCase(keyStr.split(':')[1]);
                        if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
                            const expr = value.slice(1, -1);
                            if (!validateExpression(expr)) {
                                throw new Error(`[dominator] Dangerous expression blocked in style attribute: ${expr}`);
                            }
                            parts.push(`${indent}effect(() => { ${target}.style[${JSON.stringify(styleProp)}] = String(${expr}); });\n`);
                        } else {
                            parts.push(`${indent}${target}.style[${JSON.stringify(styleProp)}] = ${JSON.stringify(value)};\n`);
                        }
                    } else if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
                        const expr = value.slice(1, -1);
                        if (!validateExpression(expr)) {
                            throw new Error(`[dominator] Dangerous expression blocked in attribute: ${expr}`);
                        }
                        parts.push(`${indent}effect(() => { ${target}.setAttribute(${_escapeStringArg(keyStr)}, String(${expr})); });\n`);
                    } else {
                        parts.push(`${indent}${target}.setAttribute(${_escapeStringArg(keyStr)}, ${JSON.stringify(value)});\n`);
                    }
                }
                break;
            }
            case 'event': {
                const [event, value] = args;
                if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
                    const expr = value.slice(1, -1);
                    if (!validateExpression(expr)) {
                        throw new Error(`[dominator] Dangerous expression blocked in event handler: ${expr}`);
                    }
                    parts.push(`${indent}_bind(${target}, ${_escapeStringArg(String(event))}, ${expr});\n`);
                } else {
                    parts.push(`${indent}_bind(${target}, ${_escapeStringArg(String(event))}, ${String(value)});\n`);
                }
                break;
            }
            case 'text':
                parts.push(`${indent}const ${target} = document.createTextNode(${JSON.stringify(args[0])});\n`);
                break;
            case 'expr': {
                const expr = String(args[0]);
                if (!validateExpression(expr)) {
                    throw new Error(`[dominator] Dangerous expression blocked: ${expr}`);
                }
                parts.push(`${indent}const ${target} = document.createTextNode('');\n`);
                parts.push(`${indent}effect(() => { ${target}.textContent = String(${expr}); });\n`);
                break;
            }
            case 'append':
                parts.push(`${indent}${target}.appendChild(${args[0]});\n`);
                break;
            case 'each': {
                const [source, context] = args;
                const iterVar = `${target}_i`;
                const arrVar = `${target}_a`;
                const ctxStr = context ? `${context}` : `${iterVar}`;
                parts.push(`${indent}const ${target} = document.createDocumentFragment();\n`);
                parts.push(`${indent}effect(() => {\n`);
                parts.push(`${indent}    ${target}.textContent = '';\n`);
                parts.push(`${indent}    const ${arrVar} = ${source} || [];\n`);
                parts.push(`${indent}    for (let ${iterVar} = 0; ${iterVar} < ${arrVar}.length; ${iterVar}++) {\n`);
                if (context) {
                    parts.push(`${indent}        const ${ctxStr} = ${arrVar}[${iterVar}];\n`);
                }
                if (nested) {
                    _genBlock(parts, nested, indent + '        ', aggressive); // Pass aggressive flag
                    const created = new Set(nested.filter((n) => n.op === 'create' || n.op === 'text' || n.op === 'expr' || n.op === 'each').map((n) => n.target));
                    const appended = new Set(nested.filter((n) => n.op === 'append').map((n) => n.args[0] as string));
                    created.forEach((r) => { if (!appended.has(r)) parts.push(`${indent}        ${target}.appendChild(${r});\n`); });
                }
                parts.push(`${indent}    }\n`);
                parts.push(`${indent}});\n`);
                break;
            }
            case 'if': {
                const expr = String(args[0]);
                if (!validateExpression(expr)) {
                    throw new Error(`[dominator] Dangerous expression blocked in conditional: ${expr}`);
                }
                const fragVar = `${target}_f`;
                parts.push(`${indent}const ${fragVar} = document.createDocumentFragment();\n`);
                parts.push(`${indent}effect(() => {\n`);
                parts.push(`${indent}  while (${fragVar}.firstChild) ${fragVar}.removeChild(${fragVar}.firstChild);\n`);
                parts.push(`${indent}  if (${expr}) {\n`);
                if (nested) { _genBlock(parts, nested, indent + '    ', aggressive); }
                const created = nested ? new Set(nested.filter((n) => n.op === 'create' || n.op === 'text' || n.op === 'expr' || n.op === 'each').map((n) => n.target)) : new Set<string>();
                const appended = nested ? new Set(nested.filter((n) => n.op === 'append').map((n) => n.args[0] as string)) : new Set<string>();
                created.forEach((r) => { if (!appended.has(r)) parts.push(`${indent}    ${fragVar}.appendChild(${r});\n`); });
                const { elseNested } = ins;
                const elseCondition = args[1] ? String(args[1]) : undefined;
                if (elseNested && elseNested.length > 0) {
                    if (elseCondition && elseCondition.length > 0) {
                        if (!validateExpression(elseCondition)) {
                            throw new Error(`[dominator] Dangerous expression blocked in else-if: ${elseCondition}`);
                        }
                        parts.push(`${indent}  } else if (${elseCondition}) {\n`);
                    } else {
                        parts.push(`${indent}  } else {\n`);
                    }
                    _genBlock(parts, elseNested, indent + '    ', aggressive);
                    const elseCreated = new Set(elseNested.filter((n) => n.op === 'create' || n.op === 'text' || n.op === 'expr' || n.op === 'each').map((n) => n.target));
                    const elseAppended = new Set(elseNested.filter((n) => n.op === 'append').map((n) => n.args[0] as string));
                    elseCreated.forEach((r) => { if (!elseAppended.has(r)) parts.push(`${indent}    ${fragVar}.appendChild(${r});\n`); });
                }
                parts.push(`${indent}  }\n`);
                parts.push(`${indent}});\n`);
                break;
            }
            case 'hoisted': {
                if (nested && nested.length > 0) {
                    parts.push(`${indent}effect(() => {\n`);
                    _genBlock(parts, nested, indent + '  ', aggressive); // Pass aggressive flag
                    parts.push(`${indent}});\n`);
                }
                break;
            }
        }
    }
}