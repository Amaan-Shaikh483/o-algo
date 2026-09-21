/**
 * Signal → Deduplication → Execution bridge for auto-trading from indicators.
 *
 * Architecture:
 *   1. Chart raises `indicator:alert` when an alert's `when()` fires on the
 *      tail-only path (history loads, settings changes and symbol switches fire
 *      nothing — only new confirmed/closed-candle signals reach here).
 *   2. This bridge filters for alerts whose indicator instance has auto-trade
 *      enabled (via settings: `__autoTrade` block).
 *   3. Deduplication: same indicator + same alert + same bar time = ignored.
 *      Chart rebuilds, reloads and recalculations cannot produce duplicates
 *      because the alert system only fires on tail changes.
 *   4. Position check: if already positioned in the same direction, skip.
 *      If positioned in the opposite direction, close first (reversal).
 *   5. Execution: order placed through the OpenAlgo trade feed, which asserts
 *      the page's mode (live/analyze) against the server.
 *
 * API keys never leave the server: the trade feed uses session auth for the
 * web routes, and the apikey was already fetched server-side by the terminal.
 *
 * Usage in indicators — add these inputs to any descriptor:
 *
 *   { key: '__autoTradeEnabled', type: 'boolean', label: 'Auto Trade', default: false,
 *     group: 'Auto Trade', tooltip: 'Execute orders on new signals from this indicator' },
 *   { key: '__autoTradeQty', type: 'number', label: 'Quantity', default: 1, min: 1,
 *     group: 'Auto Trade', tooltip: 'Order quantity (lots for derivatives, units for equity)' },
 *   { key: '__autoTradeProduct', type: 'select', label: 'Product', default: 'MIS',
 *     group: 'Auto Trade', options: [
 *       { label: 'MIS (Intraday)', value: 'MIS' },
 *       { label: 'NRML (Carry)', value: 'NRML' },
 *       { label: 'CNC (Delivery)', value: 'CNC' },
 *     ] },
 *   { key: '__autoTradePriceType', type: 'select', label: 'Price Type', default: 'MARKET',
 *     group: 'Auto Trade', options: [
 *       { label: 'Market', value: 'MARKET' },
 *       { label: 'Limit', value: 'LIMIT' },
 *       { label: 'Stop Loss', value: 'SL' },
 *       { label: 'SL-Market', value: 'SL-M' },
 *     ] },
 *
 * And declare at least one alert with an id starting with 'buy-' or 'sell-':
 *
 *   alerts: [
 *     { id: 'buy-cross', title: 'Bullish crossover', when: ({ values, index }) => ... },
 *     { id: 'sell-cross', title: 'Bearish crossover', when: ({ values, index }) => ... },
 *   ]
 *
 * The bridge reads the alert id prefix to determine the side:
 *   'buy-*'  → BUY order
 *   'sell-*' → SELL order
 *
 * For indicators without alerts, use the `autoTradeIndicator.js` wrapper which
 * adds standard signal inputs and generates the alerts automatically.
 */

import type { AppMode } from '@/stores/themeStore'
import type { OrderSide, OrderType, SymbolView } from './terminal'

/** Configuration an indicator instance carries for auto-trading. */
export interface AutoTradeConfig {
  enabled: boolean
  qty: number
  product: 'MIS' | 'NRML' | 'CNC'
  priceType: OrderType
}

/** A signal the bridge processed. */
export interface SignalRecord {
  indicatorId: string
  instanceId: string
  alertId: string
  side: OrderSide
  barTime: number
  /** UTC ms when the signal was processed. */
  processedAt: number
}

/** What the bridge needs from the terminal to function. */
export interface SignalBridgeDeps {
  /** The chart instance, for subscribing to alert events. */
  chart: {
    on(event: string, cb: (payload: unknown) => void): () => void
    indicators(): Array<{
      id: string
      indicatorId: string
      name: string
      settings(): Record<string, unknown>
    }>
  }
  /** The trade feed for placing orders. */
  trade: {
    place(order: {
      symbol: string
      exchange: string
      side: OrderSide
      type: OrderType
      qty: number
      product: string
      price?: number
      triggerPrice?: number
      mode: AppMode
    }): Promise<{ orderId: string }>
  }
  /** Current symbol info. Read fresh on each signal, not captured. */
  getSymbol: () => SymbolView | null
  /** Current trading mode. Read fresh on each signal. */
  getMode: () => AppMode
  /** Current positions for the symbol. */
  getPositions: () => Promise<Array<{
    symbol: string
    exchange: string
    quantity: number
    product: string
    average_price: number
  }>>
  /** Toast notification. */
  toast: (msg: string, kind: 'ok' | 'err' | '') => void
  /** Whether replay is active (trading locked). */
  isReplayActive: () => boolean
  /** Quantity multiplier for lots-based instruments. */
  orderUnits: (qty: number, lots: boolean, lotsize: number) => number
}

