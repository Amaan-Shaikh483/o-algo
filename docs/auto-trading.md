# Auto-Trading from Chart Indicators

OpenAlgo's charting terminal supports auto-trading: when an indicator on the
chart produces a NEW confirmed BUY or SELL signal, an order is automatically
executed on the current chart's symbol and exchange through the OpenAlgo broker
API.

## How it works

```
Indicator calc() + alerts[]
        │
        ▼
  chart.on('indicator:alert')     ← only fires on closed-candle tail changes
        │
        ▼
  SignalBridge                     ← deduplication + position check
        │
        ▼
  OpenAlgoTradeFeed.place()        ← same feed as manual Buy/Sell buttons
        │
        ▼
  /api/v1/placeorder               ← server-side, session-authenticated
```

**Key properties:**

- Only **NEW confirmed (closed candle) signals** trigger orders. History loads,
  chart rebuilds, settings changes and symbol switches fire nothing.
- **Duplicate prevention**: same indicator + same alert + same bar time is
  executed at most once. Chart reloads cannot produce duplicate orders.
- **Position awareness**: if already positioned in the same direction, the
  signal is skipped. If positioned in the opposite direction, the position is
  closed first (reversal), then the new order is placed.
- **Mode auto-detection**: in Analyze/Paper mode, orders go to the sandbox.
  In Live mode, orders go to the real broker. You do not need to select this
  manually — the chart platform mode determines it.
- **API keys are never exposed in the browser**: the order goes through the
  same session-authenticated trade feed as manual chart orders.

## Quick Start

### Step 1: Add an auto-trade indicator

Three ready-to-use indicators are included:

| Indicator | File | Signal Logic |
|-----------|------|-------------|
| Auto-Trade MACD | `auto-macd.js` | MACD crosses above/below signal line |
| Auto-Trade Supertrend | `auto-supertrend.js` | Supertrend flips up/down |
| Auto-Trade EMA Cross | `auto-ema-cross.js` | Fast EMA crosses above/below slow EMA |
| Open Range Breakout | `open_range_breakout.js` | ORB high/low breakout |
| Pivot Points Strategy | `pivot-points-strategy.js` | Breakout above R1/R2 or below S1/S2, bounce off Pivot |

These appear in the indicator picker under the **Custom** category.

### Step 2: Enable auto-trade

1. Add the indicator to your chart
2. Click the gear icon on its legend row to open settings
3. In the **Auto Trade** section:
   - Enable **Auto Trade**
   - Set **Quantity** (lots for derivatives, units for equity)
   - Choose **Product** (MIS for intraday, NRML for carry, CNC for delivery)
   - Choose **Price Type** (Market, Limit, Stop Loss, SL-Market)
4. Click Save

That's it. When the indicator produces a new signal on a closed candle, an
order is placed automatically.

### Step 3: Monitor

- Auto-trade orders appear in the bottom dock (Order Book)
- Toast notifications show each executed order with the indicator name
- In Analyze mode, orders go to the sandbox — no real money is risked

## Signal Convention

The signal bridge reads the **alert id prefix** to determine the order side:

| Alert id prefix | Order side |
|-----------------|------------|
| `buy-*` | BUY |
| `sell-*` | SELL |

For example: `buy-crossover`, `sell-flip`, `buy-signal`, `sell-threshold`.

## Making Your Own Indicator Auto-Tradeable

### Option A: Add alerts and inputs directly

Add these to any indicator descriptor:

```js
registerIndicator({
  id: 'my-indicator',
  name: 'My Indicator',
  // ... normal descriptor ...

  // Add auto-trade inputs
  inputs: [
    // ... your existing inputs ...
    { key: '__autoTradeEnabled', type: 'boolean', label: 'Auto Trade',
      default: false, group: 'Auto Trade' },
    { key: '__autoTradeQty', type: 'number', label: 'AT Quantity',
      default: 1, min: 1, group: 'Auto Trade' },
    { key: '__autoTradeProduct', type: 'select', label: 'AT Product',
      default: 'MIS', group: 'Auto Trade',
      options: [
        { label: 'MIS', value: 'MIS' },
        { label: 'NRML', value: 'NRML' },
        { label: 'CNC', value: 'CNC' },
      ] },
    { key: '__autoTradePriceType', type: 'select', label: 'AT Price Type',
      default: 'MARKET', group: 'Auto Trade',
      options: [
        { label: 'Market', value: 'MARKET' },
        { label: 'Limit', value: 'LIMIT' },
        { label: 'SL', value: 'SL' },
        { label: 'SL-M', value: 'SL-M' },
      ] },
  ],

  // Add alerts with buy/sell id prefixes
  alerts: [
    {
      id: 'buy-my-condition',       // prefix 'buy-' → BUY order
      title: 'My buy signal',
      when: ({ values, settings, index }) => {
        if (!settings.__autoTradeEnabled) return false
        // Your buy condition here
        return values.myLine[index] > values.refLine[index]
          && values.myLine[index - 1] <= values.refLine[index - 1]
      },
    },
    {
      id: 'sell-my-condition',      // prefix 'sell-' → SELL order
      title: 'My sell signal',
      when: ({ values, settings, index }) => {
        if (!settings.__autoTradeEnabled) return false
        // Your sell condition here
        return values.myLine[index] < values.refLine[index]
          && values.myLine[index - 1] >= values.refLine[index - 1]
      },
    },
  ],
})
```

### Option B: Use the `withAutoTrade` wrapper

