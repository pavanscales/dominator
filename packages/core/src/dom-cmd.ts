/**
 * DomCmd: BARE METAL — Zero-Allocation DOM Command Buffer
 *
 * v5 optimizations:
 * - Jump-table dispatch in drain loop (eliminates switch overhead)
 * - Bounded string table with eviction (no unbounded memory growth)
 * - Element ID recycling with generation tags (no unbounded Map growth)
 */

const CMD_BUF_SIZE = 1 << 18;
const CMD_BUF_MASK = CMD_BUF_SIZE - 1;

let _cmdBuf = new Uint32Array(CMD_BUF_SIZE);
let _cmdWriteHead = 0;
let _cmdReadHead = 0;

// Opcodes
export const OP_NOP = 0;
export const OP_SET_ATTR = 1;
export const OP_SET_STYLE = 2;
export const OP_SET_TEXT = 3;
export const OP_ADD_CLASS = 4;
export const OP_RM_CLASS = 5;
export const OP_TOGGLE = 6;
export const OP_SET_PROP = 7;
export const OP_REMOVE_ATTR = 8;
export const OP_BATCH_BEGIN = 16;
export const OP_BATCH_END = 17;

// ═══════════════════════════════════════════════════════════════════════════
// BOUNDED STRING TABLE — LRU eviction via generation sweep
// ═══════════════════════════════════════════════════════════════════════════

const MAX_STRINGS = 2048;
const _strTable: string[] = [];
const _strToIntern = new Map<string, number>();
let _strGen = 0;
let _strLastUsed: Uint32Array | null = null;
// Pre-allocated eviction scratch buffer — zero allocation per eviction
const _evictScratch = new Int32Array(MAX_STRINGS);

function _intern(str: string): number {
    let id = _strToIntern.get(str);
    if (id !== undefined) {
        if (_strLastUsed && id < _strLastUsed.length) {
            _strLastUsed[id] = _strGen;
        }
        return id;
    }
    // Evict if full
    if (_strTable.length >= MAX_STRINGS) {
        _evictStrings();
    }
    // Find first empty slot or append
    id = _strTable.indexOf('');
    if (id === -1) {
        id = _strTable.length;
        _strTable.push(str);
    } else {
        _strTable[id] = str;
    }
    _strToIntern.set(str, id);
    if (_strLastUsed && id >= _strLastUsed.length) {
        const newLu = new Uint32Array(MAX_STRINGS + 256);
        newLu.set(_strLastUsed);
        _strLastUsed = newLu;
    }
    if (!_strLastUsed) {
        _strLastUsed = new Uint32Array(MAX_STRINGS + 256);
    }
    _strLastUsed[id] = _strGen;
    return id;
}