/** The standard auto-trade settings keys. */
export const AT_ENABLED_KEY = '__autoTradeEnabled'
export const AT_QTY_KEY = '__autoTradeQty'
export const AT_PRODUCT_KEY = '__autoTradeProduct'
export const AT_PRICE_TYPE_KEY = '__autoTradePriceType'

/** Standard auto-trade input definitions, to spread into any descriptor's inputs. */
export const AUTO_TRADE_INPUTS = [
  {
    key: AT_ENABLED_KEY,
    type: 'boolean' as const,
    label: 'Auto Trade',
    default: false,
    group: 'Auto Trade',
    tooltip: 'Execute orders on new signals from this indicator. Only confirmed (closed candle) signals are traded.',
  },
  {
    key: AT_QTY_KEY,
    type: 'number' as const,
    label: 'AT Quantity',
    default: 1,
    min: 1,
    max: 10000,
    step: 1,
    group: 'Auto Trade',
    tooltip: 'Order quantity. Lots for derivatives, units for equity.',
  },
  {
    key: AT_PRODUCT_KEY,
    type: 'select' as const,
    label: 'AT Product',
    default: 'MIS',
    group: 'Auto Trade',
    options: [
      { label: 'MIS (Intraday)', value: 'MIS' },
      { label: 'NRML (Carry)', value: 'NRML' },
      { label: 'CNC (Delivery)', value: 'CNC' },
    ],
    tooltip: 'Product type for auto-trade orders.',
  },
  {
    key: AT_PRICE_TYPE_KEY,
    type: 'select' as const,
    label: 'AT Price Type',
    default: 'MARKET',
    group: 'Auto Trade',
    options: [
      { label: 'Market', value: 'MARKET' },
      { label: 'Limit', value: 'LIMIT' },
      { label: 'Stop Loss', value: 'SL' },
      { label: 'SL-Market', value: 'SL-M' },
    ],
    tooltip: 'Price type for auto-trade orders.',
  },
]

/**
 * Read auto-trade config from an indicator instance's settings.
 */
export function readAutoTradeConfig(settings: Record<string, unknown>): AutoTradeConfig {
  return {
    enabled: settings[AT_ENABLED_KEY] === true,
    qty: Math.max(1, Math.floor(Number(settings[AT_QTY_KEY]) || 1)),
    product: (['MIS', 'NRML', 'CNC'].includes(String(settings[AT_PRODUCT_KEY]))
      ? String(settings[AT_PRODUCT_KEY])
      : 'MIS') as 'MIS' | 'NRML' | 'CNC',
    priceType: (['MARKET', 'LIMIT', 'SL', 'SL-M'].includes(String(settings[AT_PRICE_TYPE_KEY]))
      ? String(settings[AT_PRICE_TYPE_KEY])
      : 'MARKET') as OrderType,
  }
}

/**
 * Determine order side from an alert id.
 *
 * Convention: alert ids prefixed with 'buy' → BUY, 'sell' → SELL.
 * This avoids comparing string values from `when()` predicates.
 */
export function sideFromAlertId(alertId: string): OrderSide | null {
  const lower = alertId.toLowerCase()
  if (lower.startsWith('buy')) return 'BUY'
  if (lower.startsWith('sell')) return 'SELL'
  return null
}

/**
 * Core signal bridge: listens to indicator alerts, deduplicates, checks
 * positions, and executes orders.
 *
 * Instantiated per chart pane. Destroyed when the pane tears down.
 */
export class SignalBridge {
  private readonly deps: SignalBridgeDeps
  private offAlert: (() => void) | null = null

  /**
   * Deduplication: `indicatorId:alertId:barTime` → true.
   *
   * Prevents the same signal from executing twice across:
   *   - Chart rebuilds (the alert fires once per tail change, but a rebuild
   *     re-applies indicators which can re-evaluate the last bar)
   *   - Multiple panes sharing the same indicator (each pane has its own bridge)
   *   - Rapid ticks within the same bar bucket
   *
   * The bar time is the anchor: the same indicator alert on a later bar is
   * a new signal and must execute.
   */
  private readonly seen = new Map<string, number>()

  /** Cooldown: minimum ms between orders for the same indicator. */
  private static readonly COOLDOWN_MS = 2000