```js
import { withAutoTrade } from './autoTradeIndicator.js'

export default function (api) {
  const { registerIndicator, ... } = api

  const myDescriptor = {
    id: 'my-base-indicator',
    name: 'My Indicator',
    // ... your normal descriptor (calc, plots, etc.) ...
  }

  // Wrap it — adds inputs, alerts and markers automatically
  registerIndicator(withAutoTrade(myDescriptor, {
    signalSource: 'fastLine',    // primary calc output column
    signalRef: 'slowLine',       // reference line for crossover
  }))
}
```

### Option C: Wrap a built-in indicator

```js
export default function (api) {
  const { registerIndicator, getIndicator, indicatorDefaults } = api

  const macd = getIndicator('macd')
  registerIndicator(withAutoTrade({
    ...macd,
    id: 'auto-macd',
    name: 'Auto-Trade MACD',
  }, {
    signalSource: 'macd',
    signalRef: 'signal',
  }))
}
```

## Auto-Trade Settings Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `__autoTradeEnabled` | boolean | false | Enable auto-trading for this indicator |
| `__autoTradeQty` | number | 1 | Order quantity (lots for FnO, units for equity) |
| `__autoTradeProduct` | select | MIS | Product: MIS (intraday), NRML (carry), CNC (delivery) |
| `__autoTradePriceType` | select | MARKET | Price type: MARKET, LIMIT, SL, SL-M |

## Architecture

### Signal → Deduplication → Execution Bridge

```
signalBridge.ts
├── SignalBridge class
│   ├── attach()        — subscribes to chart indicator:alert events
│   ├── detach()        — unsubscribes (on chart rebuild/destroy)
│   ├── reset()         — clears dedup state (on symbol change)
│   └── handleAlert()   — core pipeline:
│       ├── sideFromAlertId()    — determine BUY/SELL from alert id prefix
│       ├── readAutoTradeConfig() — read indicator's auto-trade settings
│       ├── deduplication         — bar time + indicator + alert id
│       ├── position check        — same direction? skip. Opposite? close first.
│       └── executeSignal()       — place order via trade feed
│
├── AUTO_TRADE_INPUTS   — reusable input definitions
└── withAutoTrade()     — wrapper for making any indicator auto-tradeable
```

### Files

| File | Purpose |
|------|---------|
| `frontend/src/lib/trading/signalBridge.ts` | Core signal bridge module |
| `frontend/src/lib/trading/terminal.ts` | Terminal integration (lifecycle hooks) |
| `strategies/indicators/auto-macd.js` | Auto-trade MACD indicator |
| `strategies/indicators/auto-supertrend.js` | Auto-trade Supertrend indicator |
| `strategies/indicators/auto-ema-cross.js` | Auto-trade EMA Crossover indicator |
| `strategies/indicators/open_range_breakout.js` | Open Range Breakout indicator |
| `strategies/indicators/pivot-points-strategy.js` | Pivot Points Strategy indicator |
| `strategies/indicators/autoTradeIndicator.js` | Reusable wrapper for custom indicators |
| `docs/auto-trading.md` | This documentation |

## Safety Features

1. **Closed-candle only**: alerts only fire on tail changes (confirmed bars),
   never during history loads or chart rebuilds.
2. **Deduplication**: `indicatorId:alertId:barTime` keyed — same signal on
   same bar is never executed twice, even across chart reloads.
3. **Cooldown**: 2-second minimum between orders for the same indicator.
4. **Position check**: same-direction signals are skipped; opposite-direction
   signals close the existing position first.
5. **Mode assertion**: the trade feed checks the page's mode (live/analyze)
   against the server before posting — a switch to analyze mode mid-session
   stops live orders immediately.
6. **Freeze limit**: orders exceeding the instrument's freeze quantity are
   rejected with a clear message.
7. **Replay lock**: no orders while chart replay is active.
8. **Serial execution**: one order at a time per bridge; concurrent signals
   are queued, not doubled.
9. **Toast notifications**: every order (success and failure) is reported
   with the indicator name and order details.
10. **No API keys in browser**: orders use the same session-authenticated
    trade feed as manual chart trading.

## FAQ

**Q: Will historical signals on the chart trigger orders?**
A: No. The `indicator:alert` event only fires on tail-only changes (new
confirmed candle). Loading history, changing settings, paging, or switching
symbol fires nothing.

**Q: What happens if I reload the page?**
A: The signal bridge's dedup state is in memory and resets on reload. However,
alerts only fire on NEW tail changes, so the same closed candle will not
re-fire. Only the next new candle's signal will execute.

**Q: Can I use auto-trade with built-in indicators (like RSI, Bollinger)?**
A: Built-in indicators do not have alert declarations by default. To auto-trade
them, use the auto-trade wrapper to create a custom version (see "Option C"
above), or create a custom indicator that references the built-in's calculation
via `getIndicator()` and adds its own alerts.

**Q: What if I'm in Analyze/Paper mode?**
A: Orders go to the OpenAlgo sandbox, not the real broker. The toast shows
`[PAPER]` to confirm. You do not need to select this — the platform mode
auto-detects it.

**Q: Can multiple indicators auto-trade simultaneously?**
A: Yes. Each indicator instance has its own auto-trade settings. The signal
bridge handles all of them with independent deduplication. Position checks are
shared (same symbol), so one indicator's signal may skip if another already
positioned in that direction.

**Q: What about reversal handling?**
A: If you're long and a SELL signal arrives, the bridge first places a BUY
order to close the short (MARKET), then places the new SELL order. If the
close fails, the new order is not placed.
