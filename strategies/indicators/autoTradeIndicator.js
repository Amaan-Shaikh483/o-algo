/**
 * Auto-Trade wrapper for custom indicators.
 *
 * Provides `withAutoTrade(descriptor, options)` which adds:
 *  - Auto-trade inputs (__autoTradeEnabled, __autoTradeQty, __autoTradeProduct, __autoTradePriceType)
 *  - Alerts with ids `buy-*` and `sell-*` that the SignalBridge listens to
 *  - Optional Buy/Sell markers for visual feedback
 *
 * Usage:
 *   import { withAutoTrade } from './autoTradeIndicator.js'  // dynamically imported by other indicators
 *   // or directly use the function exported by this module via api
 *
 *   registerIndicator(withAutoTrade(baseDescriptor, {
 *     signalSource: 'macd',      // primary line that crosses
 *     signalRef: 'signal',       // reference line
 *   }))
 *
 * For Supertrend-style indicators (up/down plots):
 *   registerIndicator(withAutoTrade(baseDescriptor, {
 *     mode: 'supertrend'  // detects up/down flip
 *   }))
 *
 * For ORB-style (level breakout):
 *   registerIndicator(withAutoTrade(baseDescriptor, {
 *     mode: 'orb',
 *     levelHigh: 'orbHigh',
 *     levelLow: 'orbLow'
 *   }))
 *
 * The wrapper is intentionally self-contained and does not depend on any
 * external module beyond what openalgo-charts provides.
 */

