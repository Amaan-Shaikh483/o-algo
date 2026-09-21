/**
 * Auto-Trade Supertrend
 * Supertrend flips up/down -> Buy/Sell
 *
 * Wraps built-in Supertrend with auto-trading.
 */

export default async function (api) {
  const { registerIndicator, getIndicator } = api

  let base = null
  try {
    base = getIndicator('supertrend')
  } catch (e) {}

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
            id: 'buy-supertrend-flip',
            title: 'Supertrend Buy',
            when: ({ values, settings, index }) => {
              if (!settings.__autoTradeEnabled) return false
              if (index < 1) return false
              const up = values.up, down = values.down
              if (!up || !down) return false
              return up[index] != null && up[index - 1] == null
            },
          },
          {
            id: 'sell-supertrend-flip',
            title: 'Supertrend Sell',
            when: ({ values, settings, index }) => {
              if (!settings.__autoTradeEnabled) return false
              if (index < 1) return false
              const up = values.up, down = values.down
              if (!up || !down) return false
              return down[index] != null && down[index - 1] == null
            },
          },
        ],
      }
    }
  }

  if (base) {
    // Remove fills that reference hidden columns like bodyMid, or add hidden plot for them
    // For validation, we ensure all fill keys exist as plots. Supertrend's bodyMid is a hidden
    // helper column, not a plot, so we add it as invisible plot and keep fills.
    const plotsWithBodyMid = [...base.plots]
    const hasBodyMid = plotsWithBodyMid.some((p) => p.key === 'bodyMid')
    if (!hasBodyMid) {
      plotsWithBodyMid.push({
        key: 'bodyMid',
        type: 'line',
        title: 'Body Mid (hidden)',
        style: { visible: false },
      })
    }
    const wrapped = withAutoTradeFn(
      {
        ...base,
        plots: plotsWithBodyMid,
        id: 'auto-supertrend',
        name: 'Auto-Trade Supertrend',
      },
      { mode: 'supertrend' }
    )
    registerIndicator(wrapped)
  } else {
    // Fallback: define supertrend ourselves
    const { supertrend } = api
    registerIndicator(
      withAutoTradeFn(
        {
          id: 'auto-supertrend',
          name: 'Auto-Trade Supertrend',
          category: 'Custom',
          placement: 'onchart',
          inputs: [
            { key: 'period', type: 'number', label: 'ATR Period', default: 10, min: 1 },
            { key: 'multiplier', type: 'number', label: 'Multiplier', default: 3, min: 0.1 },
          ],
          plots: [
            { key: 'up', type: 'line', title: 'Up', style: { color: '#26a69a', lineWidth: 2 } },
            { key: 'down', type: 'line', title: 'Down', style: { color: '#ef5350', lineWidth: 2 } },
          ],
          calc: (bars, settings) => {
            const st = supertrend(bars, Number(settings.period) || 10, Number(settings.multiplier) || 3)
            const up = [], down = []
            for (let i = 0; i < st.length; i++) {
              const p = st[i]
              const live = Number.isFinite(p.value)
              up.push(live && p.direction === -1 ? p.value : null)
              down.push(live && p.direction === 1 ? p.value : null)
            }
            return { up, down }
          },
        },
        { mode: 'supertrend' }
      )
    )
  }
}
