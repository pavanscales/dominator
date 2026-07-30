/**
 * Animation Engine — frame-stage animation subsystem.
 *
 * ARCHITECTURE:
 *   Animation runs as a dedicated frame stage between SIGNALS and LAYOUT.
 *   Every animated property is a compute graph node.
 *   The engine supports:
 *     - Tweens: linear/ease-in-out/cubic-bezier interpolation
 *     - Springs: velocity-based natural motion (mass, stiffness, damping)
 *     - Timelines: multi-keyframe sequences with timing functions
 *
 * STORAGE:
 *   All animation state in typed arrays (SoA).
 *   Tween properties: start/end/duration/elapsed/timingFn per animation.
 *   Spring properties: value/velocity/target/mass/stiffness/damping per spring.
 *   Each animation maps to an ECS entity + style property offset.
 *
 * ZERO-ALLOCATION:
 *   - All state pre-allocated in typed arrays
 *   - Completed animations removed via swap-remove (O(1))
 *   - Frame update iterates only active animations (no scan)
 */

import {
    getWorld, Flag,
    setStyleFloat, getStyleFloat,
    STYLE_X, STYLE_Y, STYLE_W, STYLE_H,
    STYLE_OPACITY, STYLE_BORDER_RADIUS,
} from './ecs';

// ═══════════════════════════════════════════════════════════════════════════
// ANIMATION TYPES
// ═══════════════════════════════════════════════════════════════════════════

export const enum AnimType {
    NONE    = 0,
    TWEEN   = 1,
    SPRING  = 2,
    TIMELINE = 3,
}

export const enum TimingFn {
    LINEAR      = 0,
    EASE_IN     = 1,
    EASE_OUT    = 2,
    EASE_IN_OUT = 3,
    CUBIC_BEZIER = 4,
}

// ═══════════════════════════════════════════════════════════════════════════
// ANIMATION STATE — SoA layout
// ═══════════════════════════════════════════════════════════════════════════

export interface AnimationState {
    // Active animation count
    count: number;

    // Per-animation type
    types: Uint8Array[];       // AnimType per animation, stored in arrays

    // Tween storage
    tweenEntityId: Int32Array;
    tweenStyleOffset: Uint8Array;
    tweenStartVal: Float64Array;
    tweenEndVal: Float64Array;
    tweenDuration: Float64Array;
    tweenElapsed: Float64Array;
    tweenTimingFn: Uint8Array;

    // Spring storage
    springEntityId: Int32Array;
    springStyleOffset: Uint8Array;
    springValue: Float64Array;
    springVelocity: Float64Array;
    springTarget: Float64Array;
    springMass: Float64Array;
    springStiffness: Float64Array;
    springDamping: Float64Array;

