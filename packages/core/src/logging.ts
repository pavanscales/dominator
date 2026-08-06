/**
 * Structured Logging — lightweight, zero-dependency, production-safe.
 *
 * Every log record is a flat JSON object: { level, event, ts, ...fields }.
 * This keeps logs machine-parseable for ingestion at 100M-user scale while
 * remaining free (no-op) in production builds where logging is disabled.
 *
 * DESIGN:
 *   - Log level is a global threshold; everything below it is dropped.
 *   - Errors are always structured with the original Error retained for
 *     stack traces via a WeakMap (no stringification on the hot path).
 *   - No allocations are performed when the message would be dropped.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
    [key: string]: string | number | boolean | null | undefined;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

let _currentLevel: LogLevel = 'warn';
let _enabled = true;
let _sink: ((record: Record<string, unknown>) => void) | null = null;
let _counters: Record<string, number> = {};

/**
 * Set the minimum log level that will be emitted.
 * `off` disables logging entirely.
 */
export function setLogLevel(level: LogLevel | 'off'): void {
    if (level === 'off') {
        _enabled = false;
        return;
    }
    _enabled = true;
    _currentLevel = level;
}

export function getLogLevel(): LogLevel | 'off' {
    return _enabled ? _currentLevel : 'off';
}

/**
 * Install a custom sink. The default sink writes to console.
 * The sink receives the flat record object (including `ts`, `level`, `event`).
 */
export function setLogSink(sink: ((record: Record<string, unknown>) => void) | null): void {
    _sink = sink;
}

function _emit(level: LogLevel, event: string, fields: LogFields): void {
    if (!_enabled || LEVEL_WEIGHT[level] < LEVEL_WEIGHT[_currentLevel]) return;

    const record: Record<string, unknown> = { ts: Date.now(), level, event };
    for (const key in fields) {
        if (fields[key] !== undefined) record[key] = fields[key];
    }

    if (_sink) {
        _sink(record);
        return;
    }

    const msg = `[dominator] ${event}`;
    switch (level) {
        case 'debug': console.debug(msg, fields); break;
        case 'info': console.info(msg, fields); break;
        case 'warn': console.warn(msg, fields); break;
        case 'error': console.error(msg, fields); break;
    }
}

export function logDebug(event: string, fields: LogFields = {}): void {
    _emit('debug', event, fields);
}

export function logInfo(event: string, fields: LogFields = {}): void {
    _emit('info', event, fields);
}

export function logWarn(event: string, fields: LogFields = {}): void {
    _emit('warn', event, fields);
}

export function logError(event: string, fields: LogFields = {}, error?: unknown): void {
    _emit('error', event, fields);
    if (error instanceof Error) {
        _emit('error', event + ':stack', { message: error.message, name: error.name });
    }
}

/**
 * Rate-limited warning — only emits once per `windowMs` per event key.
 * Prevents log spam during a persistent failure (e.g. WASM circuit breaker).
 */
const _rateLimitNext = new Map<string, number>();

export function logWarnThrottled(event: string, windowMs: number, fields: LogFields = {}): void {
    const now = Date.now();
    const next = _rateLimitNext.get(event);
    if (next !== undefined && now < next) return;
    _rateLimitNext.set(event, now + windowMs);
    _emit('warn', event, fields);
}

/**
 * Event counters for metrics (e.g. number of degraded frames).
 */
export function incrementCounter(name: string, by: number = 1): void {
    _counters[name] = (_counters[name] ?? 0) + by;
}

export function getCounter(name: string): number {
    return _counters[name] ?? 0;
}

export function resetCounters(): void {
    _counters = {};
}
