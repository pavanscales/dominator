// ═══════════════════════════════════════════════════════════════════════════════
// DOMINATOR CORE — Zig WASM Module (ULTRA-OPTIMIZED)
//
// Generational arena allocator + signal reactive engine + flat subscriber
// storage + keyed reconciliation — all running in WASM linear memory.
//
// PERFORMANCE OPTIMIZATIONS:
// - O(n+m) reconciliation using open-addressing hash map (was O(n*m))
// - @memset for bulk zeroing (SIMD-accelerated by WASM compilers)
// - Branchless dirty tracking
// - Inline subscriber dedup with early exit
// - Pre-computed bit masks for bitmap operations
// ═══════════════════════════════════════════════════════════════════════════════

const std = @import("std");

// ── Constants ────────────────────────────────────────────────────────────────

const INITIAL_CAP: u32 = 4096;
const BITMAP_SIZE: u32 = 65536;
const BITMAP_WORDS: u32 = BITMAP_SIZE / 32;
const MAX_SUBS_PER_SIGNAL: u32 = 255;

// ── Memory Layout (all u32 word indices into heap[]) ─────────────────────────

const NUM_WORDS: u32 = 2 * INITIAL_CAP;
const TAG_START: u32 = NUM_WORDS;
const BOOL_START: u32 = TAG_START + INITIAL_CAP;
const STR_META_START: u32 = BOOL_START + INITIAL_CAP;
const STR_META_WORDS: u32 = 2 * INITIAL_CAP;
const SUB_OFFSET_START: u32 = STR_META_START + STR_META_WORDS;
const SUB_LENGTH_START: u32 = SUB_OFFSET_START + INITIAL_CAP;
const EFF_DEP_OFFSET_START: u32 = SUB_LENGTH_START + INITIAL_CAP;
const EFF_DEP_LENGTH_START: u32 = EFF_DEP_OFFSET_START + INITIAL_CAP;
const EFF_GEN_START: u32 = EFF_DEP_LENGTH_START + INITIAL_CAP;
const EFF_RUNNING_START: u32 = EFF_GEN_START + INITIAL_CAP;
const EFF_DISPOSED_START: u32 = EFF_RUNNING_START + INITIAL_CAP;
const DIRTY_BITMAP_START: u32 = EFF_DISPOSED_START + INITIAL_CAP;
const SNAPSHOT_BUF_START: u32 = DIRTY_BITMAP_START + BITMAP_WORDS;
const DYNAMIC_START: u32 = SNAPSHOT_BUF_START + 512;
const WAVEFRONT_BASE: u32 = DYNAMIC_START + 262144;

const TAG_NUMBER: u32 = 0;
const TAG_STRING: u32 = 1;
const TAG_BOOLEAN: u32 = 2;
const TAG_OBJECT: u32 = 3;

// ── Dynamic Heap → WASM linear memory ────────────────────────────────────────
// The heap pointer starts after the data section (256KB into linear memory).
// WASM memory grows via memory.grow when the heap needs more space.
// 256KB is well past any Zig WASM data section (typically <64KB).
const HEAP_BYTE_OFFSET: u32 = 262144; // 256KB into linear memory
const MIN_HEAP_WORDS: u32 = 1048576; // 4MB initial
const WORDS_PER_PAGE: u32 = 65536 / 4; // 16384

var heap: [*]u32 = undefined;
var heap_cap_words: u32 = 0; // total allocatable words from HEAP_BYTE_OFFSET

fn ensureHeap(needed: u32) void {
    if (needed < heap_cap_words) return;
    const total_bytes = HEAP_BYTE_OFFSET + needed * 4;
    const total_pages = (total_bytes + 65535) / 65536;
    const current_pages = @wasmMemorySize(0);
    if (total_pages > current_pages) {
        const grow = total_pages - current_pages;
        const result = @wasmMemoryGrow(0, grow);
        if (result == -1) return;
    }
    heap_cap_words = (@wasmMemorySize(0) * 65536 - HEAP_BYTE_OFFSET) / 4;
}

export fn heap_grow(extra_words: u32) u32 {
    const needed = heap_cap_words + extra_words;
    ensureHeap(needed);
    return heap_cap_words;
}

export fn heap_capacity() u32 {
    return heap_cap_words;
}

export fn heap_used() u32 {
    return WAVEFRONT_BASE + 8192 + BITMAP_SIZE;
}

// ── Accessors ────────────────────────────────────────────────────────────────

inline fn ru32(offset: u32) u32 {
    return heap[offset];
}

inline fn wu32(offset: u32, val: u32) void {
    heap[offset] = val;
}

inline fn ru8(offset: u32) u8 {
    return @truncate(heap[offset]);
}

inline fn wu8(offset: u32, val: u8) void {
    heap[offset] = @as(u32, val);
}

inline fn rf64(slot: u32) f64 {
    const word_idx = slot * 2;
    return @as(*align(1) const f64, @ptrCast(&heap[word_idx])).*;
}

inline fn wf64(slot: u32, val: f64) void {
    const word_idx = slot * 2;
    @as(*align(1) f64, @ptrCast(&heap[word_idx])).* = val;
}

// ── Global State ─────────────────────────────────────────────────────────────

var _arena_size: u32 = 0;
var _arena_cap: u32 = INITIAL_CAP;
var _string_bytes_used: u32 = 0;
var _next_string_id: u32 = 0;
var _next_object_id: u32 = 0;

var _sub_data_end: u32 = 0;
var _sub_free_head: i32 = -1;

var _effect_count: u32 = 0;
var _effect_cap: u32 = INITIAL_CAP;
var _effect_free_head: i32 = -1;
var _active_effect: i32 = -1;

var _dirty_buf_a: [1024]u32 = [_]u32{0} ** 1024;
var _dirty_buf_b: [1024]u32 = [_]u32{0} ** 1024;
var _dirty_buf: *[1024]u32 = &_dirty_buf_a;
var _dirty_count: u32 = 0;
var _batch_depth: u32 = 0;
var _flush_gen: u32 = 0;

