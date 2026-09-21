/**
 * Auto-Trade EMA Crossover
 * Fast EMA crosses above/below Slow EMA -> Buy/Sell
 */

export default async function (api) {
  const { registerIndicator, getIndicator, sourceValues, ema, nulls } = api

  let withAutoTradeFn
  try {
    const mod = await import('./autoTradeIndicator.js')
    withAutoTradeFn = mod.withAutoTrade || mod.default?.withAutoTrade || mod.default
    if (typeof withAutoTradeFn === 'function' && withAutoTradeFn.length === 1) {
      const maybe = withAutoTradeFn(api)
      if (maybe && maybe.withAutoTrade) withAutoTradeFn = maybe.withAutoTrade
    }
  } catch (e) {
    withAutoTradeFn = null
  }

  if (!withAutoTradeFn) {
    withAutoTradeFn = function (desc, opts) {
      const src = opts.signalSource || 'fast'
      const ref = opts.signalRef || 'slow'
      const AUTO_TRADE_INPUTS = [
        { key: '__autoTradeEnabled', type: 'boolean', label: 'Auto Trade', default: false, group: 'Auto Trade' },
        { key: '__autoTradeQty', type: 'number', label: 'AT Quantity', default: 1, min: 1, group: 'Auto Trade' },
        { key: '__autoTradeProduct', type: 'select', label: 'AT Product', default: 'MIS', group: 'Auto Trade', options: [{ label: 'MIS', value: 'MIS' }, { label: 'NRML', value: 'NRML' }, { label: 'CNC', value: 'CNC' }] },
        { key: '__autoTradePriceType', type: 'select', label: 'AT Price Type', default: 'MARKET', group: 'Auto Trade', options: [{ label: 'Market', value: 'MARKET' }, { label: 'Limit', value: 'LIMIT' }, { label: 'SL', value: 'SL' }, { label: 'SL-M', value: 'SL-M' }] },
      ]
      return {
        ...desc,
        inputs: [...(desc.inputs || []), ...AUTO_TRADE_INPUTS],
        alerts: [
          ...(desc.alerts || []),
          {
            id: 'buy-ema-cross',
            title: 'EMA Fast crossed above Slow — Buy',
            when: ({ values, settings, index }) => {
              if (!settings.__autoTradeEnabled) return false
              if (index < 1) return false
              const f = values[src], s = values[ref]
              if (!f || !s) return false
              const pf = f[index - 1], cf = f[index], ps = s[index - 1], cs = s[index]
              if (pf == null || cf == null || ps == null || cs == null) return false
              return pf <= ps && cf > cs
            },
          },
          {
            id: 'sell-ema-cross',
            title: 'EMA Fast crossed below Slow — Sell',
            when: ({ values, settings, index }) => {
              if (!settings.__autoTradeEnabled) return false
              if (index < 1) return false
              const f = values[src], s = values[ref]
              if (!f || !s) return false
              const pf = f[index - 1], cf = f[index], ps = s[index - 1], cs = s[index]
              if (pf == null || cf == null || ps == null || cs == null) return false
              return pf >= ps && cf < cs
            },
          },
        ],
      }
    }
  }

  // Try to wrap built-in MA_CROSS or create our own EMA cross
  let base = null
  try {
    base = getIndicator('ma-cross')
  } catch (e) {}

  if (base) {
    // MA_CROSS uses SMA, but we want EMA — create custom based on it
    // We'll create our own descriptor instead of wrapping ma-cross directly
    // because ma-cross calc is SMA, not EMA
  }

  // Create EMA cross indicator with auto-trade
  const descriptor = {
    id: 'auto-ema-cross',
    name: 'Auto-Trade EMA Cross',
    category: 'Custom',
    placement: 'onchart',
    inputs: [
      { key: 'fastPeriod', type: 'number', label: 'Fast EMA', default: 9, min: 1, max: 500 },
      { key: 'slowPeriod', type: 'number', label: 'Slow EMA', default: 21, min: 1, max: 500 },
      { key: 'source', type: 'source', label: 'Source', default: 'close' },
      { key: 'fastColor', type: 'color', label: 'Fast EMA', default: '#2962ff' },
      { key: 'slowColor', type: 'color', label: 'Slow EMA', default: '#ff6d00' },
    ],
    plots: [
      { key: 'fast', type: 'line', title: 'Fast EMA', colorKey: 'fastColor', style: { lineWidth: 1.5 } },
      { key: 'slow', type: 'line', title: 'Slow EMA', colorKey: 'slowColor', style: { lineWidth: 1.5 } },
    ],
    calc: (bars, settings) => {
      const src = sourceValues(bars, settings.source || 'close')
      const fastPeriod = Math.max(1, Math.round(Number(settings.fastPeriod) || 9))
      const slowPeriod = Math.max(1, Math.round(Number(settings.slowPeriod) || 21))
      const fast = ema(src, fastPeriod)
      const slow = ema(src, slowPeriod)
      return {
        fast: nulls(fast),
        slow: nulls(slow),
      }
    },
  }

  const wrapped = withAutoTradeFn(descriptor, {
    signalSource: 'fast',
    signalRef: 'slow',
  })

  registerIndicator(wrapped)
}