const AUTO_TRADE_INPUTS = [
  {
    key: '__autoTradeEnabled',
    type: 'boolean',
    label: 'Auto Trade',
    default: false,
    group: 'Auto Trade',
    tooltip: 'Execute orders on new signals from this indicator. Only confirmed (closed candle) signals are traded.',
  },
  {
    key: '__autoTradeQty',
    type: 'number',
    label: 'AT Quantity',
    default: 1,
    min: 1,
    max: 10000,
    step: 1,
    group: 'Auto Trade',
    tooltip: 'Order quantity. Lots for derivatives, units for equity.',
  },
  {
    key: '__autoTradeProduct',
    type: 'select',
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
    key: '__autoTradePriceType',
    type: 'select',
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

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * Wrap a descriptor with auto-trade capability.
 *
 * @param {object} descriptor - Base indicator descriptor
 * @param {object} options - Configuration
 * @param {string} [options.signalSource] - Primary plot key (e.g. 'macd', 'short', 'fast')
 * @param {string} [options.signalRef] - Reference plot key (e.g. 'signal', 'long', 'slow')
 * @param {string} [options.mode] - Special modes: 'supertrend', 'orb'
 * @param {string} [options.levelHigh] - For orb mode, high level key
 * @param {string} [options.levelLow] - For orb mode, low level key
 * @returns {object} New descriptor with auto-trade inputs, alerts, and markers
 */
function withAutoTrade(descriptor, options = {}) {
  const mode = options.mode || 'crossover'
  const signalSource = options.signalSource
  const signalRef = options.signalRef
  const levelHigh = options.levelHigh || 'orbHigh'
  const levelLow = options.levelLow || 'orbLow'

  // Clone descriptor shallowly, deep clone inputs/plots that we modify
  const newDescriptor = {
    ...descriptor,
    inputs: [...(descriptor.inputs || []), ...AUTO_TRADE_INPUTS],
  }

  // Preserve existing alerts and add ours
  const existingAlerts = descriptor.alerts ? [...descriptor.alerts] : []

  // Helper to check auto-trade enabled
  const enabledCheck = (settings) => settings && settings.__autoTradeEnabled === true

  let buyAlert, sellAlert

  if (mode === 'supertrend') {
    // Supertrend: up/down flip detection
    buyAlert = {
      id: 'buy-supertrend-flip',
      title: 'Supertrend Buy (Uptrend)',
      message: 'Supertrend flipped to uptrend — Buy signal',
      when: ({ values, settings, index }) => {
        if (!enabledCheck(settings)) return false
        if (index < 1) return false
        const up = values.up
        const down = values.down
        if (!up || !down) return false
        const curUp = up[index]
        const prevUp = up[index - 1]
        // Flip to uptrend: current up is not null, previous up was null
        // Also handle case where previous down was not null
        if (curUp == null) return false
        if (prevUp != null) return false // already in uptrend
        return true
      },
    }
    sellAlert = {
      id: 'sell-supertrend-flip',
      title: 'Supertrend Sell (Downtrend)',
      message: 'Supertrend flipped to downtrend — Sell signal',
      when: ({ values, settings, index }) => {
        if (!enabledCheck(settings)) return false
        if (index < 1) return false
        const up = values.up
        const down = values.down
        if (!up || !down) return false
        const curDown = down[index]
        const prevDown = down[index - 1]
        if (curDown == null) return false
        if (prevDown != null) return false // already in downtrend
        return true
      },
    }
  } else if (mode === 'orb') {
    // Open Range Breakout style: price crossing levels
    buyAlert = {
      id: 'buy-orb-breakout',
      title: 'ORB Buy Breakout',
      message: 'Price broke above ORB High — Buy signal',
      when: ({ bars, values, settings, index }) => {
        if (!enabledCheck(settings)) return false
        if (index < 1) return false
        const hi = values[levelHigh]
        if (!hi) return false
        const prevHighLevel = hi[index - 1]
        const curHighLevel = hi[index]
        if (prevHighLevel == null || curHighLevel == null) return false
        const prevBar = bars[index - 1]
        const curBar = bars[index]
        if (!prevBar || !curBar) return false
        // Crossover: previous high <= previous level, current high > current level
        return prevBar.high <= prevHighLevel && curBar.high > curHighLevel
      },
    }
    sellAlert = {
      id: 'sell-orb-breakdown',
      title: 'ORB Sell Breakdown',
      message: 'Price broke below ORB Low — Sell signal',
      when: ({ bars, values, settings, index }) => {
        if (!enabledCheck(settings)) return false
        if (index < 1) return false
        const lo = values[levelLow]
        if (!lo) return false
        const prevLowLevel = lo[index - 1]
        const curLowLevel = lo[index]
        if (prevLowLevel == null || curLowLevel == null) return false
        const prevBar = bars[index - 1]
        const curBar = bars[index]
        if (!prevBar || !curBar) return false
        return prevBar.low >= prevLowLevel && curBar.low < curLowLevel
      },
    }
  } else {
    // Default: crossover mode (MACD, EMA cross, etc.)
    // Requires signalSource and signalRef
    const srcKey = signalSource
    const refKey = signalRef

    if (!srcKey || !refKey) {
      // If keys not provided, try to auto-detect common patterns
      // This fallback makes the wrapper usable even without explicit keys
      buyAlert = {
        id: 'buy-crossover',
        title: 'Bullish Crossover',
        message: 'Bullish crossover — Buy signal',
        when: ({ values, settings, index }) => {
          if (!enabledCheck(settings)) return false
          if (index < 1) return false
          // Try common pairs
          const pairs = [
            ['macd', 'signal'],
            ['short', 'long'],
            ['fast', 'slow'],
            ['fastEMA', 'slowEMA'],
            ['emaFast', 'emaSlow'],
            ['line1', 'line2'],
          ]
          for (const [s, r] of pairs) {
            const src = values[s]
            const ref = values[r]
            if (!src || !ref) continue
            const ps = src[index - 1], cs = src[index]
            const pr = ref[index - 1], cr = ref[index]
            if (ps == null || cs == null || pr == null || cr == null) continue
            if (ps <= pr && cs > cr) return true
          }
          // Generic: check if any two numeric columns cross
          const keys = Object.keys(values)
          if (keys.length >= 2) {
            const src = values[keys[0]]
            const ref = values[keys[1]]
            if (src && ref && index >= 1) {
              const ps = src[index - 1], cs = src[index]
              const pr = ref[index - 1], cr = ref[index]
              if (ps != null && cs != null && pr != null && cr != null) {
                if (ps <= pr && cs > cr) return true
              }
            }
          }
          return false
        },
      }
      sellAlert = {
        id: 'sell-crossover',
        title: 'Bearish Crossover',
        message: 'Bearish crossover — Sell signal',
        when: ({ values, settings, index }) => {
          if (!enabledCheck(settings)) return false
          if (index < 1) return false
          const pairs = [
            ['macd', 'signal'],
            ['short', 'long'],
            ['fast', 'slow'],
            ['fastEMA', 'slowEMA'],
            ['emaFast', 'emaSlow'],
            ['line1', 'line2'],
          ]
          for (const [s, r] of pairs) {
            const src = values[s]
            const ref = values[r]
            if (!src || !ref) continue
            const ps = src[index - 1], cs = src[index]
            const pr = ref[index - 1], cr = ref[index]
            if (ps == null || cs == null || pr == null || cr == null) continue
            if (ps >= pr && cs < cr) return true
          }
          const keys = Object.keys(values)
          if (keys.length >= 2) {
            const src = values[keys[0]]
            const ref = values[keys[1]]
            if (src && ref && index >= 1) {
              const ps = src[index - 1], cs = src[index]
              const pr = ref[index - 1], cr = ref[index]
              if (ps != null && cs != null && pr != null && cr != null) {
                if (ps >= pr && cs < cr) return true
              }
            }
          }
          return false
        },
      }
    } else {
      buyAlert = {
        id: `buy-${srcKey}-${refKey}-cross`,
        title: `${srcKey} crossed above ${refKey} — Buy`,
        message: `${srcKey} crossed above ${refKey} — Buy signal`,
        when: ({ values, settings, index }) => {
          if (!enabledCheck(settings)) return false
          if (index < 1) return false
          const src = values[srcKey]
          const ref = values[refKey]
          if (!src || !ref) return false
          const prevSrc = src[index - 1]
          const curSrc = src[index]
          const prevRef = ref[index - 1]
          const curRef = ref[index]
          if (prevSrc == null || curSrc == null || prevRef == null || curRef == null) return false
          // Cross above
          return prevSrc <= prevRef && curSrc > curRef
        },
      }
      sellAlert = {
        id: `sell-${srcKey}-${refKey}-cross`,
        title: `${srcKey} crossed below ${refKey} — Sell`,
        message: `${srcKey} crossed below ${refKey} — Sell signal`,
        when: ({ values, settings, index }) => {
          if (!enabledCheck(settings)) return false
          if (index < 1) return false
          const src = values[srcKey]
          const ref = values[refKey]
          if (!src || !ref) return false
          const prevSrc = src[index - 1]
          const curSrc = src[index]
          const prevRef = ref[index - 1]
          const curRef = ref[index]
          if (prevSrc == null || curSrc == null || prevRef == null || curRef == null) return false
          // Cross below
          return prevSrc >= prevRef && curSrc < curRef
        },
      }
    }
  }

  newDescriptor.alerts = [...existingAlerts, buyAlert, sellAlert]

  // Preserve existing markers, but also ensure Buy/Sell markers are shown if not already
  // We will wrap the existing markers function to also emit auto-trade markers when enabled
  const originalMarkers = descriptor.markers
  if (typeof originalMarkers === 'function') {
    // Keep original markers as is — they already show Buy/Sell for ORB etc.
    // Auto-trade alerts are separate from markers; markers are visual, alerts are trading
    newDescriptor.markers = originalMarkers
  } else if (mode !== 'supertrend' && signalSource && signalRef) {
    // For crossover indicators without markers, add Buy/Sell markers
    newDescriptor.markers = function ({ bars, values }) {
      const out = []
      const src = values[signalSource]
      const ref = values[signalRef]
      if (!src || !ref) return out
      // Compute padding similar to ORB example
      let sum = 0, count = 0
      for (const bar of bars) {
        const range = bar.high - bar.low
        if (Number.isFinite(range) && range > 0) {
          sum += range
          count++
        }
      }
      const mean = count > 0 ? sum / count : 0
      const last = bars.length > 0 ? Math.abs(bars[bars.length - 1].close) : 0
      const pad = Math.max(mean * 0.5, last * 0.0005)

      for (let i = 1; i < bars.length; i++) {
        const ps = src[i - 1], cs = src[i]
        const pr = ref[i - 1], cr = ref[i]
        if (ps == null || cs == null || pr == null || cr == null) continue
        if (ps <= pr && cs > cr) {
          const bar = bars[i]
          out.push({
            time: bar.time,
            position: 'atPrice',
            price: bar.low - pad,
            shape: 'labelUp',
            size: 'small',
            color: '#4caf50',
            text: 'Buy',
          })
        } else if (ps >= pr && cs < cr) {
          const bar = bars[i]
          out.push({
            time: bar.time,
            position: 'atPrice',
            price: bar.high + pad,
            shape: 'labelDown',
            size: 'small',
            color: '#ff5252',
            text: 'Sell',
          })
        }
      }
      return out
    }
  }

  return newDescriptor
}

// For direct import in custom indicator files AND for loader compatibility
// When loaded by the custom indicator loader (strategies/indicators/*.js),
// the loader calls default export with api and expects registerIndicator to be called.
// This file is primarily a utility, so we register a hidden placeholder indicator
// to satisfy the loader, while also exposing withAutoTrade for other indicators
// that dynamically import this file.

export default function (api) {
  const { registerIndicator, sourceValues, sma, nulls } = api || {}

  // If called by the chart's custom loader (has registerIndicator), register a
  // minimal placeholder so the loader doesn't error. This placeholder is not
  // meant to be used directly; the real auto-trade indicators are auto-macd, etc.
  if (typeof registerIndicator === 'function') {
    try {
      registerIndicator({
        id: '_auto-trade-wrapper',
        name: 'Auto-Trade Wrapper (Utility)',
        category: 'Custom',
        placement: 'pane',
        inputs: [],
        plots: [
          { key: 'line', type: 'line', title: 'Wrapper', style: { color: '#888', lineWidth: 1, visible: false } },
        ],
        calc: (bars) => {
          // Return empty/null column — this indicator does nothing visually
          const empty = new Array(bars.length).fill(null)
          return { line: empty }
        },
      })
    } catch (e) {
      // If registration fails, ignore — utility functions are still exported
    }
  }

  return { withAutoTrade, AUTO_TRADE_INPUTS }
}

// Named exports for ESM dynamic imports (auto-macd.js etc use this)
export { withAutoTrade, AUTO_TRADE_INPUTS }