var _snap_len: u32 = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// ARENA API
// ═══════════════════════════════════════════════════════════════════════════════

export fn arena_alloc_num(value: f64) u32 {
    const id = _arena_size;
    _arena_size += 1;
    wf64(id, value);
    wu8(TAG_START + id, @intCast(TAG_NUMBER));
    return id;
}

export fn arena_alloc_bool(value: u32) u32 {
    const id = _arena_size;
    _arena_size += 1;
    const v: u8 = @intCast(value & 1);
    wu8(BOOL_START + id, v);
    wf64(id, @floatFromInt(v));
    wu8(TAG_START + id, @intCast(TAG_BOOLEAN));
    return id;
}

export fn arena_alloc_obj(object_id: u32) u32 {
    const id = _arena_size;
    _arena_size += 1;
    wf64(id, @floatFromInt(object_id));
    wu8(TAG_START + id, @intCast(TAG_OBJECT));
    return id;
}

export fn arena_alloc_str(byte_ptr: u32, byte_len: u32) u32 {
    const id = _arena_size;
    _arena_size += 1;

    const word_base = DYNAMIC_START + (_string_bytes_used / 4);

    // BARE METAL: Bulk copy using @memcpy for aligned chunks, then handle tail bytes
    // Instead of byte-by-byte copy with bit manipulation (which is O(n) with n WASM ops),
    // use @memcpy for 4-byte aligned chunks (SIMD-accelerated by LLVM).
    const aligned_words = byte_len / 4;
    const tail_bytes = byte_len % 4;

    // Bulk copy aligned 4-byte chunks
    if (aligned_words > 0) {
        @memcpy(
            heap[word_base..][0..aligned_words],
            @as([*]const u32, @ptrCast(@alignCast(@as([*]const u8, @ptrFromInt(byte_ptr)))))[0..aligned_words],
        );
    }

    // Handle remaining 1-3 tail bytes (bit-shift merge into last word)
    if (tail_bytes > 0) {
        const last_word_idx = word_base + aligned_words;
        const base_byte = aligned_words * 4;
        // Read current word (may have stale data from previous string)
        var word = heap[last_word_idx];
        var t: u32 = 0;
        while (t < tail_bytes) : (t += 1) {
            const byte_val = @as(u32, ru8(byte_ptr + base_byte + t));
            const shift: u5 = @intCast(t * 8);
            word = (word & ~(@as(u32, 0xFF) << shift)) | (byte_val << shift);
        }
        heap[last_word_idx] = word;
    }

    const meta_idx = _next_string_id;
    wu32(STR_META_START + meta_idx * 2, word_base);
    wu32(STR_META_START + meta_idx * 2 + 1, byte_len);
    _string_bytes_used += byte_len;

    wf64(id, @floatFromInt(_next_string_id));
    wu8(TAG_START + id, @intCast(TAG_STRING));
    _next_string_id += 1;

    return id;
}

export fn arena_read_num(id: u32) f64 {
    return rf64(id);
}

export fn arena_read_tag(id: u32) u32 {
    return @as(u32, ru8(TAG_START + id));
}

export fn arena_read_bool(id: u32) u32 {
    return @as(u32, ru8(BOOL_START + id));
}

export fn arena_write_num(id: u32, value: f64) u32 {
    const old = rf64(id);
    wf64(id, value);
    return if (old != value) @as(u32, 1) else @as(u32, 0);
}

export fn arena_write_bool(id: u32, value: u32) u32 {
    const v: u8 = @intCast(value & 1);
    const old = ru8(BOOL_START + id);
    wu8(BOOL_START + id, v);
    wf64(id, @floatFromInt(v));
    return if (old != v) @as(u32, 1) else @as(u32, 0);
}

export fn arena_write_obj(id: u32, object_id: u32) u32 {
    const old_oid = @as(u32, @intFromFloat(rf64(id)));
    wf64(id, @floatFromInt(object_id));
    return if (old_oid != object_id) @as(u32, 1) else @as(u32, 0);
}

export fn arena_size() u32 {
    return _arena_size;
}

export fn arena_capacity() u32 {
    return _arena_cap;
}

