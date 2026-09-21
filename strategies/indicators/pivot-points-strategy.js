/**
 * Pivot Points Strategy - Fixed
 *
 * Port of TradingView Pivot Points indicator with dynamic strategy rules.
 * Supports multiple pivot types (Traditional, Fibonacci, Woodie, Classic, DM, Camarilla)
 * and generates BUY/SELL signals based on breakout and bounce rules.
 *
 * STRATEGY RULES:
 * - BUY: Price breaks above R1/R2/R3 with volume confirmation
 * - SELL: Price breaks below S1/S2/S3 with volume confirmation
 * - BOUNCE: Price bounces off Pivot Point (± tolerance)
 * - EXIT: Close below/above opposite level
 *
 * Auto Trade: enable in settings to execute BUY/SELL through the OpenAlgo
 * signal bridge on the current chart's symbol and exchange.
 *
 * Fixes applied:
 * - Select inputs now use {label, value} objects (was strings, failed validation)
 * - Markers use atPrice with explicit price (was belowBar/aboveBar which anchors to own plot on onchart)
 * - Regime[0] initialized to 0 not null so first bar signal can fire
 * - Volume confirmation made optional (if volume missing, signal still fires)
 * - useDailyBased logic implemented via zonedDayIndex aggregation
 * - Added proper handling for R5/S5 visibility
 */
