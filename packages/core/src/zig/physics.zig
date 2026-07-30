// ═══════════════════════════════════════════════════════════════════════════════
// DOMINATOR PHYSICS — Zig WASM Module (BARE METAL SIMD128 OPTIMIZED)
// ═══════════════════════════════════════════════════════════════════════════════

const std = @import("std");

const MAX_PARTICLES: u32 = 500000;
const CONFIG_OFFSET_BASE: u32 = MAX_PARTICLES * 6;

const CFG_WIDTH: u32 = 0;
const CFG_HEIGHT: u32 = 1;
const CFG_MOUSE_X: u32 = 2;
const CFG_MOUSE_Y: u32 = 3;
const CFG_MODE: u32 = 4;
const CFG_TICK: u32 = 5;

// Pre-computed physics constants
const MOUSE_REPULSE_RADIUS_SQ: f32 = 250000.0;
const MOUSE_REPULSE_RADIUS: f32 = 500.0;
const FORM_SPRING: f32 = 0.05;
const FORM_DAMP: f32 = 0.85;
const CHAOS_BROWNIAN: f32 = 0.2;
const CHAOS_DAMP: f32 = 0.96;
const EXPLODE_FORCE: f32 = 50.0;
const REPULSE_FACTOR: f32 = 0.1;

// SIMD vector type
const Vec4f = @Vector(4, f32);

// SIMD constants - comptime evaluated
const SIMD_MOUSE_REPULSE_RADIUS_SQ: Vec4f = @splat(Vec4f, MOUSE_REPULSE_RADIUS_SQ);
const SIMD_MOUSE_REPULSE_RADIUS: Vec4f = @splat(Vec4f, MOUSE_REPULSE_RADIUS);
const SIMD_FORM_SPRING: Vec4f = @splat(Vec4f, FORM_SPRING);
const SIMD_FORM_DAMP: Vec4f = @splat(Vec4f, FORM_DAMP);
const SIMD_CHAOS_BROWNIAN: Vec4f = @splat(Vec4f, CHAOS_BROWNIAN);
const SIMD_CHAOS_DAMP: Vec4f = @splat(Vec4f, CHAOS_DAMP);
const SIMD_EXPLODE_FORCE: Vec4f = @splat(Vec4f, EXPLODE_FORCE);
const SIMD_REPULSE_FACTOR: Vec4f = @splat(Vec4f, REPULSE_FACTOR);
const SIMD_ZERO: Vec4f = @splat(Vec4f, 0.0);
const SIMD_HALF: Vec4f = @splat(Vec4f, 0.5);
const SIMD_0_001: Vec4f = @splat(Vec4f, 0.001);
const SIMD_ONE: Vec4f = @splat(Vec4f, 1.0);
const SIMD_INV_MOUSE_RADIUS: Vec4f = @splat(Vec4f, 1.0 / MOUSE_REPULSE_RADIUS);
const SIMD_FIVE: Vec4f = @splat(Vec4f, 5.0);

// Heap: [posX][posY][velX][velY][targetX][targetY][config]
var heap: [MAX_PARTICLES * 8 + 64]u32 = [_]u32{0} ** (MAX_PARTICLES * 8 + 64);
var _count: u32 = 0;
var _rng_state: u32 = 123456789;

// ═══════════════════════════════════════════════════════════════════════════════
// XORSHIFT32 PRNG — SIMD4xF32 variant
// ═══════════════════════════════════════════════════════════════════════════════

inline fn xorshift32() u32 {
    _rng_state ^= _rng_state << 13;
    _rng_state ^= _rng_state >> 17;
    _rng_state ^= _rng_state << 5;
    return _rng_state;
}

inline fn xorshiftF32() f32 {
    return @as(f32, @floatFromInt(xorshift32() & 0x7FFFFFFF)) * (1.0 / 2147483647.0);
}