  /** Max dedup entries before pruning (one per signal, pruned oldest-first). */
  private static readonly MAX_SEEN = 500

  /** In-flight order guard: one order at a time per bridge. */
  private executing = false

  constructor(deps: SignalBridgeDeps) {
    this.deps = deps
  }

  /**
   * Start listening to the chart's alert events.
   * Call once after the chart is built and indicators are applied.
   */
  attach(): void {
    this.detach()
    const { chart } = this.deps

    this.offAlert = chart.on('indicator:alert', (payload: unknown) => {
      const p = payload as {
        indicatorId?: string
        instanceId?: string
        alertId?: string
        title?: string
        message?: string
        time?: number
        index?: number
      }
      if (!p.indicatorId || !p.instanceId || !p.alertId) return
      this.handleAlert(p)
    })
  }

  /**
   * Stop listening. Called before chart rebuild or destroy.
   */
  detach(): void {
    if (this.offAlert) {
      this.offAlert()
      this.offAlert = null
    }
  }

  /**
   * Clear dedup state. Called on symbol change so signals from the previous
   * instrument do not suppress signals on the new one.
   */
  reset(): void {
    this.seen.clear()
    this.executing = false
  }

  /** Whether the bridge is currently processing an order. */
  isExecuting(): boolean {
    return this.executing
  }

  /**
   * Process one alert event from the chart.
   */
  private handleAlert(event: {
    indicatorId: string
    instanceId: string
    alertId: string
    title?: string
    time?: number
    index?: number
  }): void {
    const { indicatorId, instanceId, alertId, time } = event

    // 1. Determine side from alert id convention.
    const side = sideFromAlertId(alertId)
    if (!side) return // not a trading signal alert

    // 2. Check if this indicator instance has auto-trade enabled.
    const { chart } = this.deps
    const instance = chart.indicators().find((i) => i.id === instanceId)
    if (!instance) return

    const config = readAutoTradeConfig(instance.settings())
    if (!config.enabled) return

    // 3. Guard: replay active (trading locked).
    if (this.deps.isReplayActive()) return

    // 4. Deduplication: same indicator + alert + bar time.
    const barTime = time ?? 0
    const dedupeKey = `${indicatorId}:${alertId}:${barTime}`
    const lastSeen = this.seen.get(dedupeKey)
    if (lastSeen !== undefined) return

    // Cooldown: same indicator + same side, within cooldown window.
    // Previously this was per-indicator only, which blocked a SELL reversal
    // that arrived within 2s of a BUY (or vice versa). Sell symbol would appear
    // on chart (marker) but no API call / order — exactly the bug reported.
    // Now cooldown is per side, so BUY doesn't block SELL and reversal works.
    const now = Date.now()
    const cooldownKey = `cd:${indicatorId}:${side}`
    const lastCooldown = this.seen.get(cooldownKey)
    if (lastCooldown !== undefined && now - lastCooldown < SignalBridge.COOLDOWN_MS) return

    // 5. Record the signal.
    this.seen.set(dedupeKey, now)
    this.seen.set(cooldownKey, now)
    this.pruneSeen()

    // 6. Execute (async, but serialised through the executing guard).
    void this.executeSignal({
      indicatorId,
      instanceId,
      alertId,
      side,
      barTime,
      processedAt: now,
      config,
      indicatorName: instance.name,
    })
  }

