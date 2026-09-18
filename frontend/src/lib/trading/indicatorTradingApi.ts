import { webClient } from '@/api/client'

export interface IndicatorOrderRequest {
  symbol: string
  exchange: string
  action: 'BUY' | 'SELL'
  quantity: number
  product: 'MIS' | 'NRML' | 'CNC'
  pricetype: 'MARKET' | 'LIMIT' | 'SL' | 'SL-M'
  strategy: string
  price?: number
  trigger_price?: number
}

export interface IndicatorPosition {
  symbol?: string
  quantity?: number | string
  netqty?: number | string
  net_qty?: number | string
  product?: string
  [key: string]: unknown
}

export interface IndicatorOrderResponse {
  status?: string
  mode?: string
  orderid?: string
  order_status?: string
  message?: string
  data?: unknown
}

interface IndicatorPositionsResponse {
  status?: string
  message?: string
  data?: IndicatorPosition[] | { positions?: IndicatorPosition[] }
}

function errorMessage(data: { message?: string }, fallback: string): string {
  return data.message || fallback
}

/**
 * Session-authenticated execution boundary for indicator signals.
 *
 * The browser sends only chart/order intent. The server resolves the user's
 * broker credentials and platform mode, so an indicator or chart bundle never
 * receives an OpenAlgo API key.
 */
export async function placeIndicatorOrder(
  request: IndicatorOrderRequest
): Promise<IndicatorOrderResponse> {
  const { data } = await webClient.post<IndicatorOrderResponse>(
    '/trading/api/indicator-order',
    request
  )
  if (data.status === 'error') throw new Error(errorMessage(data, 'Indicator order failed'))
  return data
}

export async function getIndicatorPositions(): Promise<IndicatorPosition[]> {
  const { data } = await webClient.get<IndicatorPositionsResponse>(
    '/trading/api/indicator-positions'
  )
  if (data.status === 'error') throw new Error(errorMessage(data, 'Unable to read positions'))
  if (Array.isArray(data.data)) return data.data
  if (data.data && Array.isArray(data.data.positions)) return data.data.positions
  return []
}

export async function getIndicatorOrderStatus(orderid: string): Promise<IndicatorOrderResponse> {
  const { data } = await webClient.post<IndicatorOrderResponse>(
    '/trading/api/indicator-order-status',
    {
      orderid,
    }
  )
  if (data.status === 'error') throw new Error(errorMessage(data, 'Unable to verify order status'))
  return data
}