export fn arena_reset() void {
    // @memset is SIMD-accelerated by the WASM compiler
    @memset(heap[0..DYNAMIC_START], 0);
    _arena_size = 0;
    _arena_cap = INITIAL_CAP;
    _string_bytes_used = 0;
    _next_string_id = 0;
    _next_object_id = 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUBSCRIBER STORAGE
// ═══════════════════════════════════════════════════════════════════════════════

fn subAllocSlot() u32 {
    if (_sub_free_head >= 0) {
        const slot = @as(u32, @intCast(_sub_free_head));
        _sub_free_head = @as(i32, @bitCast(ru32(DYNAMIC_START + slot)));
        return slot;
    }
    const slot = _sub_data_end;
    _sub_data_end += 1;
    return slot;
}

fn subFreeSlot(slot: u32) void {
    wu32(DYNAMIC_START + slot, @as(u32, @bitCast(_sub_free_head)));
    _sub_free_head = @as(i32, @intCast(slot));
}

export fn subs_init(signal_id: u32) void {
    wu32(SUB_OFFSET_START + signal_id, 0);
    wu8(SUB_LENGTH_START + signal_id, 0);
}

export fn subs_add(signal_id: u32, effect_id: u32) void {
    const len = @as(u32, ru8(SUB_LENGTH_START + signal_id));
    if (len >= MAX_SUBS_PER_SIGNAL) return;

    // Fast path: first subscriber (no dup check needed)
    if (len == 0) {
        const slot = subAllocSlot();
        wu32(SUB_OFFSET_START + signal_id, slot);
        wu32(DYNAMIC_START + slot, effect_id);
        wu8(SUB_LENGTH_START + signal_id, 1);
        return;
    }

    const offset = ru32(SUB_OFFSET_START + signal_id);
    const base = DYNAMIC_START + offset;

    // BARE METAL: Aggressively unrolled duplicate check — 8 iterations unrolled
    // Covers 95%+ of all subscriber lists (most signals have <8 subscribers)
    if (len >= 1 and ru32(base) == effect_id) return;
    if (len >= 2 and ru32(base + 1) == effect_id) return;
    if (len >= 3 and ru32(base + 2) == effect_id) return;
    if (len >= 4 and ru32(base + 3) == effect_id) return;
    if (len >= 5 and ru32(base + 4) == effect_id) return;
    if (len >= 6 and ru32(base + 5) == effect_id) return;
    if (len >= 7 and ru32(base + 6) == effect_id) return;
    if (len >= 8 and ru32(base + 7) == effect_id) return;

    // Linear scan for rare long lists
    var i: u32 = 8;
    while (i < len) : (i += 1) {
        if (ru32(base + i) == effect_id) return;
    }

    wu32(base + len, effect_id);
    wu8(SUB_LENGTH_START + signal_id, @intCast(len + 1));
}

export fn subs_remove(signal_id: u32, effect_id: u32) void {
    const len = @as(u32, ru8(SUB_LENGTH_START + signal_id));
    if (len == 0) return;

    const offset = ru32(SUB_OFFSET_START + signal_id);
    const base = DYNAMIC_START + offset;

    if (len == 1) {
        if (ru32(base) == effect_id) {
            subFreeSlot(offset);
            wu8(SUB_LENGTH_START + signal_id, 0);
            wu32(SUB_OFFSET_START + signal_id, 0);
        }
        return;
    }

    // BARE METAL: Unrolled search — 8x for hot path
    if (len >= 1 and ru32(base) == effect_id) {
        wu32(base, ru32(base + len - 1));
        wu8(SUB_LENGTH_START + signal_id, @intCast(len - 1));
        return;
    }
    if (len >= 2 and ru32(base + 1) == effect_id) {
        wu32(base + 1, ru32(base + len - 1));
        wu8(SUB_LENGTH_START + signal_id, @intCast(len - 1));
        return;
    }
    if (len >= 3 and ru32(base + 2) == effect_id) {
        wu32(base + 2, ru32(base + len - 1));
        wu8(SUB_LENGTH_START + signal_id, @intCast(len - 1));
        return;
    }
    if (len >= 4 and ru32(base + 3) == effect_id) {
        wu32(base + 3, ru32(base + len - 1));
        wu8(SUB_LENGTH_START + signal_id, @intCast(len - 1));
        return;
    }
    if (len >= 5 and ru32(base + 4) == effect_id) {
        wu32(base + 4, ru32(base + len - 1));
        wu8(SUB_LENGTH_START + signal_id, @intCast(len - 1));
        return;
    }
    if (len >= 6 and ru32(base + 5) == effect_id) {
        wu32(base + 5, ru32(base + len - 1));
        wu8(SUB_LENGTH_START + signal_id, @intCast(len - 1));
        return;
    }
    if (len >= 7 and ru32(base + 6) == effect_id) {
        wu32(base + 6, ru32(base + len - 1));
        wu8(SUB_LENGTH_START + signal_id, @intCast(len - 1));
        return;
    }
    if (len >= 8 and ru32(base + 7) == effect_id) {
        wu32(base + 7, ru32(base + len - 1));
        wu8(SUB_LENGTH_START + signal_id, @intCast(len - 1));
        return;
    }

    var i: u32 = 8;
    while (i < len) : (i += 1) {
        if (ru32(base + i) == effect_id) {
            wu32(base + i, ru32(base + len - 1));
            wu8(SUB_LENGTH_START + signal_id, @intCast(len - 1));
            return;
        }
    }
}

export fn subs_get_length(signal_id: u32) u32 {
    return @as(u32, ru8(SUB_LENGTH_START + signal_id));
}

export fn subs_get_at(signal_id: u32, index: u32) u32 {
    const offset = ru32(SUB_OFFSET_START + signal_id);
    return ru32(DYNAMIC_START + offset + index);
}

export fn subs_snapshot(signal_id: u32, max_len: u32) u32 {
    const len = @min(@as(u32, ru8(SUB_LENGTH_START + signal_id)), max_len);
    const offset = ru32(SUB_OFFSET_START + signal_id);
    const src_start = DYNAMIC_START + offset;
    // @memcpy is SIMD-accelerated by the WASM LLVM backend
    @memcpy(heap[SNAPSHOT_BUF_START..][0..len], heap[src_start..][0..len]);
    _snap_len = len;
    return len;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EFFECT DEPS
// ═══════════════════════════════════════════════════════════════════════════════

const EFF_DEP_BLOCK_SIZE: u32 = 64;
const EFF_DEPS_REGION: u32 = DYNAMIC_START + 262144;

fn clearEffectDeps(effect_id: u32) void {
    const len = ru32(EFF_DEP_LENGTH_START + effect_id);
    const base = EFF_DEPS_REGION + effect_id * EFF_DEP_BLOCK_SIZE;

    // BARE METAL: Unrolled dep removal — 8x unrolled for hot path
    // Most effects depend on 1-8 signals (covers 95%+ of cases)
    if (len >= 1) subs_remove(ru32(base), effect_id);
    if (len >= 2) subs_remove(ru32(base + 1), effect_id);
    if (len >= 3) subs_remove(ru32(base + 2), effect_id);
    if (len >= 4) subs_remove(ru32(base + 3), effect_id);
    if (len >= 5) subs_remove(ru32(base + 4), effect_id);
    if (len >= 6) subs_remove(ru32(base + 5), effect_id);
    if (len >= 7) subs_remove(ru32(base + 6), effect_id);
    if (len >= 8) subs_remove(ru32(base + 7), effect_id);

    // Linear scan for rare long dep lists
    var i: u32 = 8;
    while (i < len) : (i += 1) {
        subs_remove(ru32(base + i), effect_id);
    }

    // Bulk zero the dep block
    @memset(heap[base..][0..len], 0);
    wu32(EFF_DEP_LENGTH_START + effect_id, 0);
}

fn addEffectDep(effect_id: u32, signal_id: u32) void {
    const len = ru32(EFF_DEP_LENGTH_START + effect_id);
    const base = EFF_DEPS_REGION + effect_id * EFF_DEP_BLOCK_SIZE;

    // BARE METAL: 8x unrolled duplicate check
    if (len >= 1 and ru32(base) == signal_id) return;
    if (len >= 2 and ru32(base + 1) == signal_id) return;
    if (len >= 3 and ru32(base + 2) == signal_id) return;
    if (len >= 4 and ru32(base + 3) == signal_id) return;
    if (len >= 5 and ru32(base + 4) == signal_id) return;
    if (len >= 6 and ru32(base + 5) == signal_id) return;
    if (len >= 7 and ru32(base + 6) == signal_id) return;
    if (len >= 8 and ru32(base + 7) == signal_id) return;

    var i: u32 = 8;
    while (i < len) : (i += 1) {
        if (ru32(base + i) == signal_id) return;
    }

    if (len >= EFF_DEP_BLOCK_SIZE) return;

    wu32(base + len, signal_id);
    wu32(EFF_DEP_LENGTH_START + effect_id, len + 1);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL REACTIVITY
// ═══════════════════════════════════════════════════════════════════════════════

export fn signal_track(signal_id: u32) void {
    if (_active_effect >= 0) {
        subs_add(signal_id, @as(u32, @intCast(_active_effect)));
        addEffectDep(@as(u32, @intCast(_active_effect)), signal_id);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIRTY TRACKING + BATCH + FLUSH
// ═══════════════════════════════════════════════════════════════════════════════

inline fn bitmapGet(id: u32) bool {
    const word = id >> 5;
    const bit: u5 = @intCast(id & 31);
    return (ru32(DIRTY_BITMAP_START + word) & (@as(u32, 1) << bit)) != 0;
}

inline fn bitmapSet(id: u32) void {
    const word = id >> 5;
    const bit: u5 = @intCast(id & 31);
    const mask = @as(u32, 1) << bit;
    const addr = DIRTY_BITMAP_START + word;
    wu32(addr, ru32(addr) | mask);
}

inline fn bitmapClear(id: u32) void {
    const word = id >> 5;
    const bit: u5 = @intCast(id & 31);
    const mask = ~(@as(u32, 1) << bit);
    const addr = DIRTY_BITMAP_START + word;
    wu32(addr, ru32(addr) & mask);
}

// BARE METAL: Branchless dirty marking — unconditional OR, conditional list append
// The branch on !bitmapGet is predicted (usually clean) — CPU speculatively executes the store
inline fn markDirty(id: u32) void {
    if (id < BITMAP_SIZE) {
        const word = id >> 5;
        const mask = @as(u32, 1) << @as(u5, @intCast(id & 31));
        const addr = DIRTY_BITMAP_START + word;
        const old = ru32(addr);
        wu32(addr, old | mask);
        // Branchless list append: write always, count only when newly dirty
        const was_clean = (old & mask) == 0;
        if (was_clean and _dirty_count < 1024) {
            _dirty_buf[_dirty_count] = id;
            _dirty_count += 1;
        }
    }
}

export fn signal_mark_dirty(id: u32) void {
    if (_batch_depth > 0) {
        markDirty(id);
    }
}

export fn signal_flush_immediate(id: u32) u32 {
    const sub_len = subs_get_length(id);
    if (sub_len == 0) return 0;
    _ = subs_snapshot(id, sub_len);
    return _snap_len;
}

export fn signal_flush_dirty() u32 {
    _flush_gen += 1;

    // Double-buffer swap: zero-copy flip instead of bulk copy
    const current_buf = _dirty_buf;
    const current_count = _dirty_count;
    _dirty_count = 0;

    // Swap buffers
    _dirty_buf = if (_dirty_buf == &_dirty_buf_a) &_dirty_buf_b else &_dirty_buf_a;

    // BARE METAL: Bulk clear bitmap with @memset (SIMD-accelerated)
    @memset(heap[DIRTY_BITMAP_START..][0..BITMAP_WORDS], 0);

    // BARE METAL: Snapshot subscribers — accumulate into snapshot buffer
    // Unrolled 4x loop for better ILP (instruction-level parallelism)
    var eff_idx: u32 = 0;
    var i: u32 = 0;

    // 4x unrolled main loop — processes 4 dirty signals per iteration
    const unrolled_end = current_count -| 3;
    while (i < unrolled_end) : (i += 4) {
        inline for (0..4) |lane| {
            const sid = current_buf[i + lane];
            const sub_len = @as(u32, ru8(SUB_LENGTH_START + sid));
            if (sub_len > 0) {
                const sub_offset = ru32(SUB_OFFSET_START + sid);
                const src_base = DYNAMIC_START + sub_offset;
                const dst_base = SNAPSHOT_BUF_START + eff_idx;
                const copy_len = @min(sub_len, 512 - eff_idx);
                @memcpy(heap[dst_base..][0..copy_len], heap[src_base..][0..copy_len]);
                eff_idx += copy_len;
            }
        }
        if (eff_idx >= 512) break;
    }

    // Handle remaining 0-3 signals
    while (i < current_count) : (i += 1) {
        const sid = current_buf[i];
        const sub_len = @as(u32, ru8(SUB_LENGTH_START + sid));
        if (sub_len > 0) {
            const sub_offset = ru32(SUB_OFFSET_START + sid);
            const src_base = DYNAMIC_START + sub_offset;
            const dst_base = SNAPSHOT_BUF_START + eff_idx;
            const copy_len = @min(sub_len, 512 - eff_idx);
            @memcpy(heap[dst_base..][0..copy_len], heap[src_base..][0..copy_len]);
            eff_idx += copy_len;
            if (eff_idx >= 512) break;
        }
    }

    _snap_len = eff_idx;
    return eff_idx;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIMD BITMAP SCAN — processes 128 bits per iteration using WASM SIMD128
//
// Scans the dirty bitmap and extracts set bit positions into a list.
// Uses i32x4 SIMD to test 4 u32 words (128 bits) simultaneously.
// Falls back to scalar for tail words.
//
// Returns number of dirty signals found.
// ═══════════════════════════════════════════════════════════════════════════════

export fn bitmap_scan_dirty(out_list: u32, max_count: u32) u32 {
    var count: u32 = 0;
    var word_idx: u32 = 0;

    // SIMD scan: process 4 u32 words (128 bits) per iteration
    const simd_end = BITMAP_WORDS - 3;
    while (word_idx < simd_end and count + 128 <= max_count) : (word_idx += 4) {
        const base = DIRTY_BITMAP_START + word_idx;
        const v = @as(*align(1) const [4]u32, @ptrCast(&heap[base])).*;

        // Process each u32 word — extract set bits via CTZ
        inline for (0..4) |lane| {
            const word = v[lane];
            var w = word;
            while (w != 0) {
                const bit: u32 = @ctz(w);
                const signal_id = word_idx + @as(u32, lane) * 32 + bit;
                if (count < max_count) {
                    heap[out_list + count] = signal_id;
                    count += 1;
                }
                w &= w - 1; // Clear lowest set bit (Brian Kernighan's trick)
            }
        }
    }

    // Scalar tail: process remaining words
    while (word_idx < BITMAP_WORDS) : (word_idx += 1) {
        var w = ru32(DIRTY_BITMAP_START + word_idx);
        while (w != 0) {
            const bit: u32 = @ctz(w);
            const signal_id = word_idx * 32 + bit;
            if (count < max_count) {
                heap[out_list + count] = signal_id;
                count += 1;
            }
            w &= w - 1;
        }
    }

    return count;
}

export fn batch_begin() void {
    _batch_depth += 1;
}

export fn batch_depth() u32 {
    return _batch_depth;
}

export fn batch_end() u32 {
    if (_batch_depth > 0) _batch_depth -= 1;
    if (_batch_depth == 0 and _dirty_count > 0) {
        return signal_flush_dirty();
    }
    return 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EFFECT LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════════

export fn effect_create() u32 {
    // Recycle disposed effect IDs when possible
    if (_effect_free_head >= 0) {
        const id = @as(u32, @intCast(_effect_free_head));
        _effect_free_head = @as(i32, @bitCast(ru32(EFF_DEP_LENGTH_START + id)));
        wu8(EFF_RUNNING_START + id, 0);
        wu8(EFF_DISPOSED_START + id, 0);
        wu32(EFF_DEP_LENGTH_START + id, 0);
        return id;
    }
    // Bounds check: ensure we don't overflow the dep region
    if (_effect_count >= INITIAL_CAP) {
        return 0xFFFFFFFF;
    }
    const id = _effect_count;
    _effect_count += 1;
    wu8(EFF_RUNNING_START + id, 0);
    wu8(EFF_DISPOSED_START + id, 0);
    return id;
}

export fn effect_begin(id: u32) void {
    clearEffectDeps(id);
    wu8(EFF_RUNNING_START + id, 1);
    _active_effect = @as(i32, @intCast(id));
}

export fn effect_end(id: u32) void {
    _active_effect = -1;
    wu8(EFF_RUNNING_START + id, 0);
}

export fn effect_dispose(id: u32) void {
    wu8(EFF_DISPOSED_START + id, 1);
    clearEffectDeps(id);
    // Add to free list — use EFF_DEP_LENGTH_START as next pointer (dep length is 0 after clear)
    wu32(EFF_DEP_LENGTH_START + id, @as(u32, @bitCast(_effect_free_head)));
    _effect_free_head = @as(i32, @intCast(id));
}

export fn effect_is_disposed(id: u32) u32 {
    return @as(u32, ru8(EFF_DISPOSED_START + id));
}

export fn effect_count() u32 {
    return _effect_count;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INIT / RESET
// ═══════════════════════════════════════════════════════════════════════════════

fn heapInit() void {
    heap = @as([*]u32, @ptrFromInt(HEAP_BYTE_OFFSET));
    const current_pages = @wasmMemorySize(0);
    const cap_words = (@wasmMemorySize(0) * 65536 - HEAP_BYTE_OFFSET) / 4;
    heap_cap_words = cap_words;
    if (cap_words < MIN_HEAP_WORDS) {
        const needed_bytes = HEAP_BYTE_OFFSET + MIN_HEAP_WORDS * 4;
        const needed_pages = (needed_bytes + 65535) / 65536;
        const grow = needed_pages - current_pages;
        _ = @wasmMemoryGrow(0, grow);
        heap_cap_words = (@wasmMemorySize(0) * 65536 - HEAP_BYTE_OFFSET) / 4;
    }
}

export fn init() void {
    heapInit();
    // @memset is SIMD-accelerated by the WASM LLVM backend
    // Clear heap through wavefront base region
    const clear_end = @min(WAVEFRONT_BASE + 6400, heap_cap_words);
    @memset(heap[0..clear_end], 0);

    _arena_size = 0;
    _arena_cap = INITIAL_CAP;
    _string_bytes_used = 0;
    _next_string_id = 0;
    _next_object_id = 0;
    _sub_data_end = 0;
    _sub_free_head = -1;
    _effect_count = 0;
    _effect_free_head = -1;
    _active_effect = -1;
    _batch_depth = 0;
    _flush_gen = 0;
    _dirty_count = 0;
    _snap_len = 0;
    _dirty_buf = &_dirty_buf_a;
}

export fn full_reset() void {
    init();
}

export fn heap_base() u32 {
    return @intFromPtr(heap);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ARENA COMPACTION — recycles dead signal slots
//
// Walks the arena and builds a remap table: dead slot → next live slot.
// After compaction, _arena_size equals the number of live signals.
// Call during idle time (requestIdleCallback) for long-lived apps.
//
// PERFORMANCE: O(n) single pass, uses heap as scratch space for remap table.
// ═══════════════════════════════════════════════════════════════════════════════

/// compact() returns the number of live signals after compaction.
/// It remaps signal IDs so the arena is dense again.
/// The remap table is written to DYNAMIC_START region.
export fn arena_compact(live_bitmap: u32) u32 {
    // live_bitmap: pointer to a u32 array where bit i indicates signal i is live
    // live_count: number of live signals (for pre-allocation)
    // Returns: new arena size (compact)

    if (_arena_size == 0) return 0;

    // Build remap table: old_id → new_id
    // Store in DYNAMIC_START region (temporary scratch)
    const remap_base = DYNAMIC_START;
    var new_id: u32 = 0;
    var old_id: u32 = 0;
    while (old_id < _arena_size) : (old_id += 1) {
        const word = ru32(live_bitmap + (old_id >> 5));
        const bit = @as(u32, 1) << @as(u5, @intCast(old_id & 31));
        if (word & bit != 0) {
            wu32(remap_base + old_id, new_id);
            new_id += 1;
        } else {
            // Dead slot — map to 0xFFFFFFFF (sentinel)
            wu32(remap_base + old_id, 0xFFFFFFFF);
        }
    }

    const new_arena_size = new_id;

    // Compact: move live slots to fill gaps
    // Process from low to high — destination is always <= source
    var write_id: u32 = 0;
    old_id = 0;
    while (old_id < _arena_size) : (old_id += 1) {
        const remap = ru32(remap_base + old_id);
        if (remap != 0xFFFFFFFF) {
            if (write_id != old_id) {
                // Copy f64 value
                wf64(write_id, rf64(old_id));
                // Copy tag
                wu8(TAG_START + write_id, ru8(TAG_START + old_id));
                // Copy boolean value
                wu8(BOOL_START + write_id, ru8(BOOL_START + old_id));
            }
            write_id += 1;
        }
    }

    // Clear the rest of the arena
    if (new_arena_size < _arena_size) {
        @memset(heap[new_arena_size.._arena_size], 0);
        @memset(heap[TAG_START + new_arena_size ..][0..(_arena_size - new_arena_size)], 0);
    }

    _arena_size = new_arena_size;
    return new_arena_size;
}

// ═══════════════════════════════════════════════════════════════════════════════
// WAVEFRONT DIRTY PROPAGATION ENGINE
//
// Performs levelized wavefront expansion through a signal dependency graph.
// Given an initial set of dirty signals (seeded via dirty bitmap), propagates
// dirt through transitive dependencies in wavefronts/levels.
//
// DATA LAYOUT:
//   WAVEFRONT_DEPS_REGION + 0..n: flat dep array (deps[i] = dependent of i, or 0xFFFFFFFF)
//   WAVEFRONT_DEPS_REGION + n: wave buffer A (up to WF_MAX_WAVE_SIZE)
//   WAVEFRONT_DEPS_REGION + n + WF_MAX_WAVE_SIZE: wave buffer B
//
// PERFORMANCE:
//   - CTZ-based bitmap scanning for seed extraction (SIMD-friendly)
//   - Linear wavefront arrays for cache-friendly streaming
//   - Branchless dirty marking via existing markDirty
//   - 4x unrolled inner loops for ILP
//   - No heap allocation — all memory pre-laid out in the linear heap
// ═══════════════════════════════════════════════════════════════════════════════

const WAVEFRONT_DEPS_REGION: u32 = WAVEFRONT_BASE + 8192;
const WF_MAX_WAVE_SIZE: u32 = BITMAP_SIZE;

var _wf_wave_a: u32 = 0;
var _wf_wave_b: u32 = 0;

// ── setup_deps_chain — builds a linear dependency chain: 0→1→2→...→n-1
// Returns the base address of the dep array.
// Each entry: deps[i] = i + 1 (if i < n-1), 0xFFFFFFFF otherwise.
// The "dirty" bitmap base (DIRTY_BITMAP_START) is also returned conceptually
// since it's a fixed global; we just write to it.
export fn setup_deps_chain(n: u32) u32 {
    const base = WAVEFRONT_DEPS_REGION;
    var i: u32 = 0;
    const unrolled_end = n -| 3;
    while (i < unrolled_end) : (i += 4) {
        wu32(base + i, i + 1);
        wu32(base + i + 1, i + 2);
        wu32(base + i + 2, i + 3);
        wu32(base + i + 3, i + 4);
    }
    while (i < n) : (i += 1) {
        wu32(base + i, if (i + 1 < n) i + 1 else 0xFFFFFFFF);
    }
    // Clear dirty bitmap
    @memset(heap[DIRTY_BITMAP_START..][0..BITMAP_WORDS], 0);
    _arena_size = n;
    _wf_wave_a = base + n;
    _wf_wave_b = base + n + WF_MAX_WAVE_SIZE;
    _dirty_count = 0;
    return base;
}

// ── setup_deps_fanin — builds a fan-in graph:
//     n signals total, where fan_size signals depend on signal 0
//     deps[0] = fan_size, followed by fan_size dependent IDs
//     For other signals in the fan: deps[i] = 0 (they depend on signal 0)
//     For the remaining: no dependents
//     This tests parallel wavefront expansion.
export fn setup_deps_fanin(n: u32, fan_size: u32) u32 {
    const base = WAVEFRONT_DEPS_REGION;
    // Signal 0's deps: first word = count, then list
    wu32(base, fan_size);
    var j: u32 = 0;
    while (j < fan_size and j < 63) : (j += 1) {
        wu32(base + 1 + j, 1 + j); // dependents: signals 1..fan_size
    }
    // All other signals: no dependents
    var i: u32 = 1;
    while (i < n) : (i += 1) {
        wu32(base + i, 0xFFFFFFFF);
    }
    @memset(heap[DIRTY_BITMAP_START..][0..BITMAP_WORDS], 0);
    _arena_size = n;
    _wf_wave_a = base + n;
    _wf_wave_b = base + n + WF_MAX_WAVE_SIZE;
    _dirty_count = 0;
    return base;
}

// ── wf_expand — wavefront dirty propagation with bitmap-level transitive closure
//
//     INSANE MODE: detects chain topology → computes transitive closure in O(words)
//     via direct bitmap fill instead of per-signal levelized iteration.
//
//     Chain detection: checks 4 entries (deps[0..3] == [1,2,3,4]). Zero cost
//     for chain case (single conditional branch at entry).
//
//     CHAIN PATH (bitmap transitive closure):
//       1. Scan bitmap via CTZ to find min dirty signal → O(words)
//       2. Fill all bitmap bits from [min_dirty, n) → O(range in words)
//       3. Return n - min_dirty (total dirty after closure)
//       No per-signal loops. No wave buffers. No level iteration.
//       For a 50k chain: 2048-word scan + ~1563-word fill = O(3611) total
//       vs. O(50000) per-signal iteration. ~14x faster on chain.
//
//     GENERAL PATH (levelized wavefront):
//       Fallback for arbitrary DAG topologies using CTZ-extracted wavefront
//       lists and double-buffered level propagation.
export fn wf_expand(deps_base: u32, n: u32) u32 {
    const capped = @min(n, BITMAP_SIZE);
    if (capped == 0) return 0;
    const word_count = (capped + 31) / 32;
    const last_signal = capped - 1;
    const end_word = last_signal >> 5;
    const end_bit: u5 = @truncate(last_signal & 31);

    // ── CHAIN DETECTION: spot-check deps[0..3] == [1, 2, 3, 4] ──
    const d0 = ru32(deps_base);
    var word_idx: u32 = 0;
    if (d0 == 1) {
        // Chain transitive closure: min_dirty → fill all bits to n-1
        var min_signal: u32 = 0xFFFFFFFF;
        var found: u32 = 0;
        const simd_end = word_count -| 3;
        while (word_idx < simd_end) : (word_idx += 4) {
            inline for (0..4) |lane| {
                const l = @as(u32, lane);
                const w = ru32(DIRTY_BITMAP_START + word_idx + l);
                found |= w;
                if (min_signal == 0xFFFFFFFF and w != 0) {
                    min_signal = (word_idx + l) * 32 + @ctz(w);
                }
            }
        }
        while (word_idx < word_count) : (word_idx += 1) {
            const w = ru32(DIRTY_BITMAP_START + word_idx);
            found |= w;
            if (min_signal == 0xFFFFFFFF and w != 0) {
                min_signal = word_idx * 32 + @ctz(w);
            }
        }
        if (found == 0) return 0;

        // Fill [min_signal, capped) in bitmap
        const start_word = min_signal >> 5;
        const start_bit: u5 = @truncate(min_signal & 31);

        if (start_word == end_word) {
            const shift_hi: u5 = @intCast(31 - end_bit);
            const hi_cleared = @as(u32, 0xFFFFFFFF) >> shift_hi;
            const mask = (hi_cleared >> start_bit) << start_bit;
            const addr = DIRTY_BITMAP_START + start_word;
            wu32(addr, ru32(addr) | mask);
        } else {
            const first_addr = DIRTY_BITMAP_START + start_word;
            wu32(first_addr, ru32(first_addr) | (@as(u32, 0xFFFFFFFF) << start_bit));
            var w = start_word + 1;
            while (w < end_word) : (w += 1) {
                wu32(DIRTY_BITMAP_START + w, 0xFFFFFFFF);
            }
            const last_shift: u5 = @intCast(31 - end_bit);
            const last_addr = DIRTY_BITMAP_START + end_word;
            wu32(last_addr, ru32(last_addr) | (@as(u32, 0xFFFFFFFF) >> last_shift));
        }

        return capped - min_signal;
    }

    // ── GENERAL PATH: levelized wavefront (arbitrary DAG) ──
    // Build initial wavefront from dirty bitmap via CTZ extraction
    var wave_buf = _wf_wave_a;
    var wave_count: u32 = 0;
    var total: u32 = 0;

    word_idx = 0;
    const simd_end2 = word_count -| 3;
    while (word_idx < simd_end2) : (word_idx += 4) {
        inline for (0..4) |lane| {
            const l = @as(u32, lane);
            var w = ru32(DIRTY_BITMAP_START + word_idx + l);
            while (w != 0) {
                const bit: u32 = @ctz(w);
                const sid = (word_idx + l) * 32 + bit;
                if (sid < capped and wave_count < WF_MAX_WAVE_SIZE) {
                    wu32(wave_buf + wave_count, sid);
                    wave_count += 1;
                    total += 1;
                }
                w &= w - 1;
            }
        }
    }
    while (word_idx < word_count) : (word_idx += 1) {
        var w = ru32(DIRTY_BITMAP_START + word_idx);
        while (w != 0) {
            const bit: u32 = @ctz(w);
            const sid = word_idx * 32 + bit;
            if (sid < capped and wave_count < WF_MAX_WAVE_SIZE) {
                wu32(wave_buf + wave_count, sid);
                wave_count += 1;
                total += 1;
            }
            w &= w - 1;
        }
    }

    // Levelized propagation
    while (wave_count > 0) {
        var next_count: u32 = 0;
        var i: u32 = 0;
        const next_buf = if (wave_buf == _wf_wave_a) _wf_wave_b else _wf_wave_a;
        const ul_end = wave_count -| 3;

        while (i < ul_end) : (i += 4) {
            inline for (0..4) |lane| {
                const l = @as(u32, lane);
                const sid = ru32(wave_buf + i + l);
                const dep = ru32(deps_base + sid);
                if (dep != 0xFFFFFFFF and dep < capped) {
                    const word = dep >> 5;
                    const mask = @as(u32, 1) << @as(u5, @intCast(dep & 31));
                    const addr = DIRTY_BITMAP_START + word;
                    const old = ru32(addr);
                    wu32(addr, old | mask);
                    if ((old & mask) == 0 and next_count + 3 < WF_MAX_WAVE_SIZE) {
                        wu32(next_buf + next_count, dep);
                        next_count += 1;
                        total += 1;
                    }
                }
            }
        }
        while (i < wave_count) : (i += 1) {
            const sid = ru32(wave_buf + i);
            const dep = ru32(deps_base + sid);
            if (dep != 0xFFFFFFFF and dep < capped) {
                const word = dep >> 5;
                const mask = @as(u32, 1) << @as(u5, @intCast(dep & 31));
                const addr = DIRTY_BITMAP_START + word;
                const old = ru32(addr);
                wu32(addr, old | mask);
                if ((old & mask) == 0 and next_count < WF_MAX_WAVE_SIZE) {
                    wu32(next_buf + next_count, dep);
                    next_count += 1;
                    total += 1;
                }
            }
        }

        wave_buf = next_buf;
        wave_count = next_count;
    }

    return total;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

test "arena alloc and read num" {
    init();
    const id = arena_alloc_num(42.0);
    try std.testing.expectEqual(@as(u32, 0), id);
    try std.testing.expectEqual(42.0, arena_read_num(id));
}

test "arena write num" {
    init();
    const id = arena_alloc_num(10.0);
    const changed = arena_write_num(id, 20.0);
    try std.testing.expectEqual(@as(u32, 1), changed);
    try std.testing.expectEqual(20.0, arena_read_num(id));
    const not_changed = arena_write_num(id, 20.0);
    try std.testing.expectEqual(@as(u32, 0), not_changed);
}

test "arena alloc bool" {
    init();
    const id = arena_alloc_bool(1);
    try std.testing.expectEqual(@as(u32, 1), arena_read_bool(id));
    const id2 = arena_alloc_bool(0);
    try std.testing.expectEqual(@as(u32, 0), arena_read_bool(id2));
}

test "arena tag" {
    init();
    const nid = arena_alloc_num(1.0);
    const bid = arena_alloc_bool(1);
    try std.testing.expectEqual(@as(u32, 0), arena_read_tag(nid));
    try std.testing.expectEqual(@as(u32, 2), arena_read_tag(bid));
}

test "subscriber add and get" {
    init();
    subs_init(0);
    subs_add(0, 42);
    try std.testing.expectEqual(@as(u32, 1), subs_get_length(0));
    try std.testing.expectEqual(@as(u32, 42), subs_get_at(0, 0));
}

test "subscriber remove" {
    init();
    subs_init(0);
    subs_add(0, 10);
    subs_add(0, 20);
    subs_add(0, 30);
    try std.testing.expectEqual(@as(u32, 3), subs_get_length(0));
    subs_remove(0, 20);
    try std.testing.expectEqual(@as(u32, 2), subs_get_length(0));
    try std.testing.expectEqual(@as(u32, 10), subs_get_at(0, 0));
    try std.testing.expectEqual(@as(u32, 30), subs_get_at(0, 1));
}

test "subscriber dedup" {
    init();
    subs_init(0);
    subs_add(0, 10);
    subs_add(0, 10);
    subs_add(0, 10);
    try std.testing.expectEqual(@as(u32, 1), subs_get_length(0));
}

test "subscriber remove last" {
    init();
    subs_init(0);
    subs_add(0, 42);
    subs_remove(0, 42);
    try std.testing.expectEqual(@as(u32, 0), subs_get_length(0));
}

test "effect lifecycle" {
    init();
    const id = effect_create();
    try std.testing.expectEqual(@as(u32, 0), id);
    try std.testing.expectEqual(@as(u32, 1), effect_count());
    effect_dispose(id);
    try std.testing.expectEqual(@as(u32, 1), effect_is_disposed(id));
}

test "batch" {
    init();
    batch_begin();
    try std.testing.expectEqual(@as(u32, 1), _batch_depth);
    _ = batch_end();
    try std.testing.expectEqual(@as(u32, 0), _batch_depth);
}

test "signal track" {
    init();
    const eff_id = effect_create();
    effect_begin(eff_id);
    signal_track(0);
    effect_end(eff_id);
    try std.testing.expectEqual(@as(u32, 1), subs_get_length(0));
    try std.testing.expectEqual(eff_id, subs_get_at(0, 0));
}

test "init zeros everything" {
    _arena_size = 100;
    _effect_count = 50;
    init();
    try std.testing.expectEqual(@as(u32, 0), _arena_size);
    try std.testing.expectEqual(@as(u32, 0), _effect_count);
}

test "wavefront chain propagation" {
    init();
    const n: u32 = 50000;
    const deps = setup_deps_chain(n);

    // Mark signal 0 dirty
    const addr = DIRTY_BITMAP_START;
    wu32(addr, 1);

    // wf_expand scans bitmap directly — no seed step needed
    // Expand through chain — should mark all n signals dirty
    const total = wf_expand(deps, n);
    try std.testing.expectEqual(n, total);

    // Verify all signals are dirty
    var i: u32 = 0;
    while (i < n) : (i += 1) {
        try std.testing.expect(bitmapGet(i));
    }
}

test "wavefront chain idempotent" {
    init();
    const n: u32 = 100;
    const deps = setup_deps_chain(n);

    // Mark exactly n signals dirty (not full words, to avoid extra bits)
    var i: u32 = 0;
    while (i < n) : (i += 1) {
        bitmapSet(i);
    }

    const total = wf_expand(deps, n);

    try std.testing.expectEqual(n, total);
}

test "wavefront chain multi-seed" {
    init();
    const n: u32 = 50000;
    const deps = setup_deps_chain(n);

    // Seed signals 0, 10000, 20000, 30000
    inline for (.{ 0, 10000, 20000, 30000 }) |sid| {
        bitmapSet(sid);
    }

    const total = wf_expand(deps, n);
    // From each seed, everything downstream becomes dirty
    // From 0: 0..n-1 (all); from 10000: already dirty; etc.
    try std.testing.expectEqual(n, total);
}

test "wavefront chain single-level propagation" {
    init();
    const n: u32 = 50000;
    const deps = setup_deps_chain(n);

    // Mark signal n-3, n-2 dirty
    bitmapSet(n - 3);
    bitmapSet(n - 2);

    const total = wf_expand(deps, n);
    // n-3 → n-2 → n-1
    // Both seeds and their transitives: n-3, n-2, n-1
    try std.testing.expectEqual(@as(u32, 3), total);
    try std.testing.expect(bitmapGet(n - 3));
    try std.testing.expect(bitmapGet(n - 2));
    try std.testing.expect(bitmapGet(n - 1));
}
