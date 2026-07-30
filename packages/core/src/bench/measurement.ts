export type NsTimestamp = bigint;

let _clock: (() => NsTimestamp) | null = null;
let _clockName: string = 'none';
let _overheadNs: number = -1;
let _overheadCalibrated: boolean = false;

function detectClock(): (() => NsTimestamp) {
    if (typeof process !== 'undefined' && typeof process.hrtime?.bigint === 'function') {
        _clockName = 'hrtime.bigint';
        return () => process.hrtime.bigint();
    }
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        _clockName = 'performance.now * 1e6';
        const pn = performance.now.bind(performance);
        return () => BigInt(Math.round(pn() * 1e6));
    }
    _clockName = 'Date.now * 1e6';
    return () => BigInt(Date.now()) * 1_000_000n;
}

export function getClockName(): string {
    if (!_clock) _clock = detectClock();
    return _clockName;
}

export function now(): NsTimestamp {
    if (!_clock) _clock = detectClock();
    return _clock();
}

export function elapsedNs(start: NsTimestamp): number {
    return Number(now() - start);
}

export function elapsedSince(start: NsTimestamp): number {
    return Number(now() - start);
}

export function toMs(ns: number): string {
    if (ns >= 1_000_000) return (ns / 1_000_000).toFixed(2) + ' ms';
    if (ns >= 1_000) return (ns / 1_000).toFixed(2) + ' μs';
    return ns.toFixed(1) + ' ns';
}

export function formatOps(opsPerSec: number): string {
    if (opsPerSec >= 1e9) return (opsPerSec / 1e9).toFixed(2) + ' G';
    if (opsPerSec >= 1e6) return (opsPerSec / 1e6).toFixed(2) + ' M';
    if (opsPerSec >= 1e3) return (opsPerSec / 1e3).toFixed(2) + ' K';
    return opsPerSec.toFixed(0);
}

export function calibrate(samples: number = 10000): number {
    if (_overheadCalibrated) return _overheadNs;

    const arr = new Float64Array(samples);
    for (let i = 0; i < samples; i++) {
        const t0 = now();
        const t1 = now();
        arr[i] = Number(t1 - t0);
    }
    arr.sort();
    const median = arr[samples >>> 1];
    _overheadNs = median;
    _overheadCalibrated = true;
    return _overheadNs;
}

export function getOverhead(): number {
    if (!_overheadCalibrated) return calibrate();
    return _overheadNs;
}

export function resetCalibration(): void {
    _overheadCalibrated = false;
}

export function overheadAdjust(ns: number): number {
    const oh = getOverhead();
    return ns > oh ? ns - oh : 0;
}