function _evictStrings(): void {
    const gen = _strGen;
    const lu = _strLastUsed!;
    let evictCount = 0;
    const limit = Math.min(_strTable.length, MAX_STRINGS);
    for (let i = 0; i < limit; i++) {
        if (lu[i] < gen - 2) {
            if (evictCount < MAX_STRINGS) {
                _evictScratch[evictCount++] = i;
            }
        }
    }
    for (let j = 0; j < evictCount; j++) {
        const idx = _evictScratch[j];
        _strToIntern.delete(_strTable[idx]);
        _strTable[idx] = '';
    }
    if (evictCount === 0 && _strTable.length >= MAX_STRINGS) {
        // Emergency: remove oldest half
        const half = _strTable.length >> 1;
        for (let i = 0; i < half; i++) {
            _strToIntern.delete(_strTable[i]);
            _strTable[i] = '';
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// ELEMENT STAMP TABLE — direct property + bounded reverse map
// ═══════════════════════════════════════════════════════════════════════════

const DID_PROP = '__domCmdId';
const MAX_ELEM_IDS = 16384;
let _elemIds: (Node | null)[] = new Array(MAX_ELEM_IDS);
let _elemIdGen = new Uint32Array(MAX_ELEM_IDS);
let _nextElemId = 1;
let _elemGen = 0;

function _getElemId(node: Node): number {
    let id = (node as any)[DID_PROP] as number | undefined;
    if (id === undefined) {
        if (_nextElemId < MAX_ELEM_IDS) {
            id = _nextElemId++;
        } else {
            // Table full — scan for stale slot (generation older than current frame)
            id = -1;
            for (let i = 1; i < MAX_ELEM_IDS; i++) {
                if (_elemIdGen[i] < _elemGen) {
                    id = i;
                    break;
                }
            }
            if (id === -1) {
                // All slots actively used this frame — evict oldest
                id = 1;
                const old = _elemIds[1];
                if (old && old !== node) {
                    delete (old as any)[DID_PROP];
                }
            }
        }
        (node as any)[DID_PROP] = id;
    }
    _elemIdGen[id] = _elemGen;
    _elemIds[id] = node;
    return id;
}

export function _resetCmdBuffer(): void {
    _cmdBuf = new Uint32Array(CMD_BUF_SIZE);
    _cmdWriteHead = 0;
    _cmdReadHead = 0;
    _strTable.length = 0;
    _strToIntern.clear();
    _strGen = 0;
    _strLastUsed = null;
    _elemIds = new Array(MAX_ELEM_IDS);
    _elemIdGen = new Uint32Array(MAX_ELEM_IDS);
    _nextElemId = 1;
    _elemGen = 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMAND EMITTERS
// ═══════════════════════════════════════════════════════════════════════════

function _emit1(op: number, elemId: number): void {
    const w = _cmdWriteHead;
    _cmdBuf[w & CMD_BUF_MASK] = op;
    _cmdBuf[(w + 1) & CMD_BUF_MASK] = elemId;
    _cmdWriteHead = w + 2;
}

function _emit2(op: number, elemId: number, a0: number, a1: number): void {
    const w = _cmdWriteHead;
    _cmdBuf[w & CMD_BUF_MASK] = op;
    _cmdBuf[(w + 1) & CMD_BUF_MASK] = elemId;
    _cmdBuf[(w + 2) & CMD_BUF_MASK] = a0;
    _cmdBuf[(w + 3) & CMD_BUF_MASK] = a1;
    _cmdWriteHead = w + 4;
}

function _emit3(op: number, elemId: number, a0: number, a1: number, a2: number): void {
    const w = _cmdWriteHead;
    _cmdBuf[w & CMD_BUF_MASK] = op;
    _cmdBuf[(w + 1) & CMD_BUF_MASK] = elemId;
    _cmdBuf[(w + 2) & CMD_BUF_MASK] = a0;
    _cmdBuf[(w + 3) & CMD_BUF_MASK] = a1;
    _cmdBuf[(w + 4) & CMD_BUF_MASK] = a2;
    _cmdWriteHead = w + 5;
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC BATCHED DOM API
// ═══════════════════════════════════════════════════════════════════════════

export function cmdSetAttr(el: Node, key: string, value: string): void {
    _emit2(OP_SET_ATTR, _getElemId(el), _intern(key), _intern(value));
}

export function cmdSetStyle(el: Node, prop: string, value: string): void {
    _emit2(OP_SET_STYLE, _getElemId(el), _intern(prop), _intern(value));
}

export function cmdSetText(el: Node, text: string): void {
    _emit1(OP_SET_TEXT, _getElemId(el));
    const w = _cmdWriteHead;
    _cmdBuf[w & CMD_BUF_MASK] = _intern(text);
    _cmdWriteHead = w + 1;
}

export function cmdAddClass(el: Node, className: string): void {
    _emit2(OP_ADD_CLASS, _getElemId(el), _intern(className), 0);
}

export function cmdRemoveClass(el: Node, className: string): void {
    _emit2(OP_RM_CLASS, _getElemId(el), _intern(className), 0);
}

export function cmdToggleClass(el: Node, className: string, on: boolean): void {
    _emit2(OP_TOGGLE, _getElemId(el), _intern(className), on ? 1 : 0);
}

export function cmdSetProp(el: Node, prop: string, value: string): void {
    _emit2(OP_SET_PROP, _getElemId(el), _intern(prop), _intern(value));
}

export function cmdRemoveAttr(el: Node, key: string): void {
    _emit1(OP_REMOVE_ATTR, _getElemId(el));
    const w = _cmdWriteHead;
    _cmdBuf[w & CMD_BUF_MASK] = _intern(key);
    _cmdWriteHead = w + 1;
}

// ═══════════════════════════════════════════════════════════════════════════
// JUMP TABLE DISPATCH — eliminates switch overhead in drain loop
//
// Array of handler functions indexed by opcode.
// Each handler returns the number of u32 slots consumed.
// ═══════════════════════════════════════════════════════════════════════════

type OpHandler = (buf: Uint32Array, rh: number) => number;

const _opHandlers: OpHandler[] = [];

const _nop: OpHandler = () => 1;

const _setAttr: OpHandler = (buf, rh) => {
    const node = _elemIds[buf[(rh + 1) & CMD_BUF_MASK]];
    if (node) {
        (node as Element).setAttribute(
            _strTable[buf[(rh + 2) & CMD_BUF_MASK]],
            _strTable[buf[(rh + 3) & CMD_BUF_MASK]]
        );
    }
    return 4;
};

const _setStyle: OpHandler = (buf, rh) => {
    const node = _elemIds[buf[(rh + 1) & CMD_BUF_MASK]];
    if (node) {
        (node as HTMLElement).style.setProperty(
            _strTable[buf[(rh + 2) & CMD_BUF_MASK]],
            _strTable[buf[(rh + 3) & CMD_BUF_MASK]]
        );
    }
    return 4;
};

const _setText: OpHandler = (buf, rh) => {
    const node = _elemIds[buf[(rh + 1) & CMD_BUF_MASK]];
    if (node) {
        node.textContent = _strTable[buf[(rh + 2) & CMD_BUF_MASK]];
    }
    return 3;
};

const _addClass: OpHandler = (buf, rh) => {
    const node = _elemIds[buf[(rh + 1) & CMD_BUF_MASK]];
    if (node) {
        (node as Element).classList.add(_strTable[buf[(rh + 2) & CMD_BUF_MASK]]);
    }
    return 3;
};

const _rmClass: OpHandler = (buf, rh) => {
    const node = _elemIds[buf[(rh + 1) & CMD_BUF_MASK]];
    if (node) {
        (node as Element).classList.remove(_strTable[buf[(rh + 2) & CMD_BUF_MASK]]);
    }
    return 3;
};

const _toggle: OpHandler = (buf, rh) => {
    const node = _elemIds[buf[(rh + 1) & CMD_BUF_MASK]];
    if (node) {
        (node as Element).classList.toggle(
            _strTable[buf[(rh + 2) & CMD_BUF_MASK]],
            buf[(rh + 3) & CMD_BUF_MASK] === 1
        );
    }
    return 4;
};

const _setProp: OpHandler = (buf, rh) => {
    const node = _elemIds[buf[(rh + 1) & CMD_BUF_MASK]];
    if (node) {
        (node as any)[_strTable[buf[(rh + 2) & CMD_BUF_MASK]]] =
            _strTable[buf[(rh + 3) & CMD_BUF_MASK]];
    }
    return 4;
};

const _removeAttr: OpHandler = (buf, rh) => {
    const node = _elemIds[buf[(rh + 1) & CMD_BUF_MASK]];
    if (node) {
        (node as Element).removeAttribute(_strTable[buf[(rh + 2) & CMD_BUF_MASK]]);
    }
    return 3;
};

// Register handlers
const MAX_OP = 20;
function _initHandlers(): void {
    for (let i = 0; i <= MAX_OP; i++) _opHandlers[i] = _nop;
    _opHandlers[OP_SET_ATTR] = _setAttr;
    _opHandlers[OP_SET_STYLE] = _setStyle;
    _opHandlers[OP_SET_TEXT] = _setText;
    _opHandlers[OP_ADD_CLASS] = _addClass;
    _opHandlers[OP_RM_CLASS] = _rmClass;
    _opHandlers[OP_TOGGLE] = _toggle;
    _opHandlers[OP_SET_PROP] = _setProp;
    _opHandlers[OP_REMOVE_ATTR] = _removeAttr;
}
_initHandlers();

// ═══════════════════════════════════════════════════════════════════════════
// DRAIN — jump-table dispatch, single pass
// ═══════════════════════════════════════════════════════════════════════════

export function drainCmdBuffer(): void {
    const readEnd = _cmdWriteHead;
    if (readEnd === _cmdReadHead) return;

    const buf = _cmdBuf;
    let rh = _cmdReadHead;

    _strGen++;
    _elemGen++;

    while (rh < readEnd) {
        const op = buf[rh & CMD_BUF_MASK];
        const handler = op <= MAX_OP ? _opHandlers[op] : _nop;
        rh += handler(buf, rh);
    }

    _cmdReadHead = rh;

    if (_cmdReadHead === _cmdWriteHead) {
        _cmdWriteHead = 0;
        _cmdReadHead = 0;
    }
}

export function cmdBufferPending(): boolean {
    return _cmdWriteHead !== _cmdReadHead;
}

export function cmdBufferSize(): number {
    return _cmdWriteHead - _cmdReadHead;
}
