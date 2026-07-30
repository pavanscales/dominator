/**
 * Arena Allocator — zero-allocation per frame, PARTITIONED EDITION.
 *
 * Pre-allocates large typed arrays per frame partition. Each partition
 * resets independently at the end of its lifecycle stage:
 *
 *   Layout Arena   → reset after LAYOUT stage
 *   Command Arena  → reset after GPU stage
 *   Animation Arena → reset after ANIMATION stage
 *   Temp Arena     → reset after COMMIT stage
 *
 * PARTITION BENEFITS:
 *   - Reduced cache pollution between layout/command/animation data
 *   - Independent reset cycles (layout arena doesn't wait for GPU)
 *   - Per-partition usage stats for adaptive sizing
 *   - SoA layout per partition (no interleaving of unrelated data)
 *
 * MEMORY LAYOUT:
 *   Block 0: entity arena (Int32Array)     — global, persists frame
 *   Block 1: float arena (Float64Array)    — global, persists frame
 *   Block 2: string arena (string[])       — global, persists frame
 *   Block 3: temp object arena (any[])     — global, persists frame
 *   Partition A: layout arena (Float64Array)    — layout results
 *   Partition B: command arena (Uint32Array)    — render commands
 *   Partition C: animation arena (Float64Array) — animation intermediates
 */

// ═══════════════════════════════════════════════════════════════════════════
// ARENA SIZES
// ═══════════════════════════════════════════════════════════════════════════

const ENTITY_ARENA_SIZE = 65536;
const FLOAT_ARENA_SIZE = 131072;
const STRING_ARENA_SIZE = 16384;
const TEMP_ARENA_SIZE = 8192;

// Partition sizes
const LAYOUT_ARENA_SIZE = 262144;    // 256K floats for layout results
const COMMAND_ARENA_SIZE = 524288;   // 512K u32 for render commands
const ANIM_ARENA_SIZE = 131072;      // 128K floats for animation data

// ═══════════════════════════════════════════════════════════════════════════
// ARENA STATE
// ═══════════════════════════════════════════════════════════════════════════

export interface ArenaPartition {
    data: Float64Array | Uint32Array;
    top: number;
    capacity: number;
}

export interface FrameArena {
    // Global blocks (persist entire frame)
    entities: Int32Array;
    entityTop: number;
    floats: Float64Array;
    floatTop: number;
    strings: string[];
    stringTop: number;
    temps: any[];
    tempTop: number;

    // Partitioned arenas (independent reset)
    layout: ArenaPartition;
    command: ArenaPartition;
    animation: ArenaPartition;

    // Stats
    frameAllocations: number;
    totalAllocations: number;
    layoutResets: number;
    commandResets: number;
    animResets: number;
}

let _arena: FrameArena | null = null;

export function getArena(): FrameArena {
    if (!_arena) _arena = createArena();
    return _arena;
}

export function createArena(): FrameArena {
    const a: FrameArena = {
        entities: new Int32Array(ENTITY_ARENA_SIZE),
        entityTop: 0,
        floats: new Float64Array(FLOAT_ARENA_SIZE),
        floatTop: 0,
        strings: new Array(STRING_ARENA_SIZE),
        stringTop: 0,
        temps: new Array(TEMP_ARENA_SIZE),
        tempTop: 0,

        layout: {
            data: new Float64Array(LAYOUT_ARENA_SIZE),
            top: 0,
            capacity: LAYOUT_ARENA_SIZE,
        },
        command: {
            data: new Uint32Array(COMMAND_ARENA_SIZE),
            top: 0,
            capacity: COMMAND_ARENA_SIZE,
        },
        animation: {
            data: new Float64Array(ANIM_ARENA_SIZE),
            top: 0,
            capacity: ANIM_ARENA_SIZE,
        },

        frameAllocations: 0,
        totalAllocations: 0,
        layoutResets: 0,
        commandResets: 0,
        animResets: 0,
    };
    _arena = a;
    return a;
}

