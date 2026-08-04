export type ASTNodeType =
    | 'Program' | 'Element' | 'Text' | 'Expression' | 'Attribute'
    | 'Component' | 'Fragment' | 'If' | 'Each' | 'Await' | 'Else';

export interface SourceLocation {
    start: { line: number; column: number };
    end: { line: number; column: number };
}

export interface ASTNode {
    type: ASTNodeType;
    tag?: string | Function;
    attributes?: Record<string, string | boolean>;
    children?: ASTNode[];
    value?: string | number;
    expression?: string;
    context?: string;
    else?: ASTNode;
    isStatic?: boolean;
    loc?: SourceLocation;
}

interface Token {
    type: 'tag' | 'text' | 'open' | 'close' | 'selfClose' | 'attr' | 'expr' | 'eof' | 'blockOpen' | 'blockClose' | 'blockCont';
    value: string;
    loc: SourceLocation;
}

function isAlpha(c: number): boolean {
    return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isAlphaNum(c: number): boolean {
    return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isAlphaNumUnder(c: number): boolean {
    return c === 95 || isAlphaNum(c);
}

function isAlphaNumUnderDash(c: number): boolean {
    return c === 45 || isAlphaNumUnder(c);
}

function isAlphaNumUnderColonDash(c: number): boolean {
    return c === 58 || c === 45 || isAlphaNumUnder(c);
}

function isWhitespace(c: number): boolean {
    return c === 32 || c === 9 || c === 10 || c === 13;
}

class Tokenizer {
    private _src: string;
    private _len: number;
    private _pos = 0;
    private _line = 1;
    private _col = 1;
    private _tokens: Token[];
    private _tokenCount = 0;

    constructor(source: string) {
        this._src = source.trim();
        this._len = this._src.length;
        this._tokens = new Array(Math.max(16, (this._len >> 2) + 8));
    }

    tokenize(): Token[] {
        while (this._pos < this._len) {
            this._skipWs();
            const c = this._src.charCodeAt(this._pos);
            if (c === 60) {
                if (this._pos + 1 < this._len && this._src.charCodeAt(this._pos + 1) === 47) {
                    this._pushToken(this._readCloseTag());
                } else {
                    this._pushToken(this._readOpenTag());
                }
            } else if (c === 123) {
                const next = this._pos + 1 < this._len ? this._src.charCodeAt(this._pos + 1) : -1;
                if (next === 35 || next === 47 || next === 58) {
                    this._pushToken(this._readBlockToken());
                } else {
                    this._pushToken(this._readExpression());
                }
            } else {
                this._pushToken(this._readText());
            }
        }
        this._pushToken({ type: 'eof', value: '', loc: this._loc() });
        return this._tokens.slice(0, this._tokenCount);
    }

    private _pushToken(t: Token): void {
        if (this._tokenCount < this._tokens.length) {
            this._tokens[this._tokenCount] = t;
        } else {
            this._tokens.push(t);
        }
        this._tokenCount++;
    }

    private _loc(): SourceLocation {
        return { start: { line: this._line, column: this._col }, end: { line: this._line, column: this._col } };
    }

    private _skipWs(): void {
        while (this._pos < this._len && isWhitespace(this._src.charCodeAt(this._pos))) {
            this._advance();
        }
    }

    private _advance(): string {
        const ch = this._src[this._pos++];
        if (ch === '\n') { this._line++; this._col = 1; } else { this._col++; }
        return ch;
    }

    private _readOpenTag(): Token {
        const loc = this._loc();
        this._advance();
        this._skipWs();
        let nameStart = this._pos;
        while (this._pos < this._len && isAlphaNumUnderDash(this._src.charCodeAt(this._pos))) { this._pos++; }
        const tagName = this._src.slice(nameStart, this._pos);
        this._col += this._pos - nameStart;
        this._skipWs();
        const attrs: Record<string, string | boolean> = {};
        while (this._pos < this._len) {
            const c = this._src.charCodeAt(this._pos);
            if (c === 62 || c === 47) break;
            const attr = this._readAttribute();
            attrs[attr.name] = attr.value;
            this._skipWs();
        }
        let type: 'open' | 'selfClose' = 'open';
        if (this._pos < this._len && this._src.charCodeAt(this._pos) === 47) { this._advance(); type = 'selfClose'; }
        if (this._pos < this._len && this._src.charCodeAt(this._pos) === 62) { this._advance(); }
        return { type, value: JSON.stringify({ tag: tagName, attributes: attrs }), loc };
    }

    private _readCloseTag(): Token {
        const loc = this._loc();
        this._advance();
        this._advance();
        let start = this._pos;
        while (this._pos < this._len && this._src.charCodeAt(this._pos) !== 62) { this._pos++; }
        const name = this._src.slice(start, this._pos).trim();
        this._col += this._pos - start;
        if (this._pos < this._len) this._advance();
        return { type: 'close', value: name, loc };
    }

    private _readAttribute(): { name: string; value: string | boolean } {
        let start = this._pos;
        while (this._pos < this._len && isAlphaNumUnderColonDash(this._src.charCodeAt(this._pos))) { this._pos++; }
        const name = this._src.slice(start, this._pos);
        this._col += this._pos - start;
        this._skipWs();
        if (this._pos >= this._len || this._src.charCodeAt(this._pos) !== 61) { return { name, value: true }; }
        this._advance();
        this._skipWs();
        const c = this._src.charCodeAt(this._pos);
        if (c === 34 || c === 39) {
            const quote = this._advance();
            start = this._pos;
            while (this._pos < this._len && this._src.charCodeAt(this._pos) !== c) { this._pos++; }
            const val = this._src.slice(start, this._pos);
            this._col += this._pos - start;
            if (this._pos < this._len && this._src.charCodeAt(this._pos) === c) this._advance();
            return { name, value: val };
        }
        if (c === 123) {
            this._advance();
            start = this._pos;
            let depth = 1;
            while (depth > 0 && this._pos < this._len) {
                const ch = this._src.charCodeAt(this._pos);
                if (ch === 123) depth++; else if (ch === 125) depth--;
                this._pos++;
            }
            this._col += this._pos - start;
            const expr = this._src.slice(start, this._pos - 1);
            return { name, value: `{${expr}}` };
        }
        start = this._pos;
        while (this._pos < this._len && isAlphaNumUnder(this._src.charCodeAt(this._pos))) { this._pos++; }
        const val = this._src.slice(start, this._pos);
        this._col += this._pos - start;
        return { name, value: val };
    }

    private _readExpression(): Token {
        const loc = this._loc();
        this._advance();
        const start = this._pos;
        let depth = 1;
        while (depth > 0 && this._pos < this._len) {
            const c = this._src.charCodeAt(this._pos);
            if (c === 123) depth++; else if (c === 125) depth--;
            this._pos++;
        }
        this._col += this._pos - start;
        return { type: 'expr', value: this._src.slice(start, this._pos - 1).trim(), loc };
    }

    private _readText(): Token {
        const loc = this._loc();
        const start = this._pos;
        while (this._pos < this._len) {
            const c = this._src.charCodeAt(this._pos);
            if (c === 60 || c === 123) break;
            this._pos++;
        }
        this._col += this._pos - start;
        return { type: 'text', value: this._src.slice(start, this._pos).trim(), loc };
    }

    private _readBlockToken(): Token {
        const loc = this._loc();
        this._advance();
        const typeChar = this._advance();
        let type: 'blockOpen' | 'blockClose' | 'blockCont';
        if (typeChar === '#') type = 'blockOpen';
        else if (typeChar === '/') type = 'blockClose';
        else type = 'blockCont';
        const start = this._pos;
        while (this._pos < this._len && this._src.charCodeAt(this._pos) !== 125) { this._pos++; }
        this._col += this._pos - start;
        const content = this._src.slice(start, this._pos).trim();
        if (this._pos < this._len) this._advance();
        return { type, value: content, loc };
    }
}

export class Parser {
    private _tokens: Token[] = [];
    private _pos = 0;

    parse(source: string): ASTNode {
        const tokenizer = new Tokenizer(source);
        this._tokens = tokenizer.tokenize();
        this._pos = 0;
        const children = this._parseChildren();
        return { type: 'Program', children };
    }

    private _current(): Token { return this._tokens[this._pos]!; }
    private _advance(): Token { return this._tokens[this._pos++]!; }

    private _parseChildren(): ASTNode[] {
        const children: ASTNode[] = [];
        while (true) {
            const t = this._current();
            if (!t || t.type === 'close' || t.type === 'blockClose' || t.type === 'blockCont' || t.type === 'eof') break;
            const node = this._parseNode();
            if (node) children.push(node);
        }
        return children;
    }

    private _parseNode(): ASTNode | null {
        const t = this._current();
        if (!t) return null;
        switch (t.type) {
            case 'text': return this._parseText();
            case 'expr': return this._parseExpression();
            case 'open': case 'selfClose': return this._parseElement();
            case 'blockOpen': return this._parseBlock();
            case 'eof': return null;
            default: this._advance(); return null;
        }
    }

    private _parseText(): ASTNode { const t = this._advance(); return { type: 'Text', value: t.value, isStatic: true, loc: t.loc }; }
    private _parseExpression(): ASTNode { const t = this._advance(); return { type: 'Expression', expression: t.value, isStatic: false, loc: t.loc }; }

    private _parseElement(): ASTNode {
        const t = this._advance();
        const data = JSON.parse(t.value);
        const node: ASTNode = { type: /^[A-Z]/.test(data.tag) ? 'Component' : 'Element', tag: data.tag, attributes: data.attributes, loc: t.loc };
        if (t.type === 'selfClose') { node.children = []; return node; }
        node.children = this._parseChildren();
        if (this._current()?.type === 'close') this._advance();
        return node;
    }

    private _parseBlock(): ASTNode {
        const t = this._advance();
        const parts = t.value.split(/\s+/);
        const tagName = parts[0];
        if (tagName === 'each') {
            const asIndex = parts.indexOf('as');
            let expression: string;
            let context: string;
            if (asIndex === -1) {
                expression = parts.slice(1).join(' ');
                context = '';
            } else {
                expression = parts.slice(1, asIndex).join(' ');
                context = parts.slice(asIndex + 1).join(' ');
            }
            const children = this._parseChildren();
            this._advance();
            return { type: 'Each', expression, context, children, loc: t.loc };
        }
        if (tagName === 'if') {
            const expression = parts.slice(1).join(' ');
            const children = this._parseChildren();
            let elseNode: ASTNode | undefined;
            if (this._current()?.type === 'blockCont' && this._current().value.startsWith('else')) {
                this._advance();
                elseNode = { type: 'Else', children: this._parseChildren() };
            }
            this._advance();
            return { type: 'If', expression, children, else: elseNode, loc: t.loc };
        }
        throw new Error(`Unknown block type: ${tagName}`);
    }
}

export function parse(source: string): ASTNode {
    return new Parser().parse(source);
}

export function isStaticNode(node: ASTNode): boolean {
    if (node.type === 'Expression') return false;
    if (node.type === 'If' || node.type === 'Each' || node.type === 'Await' || node.type === 'Else') return false;
    if (node.type === 'Text') return true;
    if (node.attributes) {
        const keys = Object.keys(node.attributes);
        for (let i = 0; i < keys.length; i++) {
            const val = node.attributes[keys[i]];
            if (typeof val === 'string' && val.charCodeAt(0) === 123) return false;
        }
    }
    if (node.children) {
        for (let i = 0; i < node.children.length; i++) {
            if (!isStaticNode(node.children[i]!)) return false;
        }
    }
    return true;
}
