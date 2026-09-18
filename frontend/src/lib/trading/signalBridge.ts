/**
 * The chart-to-trading signal boundary.
 *
 * An indicator owns the meaning of a signal. The terminal only consumes the
 * indicator's already-rendered marker output; it never reimplements a
 * crossover, reads a plot and guesses at BUY/SELL, or puts an order in calc().
 * This is important for custom indicators: the marker function is the same
 * function the chart calls to paint the marker, so what is visible and what can
 * trade cannot drift apart.
 */

import type {
  Bar,
  IndicatorApi,
  IndicatorDescriptor,
  IndicatorValues,
  SeriesMarker,
} from 'openalgo-charts'

export type SignalSide = 'BUY' | 'SELL'
export type SignalSource = 'marker' | 'alert'

export interface IndicatorSignal {
  indicatorId: string
  instanceId: string
  side: SignalSide
  time: number
  index: number
  source: SignalSource
  /** A stable explanation for the ledger and the audit trail. */
  label: string
}

export interface SignalMarker extends SeriesMarker {
  /** Optional typed metadata supported by custom indicators. */
  side?: SignalSide | 'buy' | 'sell'
  signalSide?: SignalSide | 'buy' | 'sell'
  orderSide?: SignalSide | 'buy' | 'sell'
}

/**
 * Direction is metadata, not a string comparison against a strategy variable.
 *
 * Existing built-ins and the custom-indicator guide use directional marker
 * shapes (`labelUp`/`arrowUp` and their down counterparts). A custom indicator
 * may additionally return typed `side`, `signalSide`, or `orderSide` metadata.
 * Informational circles, flags and free-form text deliberately do not become
 * orders.
 */
export function markerSide(marker: SignalMarker): SignalSide | null {
  const explicit = marker.side ?? marker.signalSide ?? marker.orderSide
  if (explicit === 'BUY' || explicit === 'buy') return 'BUY'
  if (explicit === 'SELL' || explicit === 'sell') return 'SELL'

  switch (marker.shape) {
    case 'arrowUp':
    case 'triangleUp':
    case 'labelUp':
      return 'BUY'
    case 'arrowDown':
    case 'triangleDown':
    case 'labelDown':
      return 'SELL'
    default:
      return null
  }
}

function finiteTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Read the marker output from one live indicator instance.
 *
 * `IndicatorApi.values()` flushes the chart engine's deferred calculation, so
 * this observes exactly the values used by the marker renderer. The descriptor
 * itself is the source of truth for both paths.
 */
export function signalsFromMarkers(input: {
  descriptor: IndicatorDescriptor
  instance: IndicatorApi
  bars: readonly Bar[]
}): IndicatorSignal[] {
  const { descriptor, instance, bars } = input
  if (!descriptor.markers || !instance.visible() || bars.length === 0) return []

  const values = instance.values() as IndicatorValues
  const markers = descriptor.markers({
    bars,
    values,
    settings: instance.settings(),
  }) as readonly SignalMarker[]
  const byTime = new Map<number, number>()
  for (let i = 0; i < bars.length; i++) byTime.set(bars[i].time, i)

  const out: IndicatorSignal[] = []
  for (const marker of markers ?? []) {
    if (!marker || !finiteTime(marker.time)) continue
    const side = markerSide(marker)
    if (!side) continue
    const index = byTime.get(marker.time)
    if (index === undefined) continue
    out.push({
      indicatorId: instance.indicatorId,
      instanceId: instance.id,
      side,
      time: marker.time,
      index,
      source: 'marker',
      label: marker.text?.trim() || `${instance.name} ${side}`,
    })
  }
  return out
}

/** A signal identity independent of chart recalculation and instance ids. */
export function signalKey(input: {
  symbol: string
  exchange: string
  interval: string
  indicatorId: string
  settings: unknown
  side: SignalSide
  time: number
}): string {
  return [
    input.exchange,
    input.symbol,
    input.interval,
    input.indicatorId,
    stableJson(input.settings),
    input.time,
    input.side,
  ].join('|')
}