  /**
   * Execute a validated, deduplicated signal.
   *
   * Position check → reversal → order placement → verification.
   */
  private async executeSignal(signal: {
    indicatorId: string
    instanceId: string
    alertId: string
    side: OrderSide
    barTime: number
    processedAt: number
    config: AutoTradeConfig
    indicatorName: string
  }): Promise<void> {
    // Serialise: one order at a time per bridge.
    if (this.executing) {
      this.deps.toast(`Auto-trade: order in progress, skipping ${signal.side} signal`, '')
      return
    }

    const sym = this.deps.getSymbol()
    if (!sym) {
      this.deps.toast('Auto-trade: no symbol loaded, skipping signal', 'err')
      return
    }
    if (sym.synthetic) {
      this.deps.toast(`Auto-trade: ${sym.symbol} is a computed chart, not an instrument — skipping`, 'err')
      return
    }
    if (sym.quoteOnly) {
      this.deps.toast(`Auto-trade: ${sym.exchange} is quote-only — trading not supported`, 'err')
      return
    }

    this.executing = true
    try {
      const { side, config, indicatorName } = signal
      const qty = this.deps.orderUnits(config.qty, sym.lots, sym.lotsize)
      const mode = this.deps.getMode()

      // Freeze qty check.
      if (sym.freezeQty > 1 && qty > sym.freezeQty) {
        this.deps.toast(
          `Auto-trade: qty ${qty} exceeds freeze limit ${sym.freezeQty} — adjust ${indicatorName} settings`,
          'err'
        )
        return
      }

      // Position check and reversal.
      let positionQty = 0
      let positionProduct = ''
      try {
        const positions = await this.deps.getPositions()
        const pos = positions.find(
          (p) => p.symbol === sym.symbol && p.exchange === sym.exchange && Number(p.quantity) !== 0
        )
        if (pos) {
          positionQty = Number(pos.quantity)
          positionProduct = String(pos.product ?? '')
        }
      } catch {
        /* transient — proceed without position info */
      }

      // Same direction: already positioned, skip.
      if (side === 'BUY' && positionQty > 0) {
        this.deps.toast(`Auto-trade: already long ${Math.abs(positionQty)} ${sym.symbol}, skipping BUY`, '')
        return
      }
      if (side === 'SELL' && positionQty < 0) {
        this.deps.toast(`Auto-trade: already short ${Math.abs(positionQty)} ${sym.symbol}, skipping SELL`, '')
        return
      }

      // Opposite direction: close first (reversal).
      if (side === 'BUY' && positionQty < 0) {
        try {
          await this.deps.trade.place({
            symbol: sym.symbol,
            exchange: sym.exchange,
            side: 'BUY',
            type: 'MARKET',
            qty: Math.abs(positionQty),
            product: (positionProduct || config.product) as 'CNC' | 'NRML' | 'MIS',
            mode,
          })
          this.deps.toast(`Auto-trade: closed short ${Math.abs(positionQty)} ${sym.symbol} (reversal)`, 'ok')
        } catch (e) {
          this.deps.toast(`Auto-trade: failed to close short — ${cleanError(e)}`, 'err')
          return
        }
      } else if (side === 'SELL' && positionQty > 0) {
        try {
          await this.deps.trade.place({
            symbol: sym.symbol,
            exchange: sym.exchange,
            side: 'SELL',
            type: 'MARKET',
            qty: Math.abs(positionQty),
            product: (positionProduct || config.product) as 'CNC' | 'NRML' | 'MIS',
            mode,
          })
          this.deps.toast(`Auto-trade: closed long ${Math.abs(positionQty)} ${sym.symbol} (reversal)`, 'ok')
        } catch (e) {
          this.deps.toast(`Auto-trade: failed to close long — ${cleanError(e)}`, 'err')
          return
        }
      }

      // Place the new order.
      const lotTxt = sym.lots ? `${config.qty}L (${qty})` : String(qty)
      const summary = `${side} ${config.priceType} ${lotTxt} ${sym.symbol} · ${config.product}`

      try {
        const result = await this.deps.trade.place({
          symbol: sym.symbol,
          exchange: sym.exchange,
          side,
          type: config.priceType,
          qty,
          product: config.product,
          mode,
        })

        // Verify the response.
        if (!result.orderId) {
          this.deps.toast(`Auto-trade: order placed but no id returned — check order book`, '')
          return
        }

        const modeLabel = mode === 'live' ? '' : ' [PAPER]'
        this.deps.toast(
          `Auto-trade: ${summary} (id ${result.orderId}) via ${indicatorName}${modeLabel}`,
          'ok'
        )
      } catch (e) {
        this.deps.toast(`Auto-trade: ${side} failed — ${cleanError(e)}`, 'err')
      }
    } finally {
      this.executing = false
    }
  }

  /**
   * Prune the dedup map when it grows beyond the limit.
   * Oldest entries first.
   */
  private pruneSeen(): void {
    if (this.seen.size <= SignalBridge.MAX_SEEN) return
    // Sort by value (timestamp) and keep the newest half.
    const entries = [...this.seen.entries()].sort((a, b) => b[1] - a[1])
    this.seen.clear()
    for (const [key, val] of entries.slice(0, Math.floor(SignalBridge.MAX_SEEN / 2))) {
      this.seen.set(key, val)
    }
  }
}

/** Strip technical prefixes from error messages. */
function cleanError(e: unknown): string {
  let m = String((e as Error)?.message || e || 'request failed')
  m = m
    .replace(/^openalgo-charts:\s*/i, '')
    .replace(/^\/api\/v1\/[\w/]+\s+failed\s+\(\d+\)(:\s*)?/i, '')
  return m.trim() || 'request failed'
}
