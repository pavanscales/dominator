import { now, elapsedNs, calibrate, overheadAdjust, toMs } from './measurement';

export interface ICLocation {
    file: string;
    line: number;
    column: number;
    type: 'load' | 'store' | 'call';
    state: 'uninitialized' | 'premonomorphic' | 'monomorphic' | 'polymorphic' | 'megamorphic';
    hitCount: number;
    map: string;
}

export type ICState = 'UNINIT' | 'PREMONOMORPHIC' | 'MONOMORPHIC' | 'POLYMORPHIC' | 'MEGAMORPHIC' | 'GENERIC';

export interface V8TraceFlags {
    traceIC: boolean;
    traceDeopt: boolean;
    traceOpt: boolean;
    traceMaps: boolean;
    traceInline: boolean;
    runtimeCallStats: boolean;
    traceGC: boolean;
    codeComments: boolean;
    printCode: boolean;
}

export function allV8Flags(): V8TraceFlags {
    return {
        traceIC: true,
        traceDeopt: true,
        traceOpt: true,
        traceMaps: false,
        traceInline: true,
        runtimeCallStats: true,
        traceGC: true,
        codeComments: false,
        printCode: false,
    };
}

export function v8FlagsToString(flags: Partial<V8TraceFlags> = {}): string {
    const f = { ...allV8Flags(), ...flags };
    const parts: string[] = [];
    if (f.traceIC) parts.push('--trace-ic');
    if (f.traceDeopt) parts.push('--trace-deopt');
    if (f.traceOpt) parts.push('--trace-opt');
    if (f.traceMaps) parts.push('--trace-maps');
    if (f.traceInline) parts.push('--trace-inline');
    if (f.runtimeCallStats) parts.push('--runtime-call-stats');
    if (f.traceGC) parts.push('--trace-gc');
    if (f.codeComments) parts.push('--code-comments');
    if (f.printCode) parts.push('--print-code');
    return parts.join(' ');
}

export function v8RunCommand(
    testFile: string,
    flags: Partial<V8TraceFlags> = {}
): string {
    const nodeFlags = v8FlagsToString(flags);
    return `node ${nodeFlags} node_modules/.bin/vitest run ${testFile} 2>&1 | tee v8-trace.log`;
}

export interface MegamorphicProbeConfig {
    targets: (() => void)[];
    probeIterations: number;
    warmupIterations: number;
    thresholdCV: number;
}

export interface MegamorphicProbeResult {
    isMegamorphic: boolean;
    cv: number;
    medianNs: number;
    byTarget: { name: string; medianNs: number; opsPerSec: number }[];
    details: string;
}

export function probeMegamorphic(
    label: string,
    targets: { name: string; fn: () => void }[],
    config?: Partial<MegamorphicProbeConfig>
): MegamorphicProbeResult {
    const cfg = {
        targets: targets.map(t => t.fn),
        probeIterations: config?.probeIterations ?? 10000,
        warmupIterations: config?.warmupIterations ?? 5000,
        thresholdCV: config?.thresholdCV ?? 0.3,
        ...config,
    };

    const oh = calibrate(10000);

    const byTarget: MegamorphicProbeResult['byTarget'] = [];

    for (const t of targets) {
        for (let i = 0; i < cfg.warmupIterations; i++) t.fn();

        const samples = new Float64Array(Math.min(cfg.probeIterations, 50000));
        const targetSamples = Math.min(cfg.probeIterations, 50000);
        for (let i = 0; i < targetSamples; i++) {
            const t0 = now();
            t.fn();
            let delta = elapsedNs(t0);
            delta = overheadAdjust(delta);
            samples[i] = delta;
        }
        samples.sort();
        const medianNs = samples[targetSamples >>> 1];
        const avgNs = medianNs > 0 ? medianNs : 1;
        byTarget.push({
            name: t.name,
            medianNs,
            opsPerSec: 1e9 / avgNs,
        });
    }

    const medians = byTarget.map(t => t.medianNs);
    let sum = 0;
    for (const m of medians) sum += m;
    const mean = sum / medians.length;
    let variance = 0;
    for (const m of medians) {
        const d = m - mean;
        variance += d * d;
    }
    const stddev = Math.sqrt(variance / medians.length);
    const cv = stddev / mean;

    const isMegamorphic = cv > cfg.thresholdCV;

    let details: string;
    if (isMegamorphic) {
        details = `MEGAMORPHIC DETECTED: CV=${(cv * 100).toFixed(1)}% (threshold=${(cfg.thresholdCV * 100).toFixed(0)}%). Targets: ${byTarget.map(t => `${t.name}=${toMs(t.medianNs)}`).join(', ')}`;
    } else {
        details = `MONO/POLYMORPHIC: CV=${(cv * 100).toFixed(1)}%. Targets: ${byTarget.map(t => `${t.name}=${toMs(t.medianNs)}`).join(', ')}`;
    }

    return {
        isMegamorphic,
        cv,
        medianNs: byTarget.reduce((a, b) => a + b.medianNs, 0) / byTarget.length,
        byTarget,
        details,
    };
}

export function logICState(results: MegamorphicProbeResult[]): void {
    console.log('\n── V8 IC STATE PROBE ──');
    for (const r of results) {
        console.log(`  ${r.isMegamorphic ? '⚠️  MEGAMORPHIC' : '✅  OK'}  CV=${(r.cv * 100).toFixed(1)}%`);
        console.log(`    ${r.details}`);
    }
}

export function megamorphicWarning(): string {
    return [
        '',
        '╔══════════════════════════════════════════════════════════════╗',
        '║  MEGAMORPHIC IC DETECTED!                                   ║',
        '║                                                              ║',
        '║  The _effectFns[id]() pattern creates different closures   ║',
        '║  at every index, so V8 sees infinite shapes → megamorphic.  ║',
        '║                                                              ║',
        '║  FIX: Replace closures with function table dispatch:         ║',
        '║    handlerTable[handlerId](args)  // monomorphic             ║',
        '║                                                              ║',
        '║  EXPECTED SPEEDUP: 3-10x on signal.set() hot path           ║',
        '╚══════════════════════════════════════════════════════════════╝',
        '',
    ].join('\n');
}

export function v8DeoptSummary(logPath?: string): string {
    return [
        '',
        '── V8 DEOPTIMIZATION ANALYSIS ──',
        '',
        'Run with:',
        `  npx vitest run --reporter=verbose packages/core/src/bench/targeted-benchmarks.test.ts`,
        '  NODE_OPTIONS="--trace-deopt --trace-opt --trace-ic" npx vitest run ... > v8-trace.log',
        '',
        'Then check v8-trace.log for:',
        '  - "deopt" lines: code was deoptimized (bad!)',
        '  - "megamorphic" in IC traces: callsite is megamorphic (bad!)',
        '  - "polymorphic" in IC traces: callsite sees 2-4 shapes (acceptable)',
        '  - "monomorphic" in IC traces: callsite sees 1 shape (ideal)',
        '',
        'Key patterns to grep:',
        '  grep "deopt" v8-trace.log | grep -i "dominator"',
        '  grep "megamorphic" v8-trace.log',
        '  grep "polymorphic" v8-trace.log',
        '  grep "runtime call stats" v8-trace.log  (--runtime-call-stats)',
        '',
        'WARNING:',
        '  --trace-ic produces MASSIVE output. Pipe to file, not terminal.',
        '',
    ].join('\n');
}
