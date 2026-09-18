import { describe, expect, it } from 'vitest'
import {
  markerSide,
  SignalLedger,
  signalFromAlert,
  signalKey,
  signalsFromMarkers,
  stableJson,
} from './signalBridge'

describe('signal bridge', () => {
  it('uses typed marker direction, not marker text', () => {
    expect(markerSide({ shape: 'labelUp', text: 'anything' } as never)).toBe('BUY')
    expect(markerSide({ shape: 'labelDown', text: 'not a side' } as never)).toBe('SELL')
    expect(markerSide({ shape: 'circle', text: 'Buy' } as never)).toBeNull()
    expect(markerSide({ shape: 'circle', side: 'SELL' } as never)).toBe('SELL')
  })

  it('reads the same descriptor marker hook used by the renderer', () => {
    const bars = [
      { time: 10, open: 1, high: 2, low: 0, close: 1, volume: 1 },
      { time: 20, open: 1, high: 3, low: 1, close: 2, volume: 1 },
    ]
    const instance = {
      id: 'demo-1',
      indicatorId: 'demo',
      name: 'Demo',
      visible: () => true,
      values: () => ({ signal: [null, 2] }),
      settings: () => ({}),
    } as never
    const descriptor = {
      markers: ({ bars: sourceBars }: { bars: typeof bars }) => [
        {
          time: sourceBars[1].time,
          position: 'atPrice',
          price: 0,
          shape: 'labelUp',
          text: 'not used',
        },
      ],
    } as never
    expect(signalsFromMarkers({ descriptor, instance, bars })).toMatchObject([
      { side: 'BUY', time: 20, index: 1, source: 'marker' },
    ])
  })

  it('makes settings order irrelevant to deduplication', () => {
    expect(stableJson({ b: 2, a: 1 })).toBe(stableJson({ a: 1, b: 2 }))
    expect(
      signalKey({
        symbol: 'X',
        exchange: 'NSE',
        interval: '5m',
        indicatorId: 'demo',
        settings: { b: 2, a: 1 },
        side: 'BUY',
        time: 20,
      })
    ).toBe(
      signalKey({
        symbol: 'X',
        exchange: 'NSE',
        interval: '5m',
        indicatorId: 'demo',
        settings: { a: 1, b: 2 },
        side: 'BUY',
        time: 20,
      })
    )
  })

  it('never claims a signal twice, including after a new ledger reads storage', () => {
    const storage = new Map<string, string>()
    const fake = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    } as unknown as Storage
    const one = new SignalLedger(fake)
    expect(one.claim('one')).toBe(true)
    one.complete('one', 'sent', 'order-1')
    const two = new SignalLedger(fake)
    expect(two.claim('one')).toBe(false)
    expect(two.status('one')).toBe('sent')
  })

  it('only accepts a typed alert side', () => {
    expect(
      signalFromAlert({ indicatorId: 'x', instanceId: 'x-1', time: 1, side: 'BUY' })?.side
    ).toBe('BUY')
    expect(
      signalFromAlert({ indicatorId: 'x', instanceId: 'x-1', time: 1, title: 'Buy' })
    ).toBeNull()
  })
})