// ═══════════════════════════════════════════════════════════════════════════
// ALLOCATION — bump pointer with geometric growth, no deallocation
// ═══════════════════════════════════════════════════════════════════════════

export function arenaAllocEntity(): number {
    const a = getArena();
    if (a.entityTop >= a.entities.length) {
        // Geometric growth — double capacity, reuse the larger buffer
        const newLen = Math.max(a.entities.length * 2, a.entityTop + 1024);
        const n = new Int32Array(newLen);
        n.set(a.entities.subarray(0, a.entityTop));
        a.entities = n;
    }
    const id = a.entityTop;
    a.entityTop++;
    a.frameAllocations++;
    a.totalAllocations++;
    return id;
}

export function arenaAllocEntities(count: number): number {
    const a = getArena();
    if (a.entityTop + count > a.entities.length) {
        const newLen = Math.max(a.entities.length * 2, a.entityTop + count + 1024);
        const n = new Int32Array(newLen);
        n.set(a.entities.subarray(0, a.entityTop));
        a.entities = n;
    }
    const base = a.entityTop;
    a.entityTop += count;
    a.frameAllocations += count;
    a.totalAllocations += count;
    return base;
}

export function arenaAllocFloat(): number {
    const a = getArena();
    if (a.floatTop >= a.floats.length) {
        const newLen = Math.max(a.floats.length * 2, a.floatTop + 1024);
        const n = new Float64Array(newLen);
        n.set(a.floats.subarray(0, a.floatTop));
        a.floats = n;
    }
    const idx = a.floatTop;
    a.floatTop++;
    a.frameAllocations++;
    return idx;
}

export function arenaAllocFloats(count: number): number {
    const a = getArena();
    if (a.floatTop + count > a.floats.length) {
        const newLen = Math.max(a.floats.length * 2, a.floatTop + count + 1024);
        const n = new Float64Array(newLen);
        n.set(a.floats.subarray(0, a.floatTop));
        a.floats = n;
    }
    const base = a.floatTop;
    a.floatTop += count;
    a.frameAllocations += count;
    return base;
}

export function arenaAllocString(str: string): number {
    const a = getArena();
    if (a.stringTop >= a.strings.length) {
        const newLen = Math.max(a.strings.length * 2, a.stringTop + 256);
        a.strings.length = newLen;
    }
    const idx = a.stringTop;
    a.strings[idx] = str;
    a.stringTop++;
    a.frameAllocations++;
    return idx;
}

export function arenaAllocTemp<T>(obj: T): number {
    const a = getArena();
    if (a.tempTop >= a.temps.length) {
        const newLen = Math.max(a.temps.length * 2, a.tempTop + 128);
        a.temps.length = newLen;
    }
    const idx = a.tempTop;
    a.temps[idx] = obj;
    a.tempTop++;
    a.frameAllocations++;
    return idx;
}

// ═══════════════════════════════════════════════════════════════════════════
// READ ACCESSORS
// ═══════════════════════════════════════════════════════════════════════════

export function arenaGetEntity(index: number): number {
    return getArena().entities[index];
}

export function arenaGetFloat(index: number): number {
    return getArena().floats[index];
}

export function arenaGetString(index: number): string {
    return getArena().strings[index];
}

export function arenaGetTemp(index: number): any {
    return getArena().temps[index];
}

export function arenaGetEntityView(): Int32Array {
    return getArena().entities;
}

export function arenaGetFloatView(): Float64Array {
    return getArena().floats;
}

// ═══════════════════════════════════════════════════════════════════════════
// PARTITION ALLOCATION — layout arena
// ═══════════════════════════════════════════════════════════════════════════

export function arenaAllocLayout(count: number): number {
    const a = getArena();
    const p = a.layout;
    if (p.top + count > p.capacity) {
        const newCap = Math.max(p.capacity * 2, p.top + count + 4096);
        const n = new Float64Array(newCap);
        n.set((p.data as Float64Array).subarray(0, p.top));
        p.data = n;
        p.capacity = newCap;
    }
    const base = p.top;
    p.top += count;
    a.frameAllocations += count;
    a.totalAllocations += count;
    return base;
}