/** JSON with object keys sorted, so equivalent settings have one identity. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? String(value)
}

export type LedgerStatus = 'claimed' | 'paper' | 'sent' | 'rejected' | 'skipped'

interface LedgerEntry {
  status: LedgerStatus
  at: number
  orderId?: string
}

const LEDGER_KEY = 'oa-trading-signal-ledger-v1'
const MAX_ENTRIES = 2500

/**
 * Small persistent idempotency ledger. A claim is written before the network
 * call. That is intentionally conservative: a tab crash after a request left
 * the browser must not replay the same signal into a second live order on
 * reload. The normal success/rejection status is written afterwards for audit.
 */
export class SignalLedger {
  private readonly entries = new Map<string, LedgerEntry>()
  private readonly storage: Storage | null

  constructor(storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage) {
    this.storage = storage
    this.read()
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  claim(key: string, at = Date.now()): boolean {
    if (this.entries.has(key)) return false
    this.entries.set(key, { status: 'claimed', at })
    this.persist()
    return true
  }

  /** Seed historical markers without treating them as an executable signal. */
  seed(key: string, at = Date.now()): void {
    if (this.entries.has(key)) return
    this.entries.set(key, { status: 'skipped', at })
    this.persist()
  }

  complete(key: string, status: LedgerStatus, orderId?: string, at = Date.now()): void {
    if (!this.entries.has(key)) return
    this.entries.set(key, { status, at, ...(orderId ? { orderId } : {}) })
    this.persist()
  }

  status(key: string): LedgerStatus | undefined {
    return this.entries.get(key)?.status
  }

  size(): number {
    return this.entries.size
  }

  private read(): void {
    if (!this.storage) return
    try {
      const raw = this.storage.getItem(LEDGER_KEY)
      const parsed = raw ? JSON.parse(raw) : null
      if (!Array.isArray(parsed)) return
      for (const row of parsed) {
        if (
          row &&
          typeof row.key === 'string' &&
          row.entry &&
          typeof row.entry.at === 'number' &&
          typeof row.entry.status === 'string'
        ) {
          this.entries.set(row.key, row.entry as LedgerEntry)
        }
      }
    } catch {
      // Private browsing and malformed old storage must not stop a chart loading.
    }
  }

  private persist(): void {
    if (!this.storage) return
    try {
      const rows = [...this.entries.entries()]
        .sort((a, b) => a[1].at - b[1].at)
        .slice(-MAX_ENTRIES)
        .map(([key, entry]) => ({ key, entry }))
      this.storage.setItem(LEDGER_KEY, JSON.stringify(rows))
    } catch {
      // The in-memory ledger still protects this tab when storage is unavailable.
    }
  }
}

/**
 * Convert an optional typed alert payload. Generic alerts intentionally do not
 * trade: the package alert contract has no side field, and treating an alert
 * title/id as a side would recreate the unsafe string-condition coupling this
 * bridge is designed to avoid. Signal indicators should expose BUY/SELL marker
 * shapes (or typed marker metadata) for a chart-and-trading signal.
 */
export function signalFromAlert(payload: unknown): IndicatorSignal | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Partial<IndicatorSignal> & { side?: unknown; signalSide?: unknown }
  const raw = p.side ?? p.signalSide
  const side =
    raw === 'BUY' || raw === 'buy' ? 'BUY' : raw === 'SELL' || raw === 'sell' ? 'SELL' : null
  if (
    !side ||
    typeof p.indicatorId !== 'string' ||
    typeof p.instanceId !== 'string' ||
    !finiteTime(p.time)
  )
    return null
  return {
    indicatorId: p.indicatorId,
    instanceId: p.instanceId,
    side,
    time: p.time,
    index: typeof p.index === 'number' ? p.index : -1,
    source: 'alert',
    label: typeof p.label === 'string' ? p.label : `${p.indicatorId} ${side}`,
  }
}