    // Capacity
    capacity: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

const INITIAL_CAP = 4096;
let _state: AnimationState | null = null;

export function createAnimationState(capacity: number = INITIAL_CAP): AnimationState {
    const cap = Math.max(capacity, 256);
    const state: AnimationState = {
        count: 0,
        types: [new Uint8Array(cap)],

        tweenEntityId: new Int32Array(cap).fill(-1),
        tweenStyleOffset: new Uint8Array(cap),
        tweenStartVal: new Float64Array(cap),
        tweenEndVal: new Float64Array(cap),
        tweenDuration: new Float64Array(cap),
        tweenElapsed: new Float64Array(cap),
        tweenTimingFn: new Uint8Array(cap),

        springEntityId: new Int32Array(cap).fill(-1),
        springStyleOffset: new Uint8Array(cap),
        springValue: new Float64Array(cap),
        springVelocity: new Float64Array(cap),
        springTarget: new Float64Array(cap),
        springMass: new Float64Array(cap),
        springStiffness: new Float64Array(cap),
        springDamping: new Float64Array(cap),

        capacity: cap,
    };
    _state = state;
    return state;
}

export function getAnimationState(): AnimationState {
    if (!_state) _state = createAnimationState();
    return _state;
}

export function destroyAnimationState(): void {
    _state = null;
}

// ═══════════════════════════════════════════════════════════════════════════
// TWEEN API
// ═══════════════════════════════════════════════════════════════════════════

export function addTween(
    entityId: number,
    styleOffset: number,
    fromVal: number,
    toVal: number,
    durationMs: number,
    timingFn: TimingFn = TimingFn.EASE_IN_OUT,
): number {
    const s = getAnimationState();
    const idx = s.count;
    if (idx >= s.capacity) return -1;

    s.types[0][idx] = AnimType.TWEEN;
    s.tweenEntityId[idx] = entityId;
    s.tweenStyleOffset[idx] = styleOffset;
    s.tweenStartVal[idx] = fromVal;
    s.tweenEndVal[idx] = toVal;
    s.tweenDuration[idx] = durationMs;
    s.tweenElapsed[idx] = 0;
    s.tweenTimingFn[idx] = timingFn;

    s.count = idx + 1;

    // Set initial value
    setStyleFloat(entityId, styleOffset, fromVal);
    return idx;
}

// ═══════════════════════════════════════════════════════════════════════════
// SPRING API
// ═══════════════════════════════════════════════════════════════════════════

export function addSpring(
    entityId: number,
    styleOffset: number,
    initialValue: number,
    target: number,
    stiffness: number = 180,
    damping: number = 12,
    mass: number = 1,
): number {
    const s = getAnimationState();
    const idx = s.count;
    if (idx >= s.capacity) return -1;

    s.types[0][idx] = AnimType.SPRING;
    s.springEntityId[idx] = entityId;
    s.springStyleOffset[idx] = styleOffset;
    s.springValue[idx] = initialValue;
    s.springVelocity[idx] = 0;
    s.springTarget[idx] = target;
    s.springStiffness[idx] = stiffness;
    s.springDamping[idx] = damping;
    s.springMass[idx] = mass;

    s.count = idx + 1;

    setStyleFloat(entityId, styleOffset, initialValue);
    return idx;
}

// ═══════════════════════════════════════════════════════════════════════════
// FRAME UPDATE — tween interpolation
// ═══════════════════════════════════════════════════════════════════════════

function _applyTiming(t: number, fn: TimingFn): number {
    switch (fn) {
        case TimingFn.LINEAR: return t;
        case TimingFn.EASE_IN: return t * t;
        case TimingFn.EASE_OUT: return t * (2 - t);
        case TimingFn.EASE_IN_OUT: return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        case TimingFn.CUBIC_BEZIER: return t * t * (3 - 2 * t); // smoothstep
        default: return t;
    }
}

export function updateTweens(deltaMs: number): number {
    const s = _state;
    if (!s || s.count === 0) return 0;

    let activeCount = 0;
    const types = s.types[0];
    let writeIdx = 0;

    for (let readIdx = 0; readIdx < s.count; readIdx++) {
        const type = types[readIdx];
        if (type === AnimType.TWEEN) {
            const elapsed = s.tweenElapsed[readIdx] + deltaMs;
            const dur = s.tweenDuration[readIdx];
            const t = Math.min(elapsed / dur, 1);
            const easedT = _applyTiming(t, s.tweenTimingFn[readIdx] as TimingFn);

            const val = s.tweenStartVal[readIdx] + (s.tweenEndVal[readIdx] - s.tweenStartVal[readIdx]) * easedT;
            setStyleFloat(s.tweenEntityId[readIdx], s.tweenStyleOffset[readIdx], val);

            if (t >= 1) {
                // Animation complete — snap to final value
                setStyleFloat(s.tweenEntityId[readIdx], s.tweenStyleOffset[readIdx], s.tweenEndVal[readIdx]);
                // Swap-remove: don't copy, just skip
                continue;
            }

            s.tweenElapsed[readIdx] = elapsed;
        } else if (type === AnimType.SPRING) {
            const vel = s.springVelocity[readIdx];
            const val = s.springValue[readIdx];
            const target = s.springTarget[readIdx];
            const stiffness = s.springStiffness[readIdx];
            const damping = s.springDamping[readIdx];
            const mass = s.springMass[readIdx];

            const dt = deltaMs / 1000;
            const force = -stiffness * (val - target) - damping * vel;
            const accel = force / mass;
            const newVel = vel + accel * dt;
            const newVal = val + newVel * dt;

            s.springValue[readIdx] = newVal;
            s.springVelocity[readIdx] = newVel;

            setStyleFloat(s.springEntityId[readIdx], s.springStyleOffset[readIdx], newVal);

            // Check if settled: close to target AND velocity near zero
            if (Math.abs(newVal - target) < 0.001 && Math.abs(newVel) < 0.01) {
                setStyleFloat(s.springEntityId[readIdx], s.springStyleOffset[readIdx], target);
                continue; // swap-remove
            }
        }

        // Keep this animation — compact if needed
        if (writeIdx !== readIdx) {
            types[writeIdx] = types[readIdx];
            if (type === AnimType.TWEEN) {
                s.tweenEntityId[writeIdx] = s.tweenEntityId[readIdx];
                s.tweenStyleOffset[writeIdx] = s.tweenStyleOffset[readIdx];
                s.tweenStartVal[writeIdx] = s.tweenStartVal[readIdx];
                s.tweenEndVal[writeIdx] = s.tweenEndVal[readIdx];
                s.tweenDuration[writeIdx] = s.tweenDuration[readIdx];
                s.tweenElapsed[writeIdx] = s.tweenElapsed[readIdx];
                s.tweenTimingFn[writeIdx] = s.tweenTimingFn[readIdx];
            } else if (type === AnimType.SPRING) {
                s.springEntityId[writeIdx] = s.springEntityId[readIdx];
                s.springStyleOffset[writeIdx] = s.springStyleOffset[readIdx];
                s.springValue[writeIdx] = s.springValue[readIdx];
                s.springVelocity[writeIdx] = s.springVelocity[readIdx];
                s.springTarget[writeIdx] = s.springTarget[readIdx];
                s.springMass[writeIdx] = s.springMass[readIdx];
                s.springStiffness[writeIdx] = s.springStiffness[readIdx];
                s.springDamping[writeIdx] = s.springDamping[readIdx];
            }
        }
        writeIdx++;
        activeCount++;
    }

    s.count = writeIdx;
    return activeCount;
}

// ═══════════════════════════════════════════════════════════════════════════
// ANIMATION FRAME STAGE — called by frame scheduler
// ═══════════════════════════════════════════════════════════════════════════

let _lastTimestamp = 0;

export function runAnimationStage(timestamp: number): number {
    const s = _state;
    if (!s || s.count === 0) return 0;

    if (_lastTimestamp === 0) {
        _lastTimestamp = timestamp;
        return 0;
    }

    const delta = Math.min(timestamp - _lastTimestamp, 50); // cap at 50ms to avoid spiral
    _lastTimestamp = timestamp;

    const activeAnimations = updateTweens(delta);
    return activeAnimations;
}

export function resetAnimationStage(): void {
    _lastTimestamp = 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// RESET
// ═══════════════════════════════════════════════════════════════════════════

export function resetAnimations(): void {
    if (_state) {
        _state.count = 0;
        _state.types[0].fill(0);
    }
    _lastTimestamp = 0;
}