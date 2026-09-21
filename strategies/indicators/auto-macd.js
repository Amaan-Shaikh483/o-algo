/**
 * Auto-Trade MACD
 * MACD crosses above/below signal line -> Buy/Sell
 *
 * This indicator wraps the built-in MACD and adds auto-trading capability.
 * When Auto Trade is enabled in settings, new confirmed crossovers will
 * automatically place orders via SignalBridge.
 */

export default async function (api) {
  const { registerIndicator, getIndicator } = api

  // Try to get the built-in MACD descriptor
  let base = null
  try {
    base = getIndicator('macd')
  } catch (e) {
    // Fallback: define minimal MACD ourselves if built-in not available yet
  }

  // Import our wrapper utility
  let withAutoTradeFn
  try {
    const mod = await import('./autoTradeIndicator.js')
    withAutoTradeFn = mod.withAutoTrade || mod.default?.withAutoTrade || mod.default
    // If default export is a function returning { withAutoTrade }, handle it
    if (typeof withAutoTradeFn === 'function' && withAutoTradeFn.length === 1) {
      // Check if it's the factory that needs api
      const maybe = withAutoTradeFn(api)
      if (maybe && maybe.withAutoTrade) {
        withAutoTradeFn = maybe.withAutoTrade
      }
    }
  } catch (e) {
    // Fallback: define wrapper inline if import fails
    withAutoTradeFn = null
  }

  // Fallback inline wrapper if import failed
  if (!withAutoTradeFn) {
    withAutoTradeFn = function (desc, opts) {
      const src = opts.signalSource || 'macd'
      const ref = opts.signalRef || 'signal'
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
            id: 'buy-macd-cross',
            title: 'MACD crossed above Signal — Buy',
            when: ({ values, settings, index }) => {
              if (!settings.__autoTradeEnabled) return false
              if (index < 1) return false
              const macd = values[src], sig = values[ref]
              if (!macd || !sig) return false
              const pm = macd[index - 1], cm = macd[index], ps = sig[index - 1], cs = sig[index]
              if (pm == null || cm == null || ps == null || cs == null) return false
              return pm <= ps && cm > cs
            },
          },
          {
            id: 'sell-macd-cross',
            title: 'MACD crossed below Signal — Sell',
            when: ({ values, settings, index }) => {
              if (!settings.__autoTradeEnabled) return false
              if (index < 1) return false
              const macd = values[src], sig = values[ref]
              if (!macd || !sig) return false
              const pm = macd[index - 1], cm = macd[index], ps = sig[index - 1], cs = sig[index]
              if (pm == null || cm == null || ps == null || cs == null) return false
              return pm >= ps && cm < cs
            },
          },
        ],
      }
    }
  }

  if (base) {
    // Wrap built-in MACD
    const wrapped = withAutoTradeFn(
      {
        ...base,
        id: 'auto-macd',
        name: 'Auto-Trade MACD',
      },
      {
        signalSource: 'macd',
        signalRef: 'signal',
      }
    )
    registerIndicator(wrapped)
  } else {
    // Fallback: create MACD from scratch using api's smaSeededEma etc.
    const { sourceValues, smaSeededEma, nulls } = api
    registerIndicator(
      withAutoTradeFn(
        {
          id: 'auto-macd',
          name: 'Auto-Trade MACD',
          category: 'Custom',
          placement: 'pane',
          inputs: [
            { key: 'fastPeriod', type: 'number', label: 'Fast', default: 12, min: 1 },
            { key: 'slowPeriod', type: 'number', label: 'Slow', default: 26, min: 1 },
            { key: 'signalPeriod', type: 'number', label: 'Signal', default: 9, min: 1 },
            { key: 'source', type: 'source', label: 'Source', default: 'close' },
          ],
          plots: [
            { key: 'macd', type: 'line', title: 'MACD', style: { color: '#2962ff', lineWidth: 1.5 } },
            { key: 'signal', type: 'line', title: 'Signal', style: { color: '#ff6d00', lineWidth: 1.5 } },
            { key: 'histogram', type: 'histogram', title: 'Histogram', style: { color: '#26a69a', base: 0 } },
          ],
          calc: (bars, settings) => {
            const src = sourceValues(bars, settings.source || 'close')
            const fast = smaSeededEma(src, Number(settings.fastPeriod) || 12)
            const slow = smaSeededEma(src, Number(settings.slowPeriod) || 26)
            const macd = fast.map((f, i) => f - slow[i])
            const signal = smaSeededEma(macd, Number(settings.signalPeriod) || 9)
            const hist = macd.map((m, i) => m - signal[i])
            return {
              macd: nulls(macd),
              signal: nulls(signal),
              histogram: nulls(hist),
            }
          },
          levels: () => [{ price: 0, color: '#5a6b8c', dashed: true }],
        },
        { signalSource: 'macd', signalRef: 'signal' }
      )
    )
  }
}