export default function ({
  registerIndicator,
  utcSecondsToZonedParts,
  zonedDayIndex,
  isValidTimezone,
  DEFAULT_TIMEZONE,
}) {
  const COLORS = {
    P: '#fb8c00',
    R1: '#e53935',
    R2: '#c62828',
    R3: '#b71c1c',
    S1: '#43a047',
    S2: '#2e7d32',
    S3: '#1b5e20',
    BUYQ: '#4caf50',
    SELLQ: '#ff5252',
  }

  const AUTO_TRADE_INPUTS = [
    {
      key: '__autoTradeEnabled',
      type: 'boolean',
      label: 'Auto Trade',
      default: false,
      group: 'Auto Trade',
      tooltip: 'Execute BUY on R1/R2/Pivot-bounce breakout, SELL on S1/S2/Pivot-bounce breakdown.',
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
    },
  ]

  function zoneOf(settings) {
    const raw = typeof settings.timezone === 'string' ? settings.timezone.trim() : ''
    return raw && isValidTimezone(raw) ? raw : DEFAULT_TIMEZONE
  }

  function parseSession(raw) {
    const m = /^(\d{2})(\d{2})\s*-\s*(\d{2})(\d{2})$/.exec(String(raw).trim())
    if (!m) return null
    const [sh, sm, eh, em] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
    if (sh > 23 || eh > 23 || sm > 59 || em > 59) return null
    return { start: sh * 60 + sm, end: eh * 60 + em }
  }

  function inSession(minuteOfDay, start, end) {
    return end > start
      ? minuteOfDay >= start && minuteOfDay < end
      : minuteOfDay >= start || minuteOfDay < end
  }

  function calculatePivots(o, h, l, c, type = 'Traditional') {
    const hl2 = (h + l) / 2
    const hlc3 = (h + l + c) / 3
    let P, R1, S1, R2, S2, R3, S3, R4, S4, R5, S5
    switch (type.toLowerCase()) {
      case 'traditional':
        P = hlc3
        R1 = P * 2 - l
        S1 = P * 2 - h
        R2 = P + (h - l)
        S2 = P - (h - l)
        R3 = P + (h - l) * 1.5
        S3 = P - (h - l) * 1.5
        R4 = P + (h - l) * 2
        S4 = P - (h - l) * 2
        R5 = P + (h - l) * 2.5
        S5 = P - (h - l) * 2.5
        break
      case 'fibonacci':
        P = hl2
        const range = h - l
        R1 = P + range * 0.382
        S1 = P - range * 0.382
        R2 = P + range * 0.618
        S2 = P - range * 0.618
        R3 = P + range
        S3 = P - range
        break
      case 'woodie':
        P = (h + l + c * 2) / 4
        R1 = P * 2 - l
        S1 = P * 2 - h
        R2 = P + (h - l)
        S2 = P - (h - l)
        R3 = R1 + (h - l)
        S3 = S1 - (h - l)
        break
      case 'camarilla':
        P = (h + l + c) / 3
        const q = (h - l) / 4
        R1 = c + q
        S1 = c - q
        R2 = c + q * 2
        S2 = c - q * 2
        R3 = c + q * 3
        S3 = c - q * 3
        R4 = c + q * 4
        S4 = c - q * 4
        break
      case 'dm':
        let x
        if (c < o) x = h + 2 * l + c
        else if (c > o) x = 2 * h + l + c
        else x = h + l + 2 * c
        P = x / 4
        R1 = x / 2 - l
        S1 = x / 2 - h
        break
      case 'classic':
      default:
        P = hl2
        R1 = P * 2 - l
        S1 = P * 2 - h
        R2 = P + (h - l)
        S2 = P - (h - l)
        break
    }
    return {
      P: P ?? null,
      R1: R1 ?? null,
      S1: S1 ?? null,
      R2: R2 ?? null,
      S2: S2 ?? null,
      R3: R3 ?? null,
      S3: S3 ?? null,
      R4: R4 ?? null,
      S4: S4 ?? null,
      R5: R5 ?? null,
      S5: S5 ?? null,
    }
  }

  function avgVolume(bars, index, window) {
    const start = Math.max(0, index - window)
    let sum = 0
    let count = 0
    for (let j = start; j < index; j++) {
      if (Number.isFinite(bars[j].volume)) {
        sum += bars[j].volume
        count++
      }
    }
    return count > 0 ? sum / count : 0
  }

  function markerPad(bars) {
    let sum = 0
    let count = 0
    for (const bar of bars) {
      const range = bar.high - bar.low
      if (Number.isFinite(range) && range > 0) {
        sum += range
        count++
      }
    }
    const mean = count > 0 ? sum / count : 0
    const last = bars.length > 0 ? Math.abs(bars[bars.length - 1].close) : 0
    return Math.max(mean * 0.5, last * 0.0005)
  }

  registerIndicator({
    id: 'pivot-points-strategy',
    name: 'Pivot Points Strategy',
    category: 'Custom',
    placement: 'onchart',
    inputs: [
      {
        key: 'pivotType',
        type: 'select',
        label: 'Pivot Type',
        default: 'Traditional',
        options: [
          { label: 'Traditional', value: 'Traditional' },
          { label: 'Fibonacci', value: 'Fibonacci' },
          { label: 'Woodie', value: 'Woodie' },
          { label: 'Classic', value: 'Classic' },
          { label: 'DM (DeMark)', value: 'DM' },
          { label: 'Camarilla', value: 'Camarilla' },
        ],
      },
      {
        key: 'useDailyBased',
        type: 'boolean',
        label: 'Use Daily-Based Pivots',
        default: true,
      },
      {
        key: 'showLevel5',
        type: 'boolean',
        label: 'Show R5/S5 Levels',
        default: false,
      },
      {
        key: 'showSignals',
        type: 'boolean',
        label: 'Show Buy/Sell Signals',
        default: true,
      },
      {
        key: 'tolerance',
        type: 'number',
        label: 'Bounce Tolerance (%)',
        default: 0.5,
        min: 0.1,
        max: 2,
        step: 0.1,
      },
      {
        key: 'timezone',
        type: 'text',
        label: 'Timezone',
        default: DEFAULT_TIMEZONE,
      },
      ...AUTO_TRADE_INPUTS,
    ],
    plots: [
      { key: 'P', type: 'line', title: 'Pivot', style: { color: COLORS.P, lineWidth: 2 } },
      { key: 'R1', type: 'line', title: 'R1', style: { color: COLORS.R1, lineWidth: 1 } },
      { key: 'R2', type: 'line', title: 'R2', style: { color: COLORS.R2, lineWidth: 1 } },
      { key: 'R3', type: 'line', title: 'R3', style: { color: COLORS.R3, lineWidth: 1 } },
      { key: 'R4', type: 'line', title: 'R4', style: { color: COLORS.R2, lineWidth: 1, lineStyle: 'dashed' } },
      { key: 'R5', type: 'line', title: 'R5', style: { color: COLORS.R3, lineWidth: 1, lineStyle: 'dashed' } },
      { key: 'S1', type: 'line', title: 'S1', style: { color: COLORS.S1, lineWidth: 1 } },
      { key: 'S2', type: 'line', title: 'S2', style: { color: COLORS.S2, lineWidth: 1 } },
      { key: 'S3', type: 'line', title: 'S3', style: { color: COLORS.S3, lineWidth: 1 } },
      { key: 'S4', type: 'line', title: 'S4', style: { color: COLORS.S2, lineWidth: 1, lineStyle: 'dashed' } },
      { key: 'S5', type: 'line', title: 'S5', style: { color: COLORS.S3, lineWidth: 1, lineStyle: 'dashed' } },
      { key: '_regime', type: 'line', title: 'Regime', style: { visible: false } },
    ],
    calc(bars, settings) {
      const type = String(settings.pivotType || 'Traditional')
      const showLevel5 = settings.showLevel5 === true
      const useDailyBased = settings.useDailyBased !== false
      const tolerance = (Number(settings.tolerance) || 0.5) / 100
      const zone = zoneOf(settings)
      const n = bars.length

      const result = {
        P: new Array(n).fill(null),
        R1: new Array(n).fill(null),
        R2: new Array(n).fill(null),
        R3: new Array(n).fill(null),
        R4: new Array(n).fill(null),
        R5: new Array(n).fill(null),
        S1: new Array(n).fill(null),
        S2: new Array(n).fill(null),
        S3: new Array(n).fill(null),
        S4: new Array(n).fill(null),
        S5: new Array(n).fill(null),
        _regime: new Array(n).fill(0), // Start at 0 not null so first signal can fire
      }

      // For daily-based pivots, we need to track previous day's OHLC
      let prevDayHigh = null
      let prevDayLow = null
      let prevDayClose = null
      let prevDayOpen = null
      let curDayHigh = Number.NEGATIVE_INFINITY
      let curDayLow = Number.POSITIVE_INFINITY
      let curDayOpen = null
      let curDayClose = null
      let lastDayIndex = null

      let inBuy = false
      let inSell = false

      for (let i = 0; i < n; i++) {
        const bar = bars[i]
        const parts = utcSecondsToZonedParts(bar.time, zone)
        const dayIdx = zonedDayIndex(bar.time, zone)
        const isNewDay = lastDayIndex !== null && dayIdx !== lastDayIndex

        if (isNewDay) {
          // Roll current day to previous day
          if (Number.isFinite(curDayHigh) && Number.isFinite(curDayLow)) {
            prevDayHigh = curDayHigh
            prevDayLow = curDayLow
            prevDayClose = curDayClose
            prevDayOpen = curDayOpen
          }
          curDayHigh = Number.NEGATIVE_INFINITY
          curDayLow = Number.POSITIVE_INFINITY
          curDayOpen = null
          curDayClose = null
        }

        if (curDayOpen == null) curDayOpen = bar.open
        curDayClose = bar.close
        if (bar.high > curDayHigh) curDayHigh = bar.high
        if (bar.low < curDayLow) curDayLow = bar.low
        lastDayIndex = dayIdx

        // Determine pivot source
        let pivots = null
        if (i >= 1) {
          if (useDailyBased) {
            // Use previous day's OHLC if available, else previous bar
            if (prevDayHigh != null && prevDayLow != null && prevDayClose != null && prevDayOpen != null) {
              pivots = calculatePivots(prevDayOpen, prevDayHigh, prevDayLow, prevDayClose, type)
            } else {
              // Fallback to previous bar until we have a full day
              const pb = bars[i - 1]
              pivots = calculatePivots(pb.open, pb.high, pb.low, pb.close, type)
            }
          } else {
            const pb = bars[i - 1]
            pivots = calculatePivots(pb.open, pb.high, pb.low, pb.close, type)
          }
        }

        if (pivots) {
          result.P[i] = pivots.P
          result.R1[i] = pivots.R1
          result.R2[i] = pivots.R2
          result.R3[i] = pivots.R3
          result.R4[i] = pivots.R4
          result.R5[i] = showLevel5 ? pivots.R5 : null
          result.S1[i] = pivots.S1
          result.S2[i] = pivots.S2
          result.S3[i] = pivots.S3
          result.S4[i] = pivots.S4
          result.S5[i] = showLevel5 ? pivots.S5 : null
        }

        // Signal logic — only from i>=1 where pivots exist
        if (i >= 1 && pivots && pivots.P != null && pivots.R1 != null && pivots.S1 != null) {
          const prevBar = bars[i - 1]
          const avgVol = avgVolume(bars, i, 5)
          const hasVolume = Number.isFinite(bar.volume) && Number.isFinite(avgVol) && avgVol > 0
          const volOkBuy = !hasVolume || bar.volume > avgVol * 0.8 // 80% of avg, more lenient, and optional
          const volOkSell = !hasVolume || bar.volume > avgVol * 0.8
          const pTolerance = pivots.P * tolerance

          // BUY signals — only if not already in buy
          if (!inBuy) {
            if (pivots.R1 != null && prevBar.high <= pivots.R1 && bar.high > pivots.R1 && volOkBuy) {
              inBuy = true
              inSell = false
            } else if (pivots.R2 != null && prevBar.high <= pivots.R2 && bar.high > pivots.R2 && volOkBuy) {
              inBuy = true
              inSell = false
            } else if (
              bar.low >= pivots.P - pTolerance &&
              bar.low <= pivots.P + pTolerance &&
              bar.close > bar.open &&
              bar.close > pivots.P
            ) {
              inBuy = true
              inSell = false
            }
          }

          // SELL signals — only if not already in sell
          if (!inSell) {
            if (pivots.S1 != null && prevBar.low >= pivots.S1 && bar.low < pivots.S1 && volOkSell) {
              inSell = true
              inBuy = false
            } else if (pivots.S2 != null && prevBar.low >= pivots.S2 && bar.low < pivots.S2 && volOkSell) {
              inSell = true
              inBuy = false
            } else if (
              bar.high >= pivots.P - pTolerance &&
              bar.high <= pivots.P + pTolerance &&
              bar.close < bar.open &&
              bar.close < pivots.P
            ) {
              inSell = true
              inBuy = false
            }
          }

          // EXIT rules — close below/above pivot
          if (inBuy && bar.close < pivots.P) inBuy = false
          if (inSell && bar.close > pivots.P) inSell = false
        }

        result._regime[i] = inBuy ? 1 : inSell ? -1 : 0
      }

      return result
    },
    markers({ bars, values, settings }) {
      if (settings.showSignals === false) return []
      const regime = values._regime
      if (!regime) return []
      const out = []
      const pad = markerPad(bars)
      for (let i = 1; i < bars.length; i++) {
        const prev = regime[i - 1]
        const cur = regime[i]
        if (prev == null || cur == null) continue
        if (cur === 1 && prev !== 1) {
          const bar = bars[i]
          out.push({
            time: bar.time,
            position: 'atPrice',
            price: bar.low - pad,
            shape: 'labelUp',
            size: 'small',
            color: COLORS.BUYQ,
            text: 'Buy',
          })
        } else if (cur === -1 && prev !== -1) {
          const bar = bars[i]
          out.push({
            time: bar.time,
            position: 'atPrice',
            price: bar.high + pad,
            shape: 'labelDown',
            size: 'small',
            color: COLORS.SELLQ,
            text: 'Sell',
          })
        }
      }
      return out
    },
    alerts: [
      {
        id: 'buy-pivot-breakout',
        title: 'Pivot BUY Signal',
        message: 'Price broke above R1/R2 or bounced off Pivot — BUY signal',
        when: ({ values, settings, index }) => {
          if (!settings || settings.__autoTradeEnabled !== true) return false
          if (index < 1) return false
          const r = values._regime
          if (!r) return false
          const prev = r[index - 1]
          const cur = r[index]
          // Regime changed to BUY
          return cur === 1 && prev !== 1
        },
      },
      {
        id: 'sell-pivot-breakdown',
        title: 'Pivot SELL Signal',
        message: 'Price broke below S1/S2 or bounced off Pivot — SELL signal',
        when: ({ values, settings, index }) => {
          if (!settings || settings.__autoTradeEnabled !== true) return false
          if (index < 1) return false
          const r = values._regime
          if (!r) return false
          const prev = r[index - 1]
          const cur = r[index]
          // Regime changed to SELL — this is the critical Sell path that was failing
          return cur === -1 && prev !== -1
        },
      },
    ],
  })
}