export function arenaGetLayoutView(): Float64Array {
    return getArena().layout.data as Float64Array;
}

// ═══════════════════════════════════════════════════════════════════════════
// PARTITION ALLOCATION — command arena
// ═══════════════════════════════════════════════════════════════════════════

export function arenaAllocCommand(count: number): number {
    const a = getArena();
    const p = a.command;
    if (p.top + count > p.capacity) {
        const newCap = Math.max(p.capacity * 2, p.top + count + 4096);
        const n = new Uint32Array(newCap);
        n.set((p.data as Uint32Array).subarray(0, p.top));
        p.data = n;
        p.capacity = newCap;
    }
    const base = p.top;
    p.top += count;
    a.frameAllocations += count;
    a.totalAllocations += count;
    return base;
}

export function arenaGetCommandView(): Uint32Array {
    return getArena().command.data as Uint32Array;
}

// ═══════════════════════════════════════════════════════════════════════════
// PARTITION ALLOCATION — animation arena
// ═══════════════════════════════════════════════════════════════════════════

export function arenaAllocAnim(count: number): number {
    const a = getArena();
    const p = a.animation;
    if (p.top + count > p.capacity) {
        const newCap = Math.max(p.capacity * 2, p.top + count + 4096);
        const n = new Float64Array(newCap);
        n.set((p.data as Float64Array).subarray(0, p.top));
        p.data = n;
        p.capacity = newCap;
    }
    const base = p.top;
    p.top += count;
    a.frameAllocations += count;
    a.totalAllocations += count;
    return base;
}

export function arenaGetAnimView(): Float64Array {
    return getArena().animation.data as Float64Array;
}

// ═══════════════════════════════════════════════════════════════════════════
// PARTITION RESETS — independent reset per stage
// ═══════════════════════════════════════════════════════════════════════════

export function arenaResetLayout(): void {
    const a = getArena();
    a.layout.top = 0;
    a.layoutResets++;
}

export function arenaResetCommand(): void {
    const a = getArena();
    a.command.top = 0;
    a.commandResets++;
}

export function arenaResetAnim(): void {
    const a = getArena();
    a.animation.top = 0;
    a.animResets++;
}

// ═══════════════════════════════════════════════════════════════════════════
// FRAME RESET — bump pointers back to 0 (all partitions)
// ═══════════════════════════════════════════════════════════════════════════

export function arenaFrameReset(): void {
    const a = getArena();
    a.entityTop = 0;
    a.floatTop = 0;
    a.stringTop = 0;
    a.tempTop = 0;
    a.frameAllocations = 0;
    // Reset all partitions
    a.layout.top = 0;
    a.command.top = 0;
    a.animation.top = 0;
}

export function arenaFullReset(): void {
    _arena = null;
}

// ═══════════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════════

export function arenaStats(): {
    entityUsed: number;
    entityCap: number;
    floatUsed: number;
    floatCap: number;
    stringUsed: number;
    stringCap: number;
    tempUsed: number;
    tempCap: number;
    layoutUsed: number;
    layoutCap: number;
    commandUsed: number;
    commandCap: number;
    animUsed: number;
    animCap: number;
    frameAllocations: number;
    totalAllocations: number;
} {
    const a = getArena();
    return {
        entityUsed: a.entityTop,
        entityCap: a.entities.length,
        floatUsed: a.floatTop,
        floatCap: a.floats.length,
        stringUsed: a.stringTop,
        stringCap: a.strings.length,
        tempUsed: a.tempTop,
        tempCap: a.temps.length,
        layoutUsed: a.layout.top,
        layoutCap: a.layout.capacity,
        commandUsed: a.command.top,
        commandCap: a.command.capacity,
        animUsed: a.animation.top,
        animCap: a.animation.capacity,
        frameAllocations: a.frameAllocations,
        totalAllocations: a.totalAllocations,
    };
}

export function destroyArena(): void {
    _arena = null;
}
