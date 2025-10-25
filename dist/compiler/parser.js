// --------------------------
// src/compiler/parser.ts
// --------------------------
// --------------------------
// Tokenizer
// --------------------------
class Tokenizer {
    constructor(source) {
        this.pos = 0;
        this.line = 1;
        this.column = 1;
        this.source = source.trim();
    }
    peek() {
        return this.source[this.pos] || '';
    }
    advance() {
        const char = this.source[this.pos++];
        if (char === '\n') {
            this.line++;
            this.column = 1;
        }
        else {
            this.column++;
        }
        return char;
    }
    skipWhitespace() {
        while (this.pos < this.source.length && /\s/.test(this.peek())) {
            this.advance();
        }
    }
    getLocation() {
        return {
            start: { line: this.line, column: this.column },
            end: { line: this.line, column: this.column },
        };
    }
    tokenize() {
        const tokens = [];
        while (this.pos < this.source.length) {
            this.skipWhitespace();
            if (this.peek() === '<') {
                if (this.source[this.pos + 1] === '/') {
                    tokens.push(this.readCloseTag());
                }
                else {
                    tokens.push(this.readOpenTag());
                }
            }
            else if (this.peek() === '{') {
                tokens.push(this.readExpression());
            }
            else {
                tokens.push(this.readText());
            }
        }
        tokens.push({ type: 'eof', value: '', loc: this.getLocation() });
        return tokens;
    }
    readOpenTag() {
        const loc = this.getLocation();
        this.advance(); // '<'
        this.skipWhitespace();
        let tagName = '';
        while (this.peek() && /[a-zA-Z0-9_-]/.test(this.peek())) {
            tagName += this.advance();
        }
        this.skipWhitespace();
        const attributes = {};
        while (this.peek() && this.peek() !== '>' && this.peek() !== '/') {
            const attr = this.readAttribute();
            attributes[attr.name] = attr.value;
            this.skipWhitespace();
        }
        let type = 'open';
        if (this.peek() === '/') {
            this.advance();
            type = 'selfClose';
        }
        if (this.peek() === '>')
            this.advance();
        return {
            type,
            value: JSON.stringify({ tag: tagName, attributes }),
            loc,
        };
    }
    readCloseTag() {
        const loc = this.getLocation();
        this.advance(); // '<'
        this.advance(); // '/'
        let tagName = '';
        while (this.peek() && this.peek() !== '>') {
            tagName += this.advance();
        }
        if (this.peek() === '>')
            this.advance();
        return { type: 'close', value: tagName.trim(), loc };
    }
    readAttribute() {
        let name = '';
        while (this.peek() && /[a-zA-Z0-9_-]/.test(this.peek()))
            name += this.advance();
        this.skipWhitespace();
        if (this.peek() !== '=')
            return { name, value: true };
        this.advance();
        this.skipWhitespace();
        if (this.peek() === '"' || this.peek() === "'") {
            const quote = this.advance();
            let value = '';
            while (this.peek() && this.peek() !== quote)
                value += this.advance();
            this.advance();
            return { name, value };
        }
        if (this.peek() === '{') {
            this.advance();
            let expr = '';
            let depth = 1;
            while (depth > 0) {
                const char = this.advance();
                if (char === '{')
                    depth++;
                if (char === '}')
                    depth--;
                if (depth > 0)
                    expr += char;
            }
            return { name, value: `{${expr}}` };
        }
        let value = '';
        while (this.peek() && /[a-zA-Z0-9_]/.test(this.peek()))
            value += this.advance();
        return { name, value };
    }
    readExpression() {
        const loc = this.getLocation();
        this.advance(); // '{'
        let expr = '';
        let depth = 1;
        while (depth > 0 && this.pos < this.source.length) {
            const char = this.advance();
            if (char === '{')
                depth++;
            if (char === '}')
                depth--;
            if (depth > 0)
                expr += char;
        }
        return { type: 'expr', value: expr.trim(), loc };
    }
    readText() {
        const loc = this.getLocation();
        let text = '';
        while (this.peek() && this.peek() !== '<' && this.peek() !== '{')
            text += this.advance();
        return { type: 'text', value: text.trim(), loc };
    }
}
// --------------------------
// Parser
// --------------------------
export class Parser {
    constructor() {
        this.tokens = [];
        this.pos = 0;
    }
    parse(source) {
        const tokenizer = new Tokenizer(source);
        this.tokens = tokenizer.tokenize();
        this.pos = 0;
        const children = this.parseChildren();
        return { type: 'Program', children };
    }
    current() {
        return this.tokens[this.pos];
    }
    advance() {
        return this.tokens[this.pos++];
    }
    parseChildren() {
        const children = [];
        while (this.current() && this.current().type !== 'close' && this.current().type !== 'eof') {
            const node = this.parseNode();
            if (node)
                children.push(node);
        }
        return children;
    }
    parseNode() {
        const token = this.current();
        if (!token)
            return null;
        if (token.type === 'text')
            return this.parseText();
        if (token.type === 'expr')
            return this.parseExpression();
        if (token.type === 'open' || token.type === 'selfClose')
            return this.parseElement();
        if (token.type === 'eof')
            return null;
        this.advance();
        return null;
    }
    parseText() {
        const token = this.advance();
        return { type: 'Text', value: token.value, isStatic: true, loc: token.loc };
    }
    parseExpression() {
        const token = this.advance();
        return { type: 'Expression', expression: token.value, isStatic: false, loc: token.loc };
    }
    parseElement() {
        const token = this.advance();
        const data = JSON.parse(token.value);
        const node = {
            type: /^[A-Z]/.test(data.tag) ? 'Component' : 'Element',
            tag: data.tag,
            attributes: data.attributes,
            loc: token.loc,
        };
        if (token.type === 'selfClose') {
            node.children = [];
            return node;
        }
        node.children = this.parseChildren();
        if (this.current() && this.current().type === 'close')
            this.advance();
        return node;
    }
}
// --------------------------
// Export helpers
// --------------------------
export function parse(source) {
    const parser = new Parser();
    return parser.parse(source);
}
export function isStaticNode(node) {
    if (node.type === 'Expression')
        return false;
    if (node.type === 'Text')
        return true;
    if (node.attributes) {
        for (const key in node.attributes) {
            const value = node.attributes[key];
            if (typeof value === 'string' && value.startsWith('{'))
                return false;
        }
    }
    if (node.children)
        return node.children.every(child => isStaticNode(child));
    return true;
}