// Generate 4 random f32 in [0, 1)
inline fn xorshift4xF32() Vec4f {
    return Vec4f{
        @as(f32, @floatFromInt(xorshift32() & 0x7FFFFFFF)) * (1.0 / 2147483647.0),
        @as(f32, @floatFromInt(xorshift32() & 0x7FFFFFFF)) * (1.0 / 2147483647.0),
        @as(f32, @floatFromInt(xorshift32() & 0x7FFFFFFF)) * (1.0 / 2147483647.0),
        @as(f32, @floatFromInt(xorshift32() & 0x7FFFFFFF)) * (1.0 / 2147483647.0),
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MEMORY ACCESS HELPERS — SoA layout with SIMD alignment
// ═══════════════════════════════════════════════════════════════════════════════

inline fn posXPtr(i: u32) *align(16) f32 {
    return @ptrCast(&heap[i]);
}

inline fn posYPtr(i: u32) *align(16) f32 {
    return @ptrCast(&heap[_count + i]);
}

inline fn velXPtr(i: u32) *align(16) f32 {
    return @ptrCast(&heap[_count * 2 + i]);
}

inline fn velYPtr(i: u32) *align(16) f32 {
    return @ptrCast(&heap[_count * 3 + i]);
}

inline fn targetXPtr(i: u32) *align(16) f32 {
    return @ptrCast(&heap[_count * 4 + i]);
}

inline fn targetYPtr(i: u32) *align(16) f32 {
    return @ptrCast(&heap[_count * 5 + i]);
}

// Scalar accessors
inline fn getPosX(i: u32) f32 {
    return @as(*align(1) const f32, @ptrCast(&heap[i])).*;
}
inline fn setPosX(i: u32, val: f32) void {
    @as(*align(1) f32, @ptrCast(&heap[i])).* = val;
}
inline fn getPosY(i: u32) f32 {
    return @as(*align(1) const f32, @ptrCast(&heap[_count + i])).*;
}
inline fn setPosY(i: u32, val: f32) void {
    @as(*align(1) f32, @ptrCast(&heap[_count + i])).* = val;
}
inline fn getVelX(i: u32) f32 {
    return @as(*align(1) const f32, @ptrCast(&heap[_count * 2 + i])).*;
}
inline fn setVelX(i: u32, val: f32) void {
    @as(*align(1) f32, @ptrCast(&heap[_count * 2 + i])).* = val;
}
inline fn getVelY(i: u32) f32 {
    return @as(*align(1) const f32, @ptrCast(&heap[_count * 3 + i])).*;
}
inline fn setVelY(i: u32, val: f32) void {
    @as(*align(1) f32, @ptrCast(&heap[_count * 3 + i])).* = val;
}
inline fn getTargetX(i: u32) f32 {
    return @as(*align(1) const f32, @ptrCast(&heap[_count * 4 + i])).*;
}
inline fn setTargetX(i: u32, val: f32) void {
    @as(*align(1) f32, @ptrCast(&heap[_count * 4 + i])).* = val;
}
inline fn getTargetY(i: u32) f32 {
    return @as(*align(1) const f32, @ptrCast(&heap[_count * 5 + i])).*;
}
inline fn setTargetY(i: u32, val: f32) void {
    @as(*align(1) f32, @ptrCast(&heap[_count * 5 + i])).* = val;
}

inline fn getConfig(offset: u32) i32 {
    return @as(i32, @bitCast(heap[CONFIG_OFFSET_BASE + offset]));
}
inline fn setConfig(offset: u32, val: i32) void {
    heap[CONFIG_OFFSET_BASE + offset] = @bitCast(val);
}

// Load/store SIMD vectors
inline fn load4(ptr: *align(16) f32) Vec4f {
    return @as(Vec4f, @bitCast(*[4]f32, ptr).*);
}

inline fn store4(ptr: *align(16) f32, v: Vec4f) void {
    @as(*[4]f32, @ptrCast(ptr)).* = @bitCast(v);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHYSICS INIT — SIMD
// ═══════════════════════════════════════════════════════════════════════════════

export fn physics_init(count: u32) void {
    _count = @min(count, MAX_PARTICLES);
    _rng_state = 123456789;

    const width: f32 = @floatFromInt(@max(getConfig(CFG_WIDTH), 1));
    const height: f32 = @floatFromInt(@max(getConfig(CFG_HEIGHT), 1));
    const simd_width: Vec4f = @splat(Vec4f, width);
    const simd_height: Vec4f = @splat(Vec4f, height);

    var i: u32 = 0;
    const simd_end = _count & ~@as(u32, 3);

    // SIMD init: 4 particles at a time
    while (i < simd_end) : (i += 4) {
        const rx = xorshift4xF32();
        const ry = xorshift4xF32();
        const rvx = (xorshift4xF32() - SIMD_HALF) * SIMD_FIVE;
        const rvy = (xorshift4xF32() - SIMD_HALF) * SIMD_FIVE;

        store4(posXPtr(i), rx * simd_width);
        store4(posYPtr(i), ry * simd_height);
        store4(velXPtr(i), rvx);
        store4(velYPtr(i), rvy);
    }

    // Scalar tail
    while (i < _count) : (i += 1) {
        setPosX(i, xorshiftF32() * width);
        setPosY(i, xorshiftF32() * height);
        setVelX(i, (xorshiftF32() - 0.5) * 5.0);
        setVelY(i, (xorshiftF32() - 0.5) * 5.0);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHYSICS STEP — SIMD128 OPTIMIZED (8-wide unrolled)
// ═══════════════════════════════════════════════════════════════════════════════

export fn physics_step() void {
    // Hoist config reads — single cache line access
    const width: f32 = @floatFromInt(@max(getConfig(CFG_WIDTH), 1));
    const height: f32 = @floatFromInt(@max(getConfig(CFG_HEIGHT), 1));
    const mouse_x: f32 = @floatFromInt(getConfig(CFG_MOUSE_X));
    const mouse_y: f32 = @floatFromInt(getConfig(CFG_MOUSE_Y));
    const is_forming = getConfig(CFG_MODE) == 1;

    var tick = getConfig(CFG_TICK);
    tick += 1;
    setConfig(CFG_TICK, tick);

    const simd_width: Vec4f = @splat(Vec4f, width);
    const simd_height: Vec4f = @splat(Vec4f, height);
    const simd_mouse_x: Vec4f = @splat(Vec4f, mouse_x);
    const simd_mouse_y: Vec4f = @splat(Vec4f, mouse_y);

    if (is_forming) {
        // FORMING MODE: scalar (branching per particle to target)
        var i: u32 = 0;
        while (i < _count) : (i += 1) {
            var x = getPosX(i);
            var y = getPosY(i);
            var vx = getVelX(i);
            var vy = getVelY(i);

            const dx = getTargetX(i) - x;
            const dy = getTargetY(i) - y;
            vx += dx * FORM_SPRING;
            vy += dy * FORM_SPRING;
            vx *= FORM_DAMP;
            vy *= FORM_DAMP;
            x += vx;
            y += vy;

            setPosX(i, x);
            setPosY(i, y);
            setVelX(i, vx);
            setVelY(i, vy);
        }
    } else {
        // CHAOS MODE: SIMD128 - 8 particles per loop iteration
        const simd_end = _count & ~@as(u32, 7); // 8-wide unrolling
        var i: u32 = 0;

        // ┌─────────────────────────────────────────────────────────────────────
        // 8-WIDE UNROLLED SIMD LOOP (2x Vec4f per iteration)
        // Maximizes ILP, hides latency, saturates execution ports
        // └─────────────────────────────────────────────────────────────────────
        while (i < simd_end) : (i += 8) {
            // Load 8 particles (2x SIMD vectors each for x, y, vx, vy)
            var x0 = load4(posXPtr(i));
            var x1 = load4(posXPtr(i + 4));
            var y0 = load4(posYPtr(i));
            var y1 = load4(posYPtr(i + 4));
            var vx0 = load4(velXPtr(i));
            var vx1 = load4(velXPtr(i + 4));
            var vy0 = load4(velYPtr(i));
            var vy1 = load4(velYPtr(i + 4));

            // ── Mouse repulsion (vectorized) ──
            var dx0 = simd_mouse_x - x0;
            var dx1 = simd_mouse_x - x1;
            var dy0 = simd_mouse_y - y0;
            var dy1 = simd_mouse_y - y1;

            var dist_sq0 = dx0 * dx0 + dy0 * dy0;
            var dist_sq1 = dx1 * dx1 + dy1 * dy1;

            // Branchless repulsion: compute force for all lanes, mask later
            var inv_dist0 = @sqrt(@max(SIMD_0_001, dist_sq0));
            var inv_dist1 = @sqrt(@max(SIMD_0_001, dist_sq1));

            var force0 = (SIMD_MOUSE_REPULSE_RADIUS - inv_dist0) * SIMD_INV_MOUSE_RADIUS;
            var force1 = (SIMD_MOUSE_REPULSE_RADIUS - inv_dist1) * SIMD_INV_MOUSE_RADIUS;

            // Mask: only apply force where dist_sq < R^2
            var mask0 = @vecCmp(dist_sq0, SIMD_MOUSE_REPULSE_RADIUS_SQ, .Lt);
            var mask1 = @vecCmp(dist_sq1, SIMD_MOUSE_REPULSE_RADIUS_SQ, .Lt);

            force0 = @select(mask0, force0, SIMD_ZERO);
            force1 = @select(mask1, force1, SIMD_ZERO);

            vx0 -= dx0 * force0 * SIMD_REPULSE_FACTOR;
            vx1 -= dx1 * force1 * SIMD_REPULSE_FACTOR;
            vy0 -= dy0 * force0 * SIMD_REPULSE_FACTOR;
            vy1 -= dy1 * force1 * SIMD_REPULSE_FACTOR;

            // ── Brownian motion ──
            vx0 += (xorshift4xF32() - SIMD_HALF) * SIMD_CHAOS_BROWNIAN;
            vx1 += (xorshift4xF32() - SIMD_HALF) * SIMD_CHAOS_BROWNIAN;
            vy0 += (xorshift4xF32() - SIMD_HALF) * SIMD_CHAOS_BROWNIAN;
            vy1 += (xorshift4xF32() - SIMD_HALF) * SIMD_CHAOS_BROWNIAN;

            // ── Damping ──
            vx0 *= SIMD_CHAOS_DAMP;
            vx1 *= SIMD_CHAOS_DAMP;
            vy0 *= SIMD_CHAOS_DAMP;
            vy1 *= SIMD_CHAOS_DAMP;

            // ── Integration ──
            x0 += vx0;
            x1 += vx1;
            y0 += vy0;
            y1 += vy1;

            // ── Branchless toroidal wrapping ──
            x0 = @select(@vecCmp(x0, SIMD_ZERO, .Lt), x0 + simd_width, @select(@vecCmp(x0, simd_width, .Gt), x0 - simd_width, x0));
            x1 = @select(@vecCmp(x1, SIMD_ZERO, .Lt), x1 + simd_width, @select(@vecCmp(x1, simd_width, .Gt), x1 - simd_width, x1));
            y0 = @select(@vecCmp(y0, SIMD_ZERO, .Lt), y0 + simd_height, @select(@vecCmp(y0, simd_height, .Gt), y0 - simd_height, y0));
            y1 = @select(@vecCmp(y1, SIMD_ZERO, .Lt), y1 + simd_height, @select(@vecCmp(y1, simd_height, .Gt), y1 - simd_height, y1));

            // Store back
            store4(posXPtr(i), x0);
            store4(posXPtr(i + 4), x1);
            store4(posYPtr(i), y0);
            store4(posYPtr(i + 4), y1);
            store4(velXPtr(i), vx0);
            store4(velXPtr(i + 4), vx1);
            store4(velYPtr(i), vy0);
            store4(velYPtr(i + 4), vy1);
        }

        // Scalar tail (1-7 particles)
        while (i < _count) : (i += 1) {
            var x = getPosX(i);
            var y = getPosY(i);
            var vx = getVelX(i);
            var vy = getVelY(i);

            const dx = mouse_x - x;
            const dy = mouse_y - y;
            const dist_sq = dx * dx + dy * dy;

            if (dist_sq < MOUSE_REPULSE_RADIUS_SQ) {
                const safe_sq = @max(dist_sq, 0.001);
                const dist = @sqrt(safe_sq);
                const force = (MOUSE_REPULSE_RADIUS - dist) / MOUSE_REPULSE_RADIUS;
                vx -= dx * force * REPULSE_FACTOR;
                vy -= dy * force * REPULSE_FACTOR;
            }

            vx += (xorshiftF32() - 0.5) * CHAOS_BROWNIAN;
            vy += (xorshiftF32() - 0.5) * CHAOS_BROWNIAN;
            vx *= CHAOS_DAMP;
            vy *= CHAOS_DAMP;
            x += vx;
            y += vy;

            if (x < 0) x += width else if (x > width) x -= width;
            if (y < 0) y += height else if (y > height) y -= height;

            setPosX(i, x);
            setPosY(i, y);
            setVelX(i, vx);
            setVelY(i, vy);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPLODE — SIMD128
// ═══════════════════════════════════════════════════════════════════════════════

export fn physics_explode() void {
    var i: u32 = 0;
    const simd_end = _count & ~@as(u32, 3);

    while (i < simd_end) : (i += 4) {
        const rvx = (xorshift4xF32() - SIMD_HALF) * SIMD_EXPLODE_FORCE;
        const rvy = (xorshift4xF32() - SIMD_HALF) * SIMD_EXPLODE_FORCE;
        store4(velXPtr(i), load4(velXPtr(i)) + rvx);
        store4(velYPtr(i), load4(velYPtr(i)) + rvy);
    }

    while (i < _count) : (i += 1) {
        setVelX(i, getVelX(i) + (xorshiftF32() - 0.5) * EXPLODE_FORCE);
        setVelY(i, getVelY(i) + (xorshiftF32() - 0.5) * EXPLODE_FORCE);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TARGETS — Bulk copy from external pointer
// ═══════════════════════════════════════════════════════════════════════════════

export fn physics_set_targets(ptr: u32, count: u32) void {
    const n = @min(count, _count);
    var i: u32 = 0;
    const simd_end = n & ~@as(u32, 3);

    while (i < simd_end) : (i += 4) {
        const src = @ptrCast(*align(16) const f32, ptr + i * 8);
        store4(targetXPtr(i), load4(src));
        store4(targetYPtr(i), load4(src + 4));
    }

    while (i < n) : (i += 1) {
        setTargetX(i, @as(*align(1) const f32, @ptrCast(ptr + i * 8)).*);
        setTargetY(i, @as(*align(1) const f32, @ptrCast(ptr + i * 8 + 4)).*);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG SETTERS
// ═══════════════════════════════════════════════════════════════════════════════

export fn physics_set_config(key: u32, value: i32) void {
    if (key <= CFG_TICK) setConfig(key, value);
}

export fn physics_get_count() u32 {
    return _count;
}

export fn physics_positions_ptr() u32 {
    return 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

test "physics init and step" {
    setConfig(CFG_WIDTH, 1920);
    setConfig(CFG_HEIGHT, 1080);
    setConfig(CFG_MOUSE_X, 960);
    setConfig(CFG_MOUSE_Y, 540);
    setConfig(CFG_MODE, 0);

    physics_init(100);
    try std.testing.expectEqual(@as(u32, 100), physics_get_count());

    physics_step();
    try std.testing.expect(getConfig(CFG_TICK) == 1);
}

test "physics explode" {
    setConfig(CFG_WIDTH, 800);
    setConfig(CFG_HEIGHT, 600);
    physics_init(50);
    physics_explode();
}

test "physics set targets" {
    setConfig(CFG_WIDTH, 800);
    setConfig(CFG_HEIGHT, 600);
    physics_init(10);

    var i: u32 = 0;
    while (i < 10) : (i += 1) {
        const ptr: *align(1) f32 = @ptrCast(&heap[1000 + i * 2]);
        ptr.* = @as(f32, @floatFromInt(i * 10));
        const ptr2: *align(1) f32 = @ptrCast(&heap[1000 + i * 2 + 1]);
        ptr2.* = @as(f32, @floatFromInt(i * 20));
    }

    physics_set_targets(1000, 10);

    try std.testing.expectEqual(0.0, getTargetX(0));
    try std.testing.expectEqual(10.0, getTargetX(1));
}
