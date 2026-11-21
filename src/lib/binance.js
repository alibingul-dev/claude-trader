// Binance USDT-M public market data (no API key). Base: fapi (futures), not api (spot).
const BASE = process.env.BINANCE_BASE || 'https://fapi.binance.com';

async function get(path, params = {}) {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null));
  const qs = new URLSearchParams(clean).toString();
  const res = await fetch(`${BASE}${path}${qs ? '?' + qs : ''}`);
  if (!res.ok) {
    const txt = (await res.text()).slice(0, 200);
    throw new Error(`Binance ${path} HTTP ${res.status}: ${txt}`);
  }
  return res.json();
}

module.exports = {
  ticker24h: () => get('/fapi/v1/ticker/24hr'),
  premiumAll: () => get('/fapi/v1/premiumIndex'),
  premium: (symbol) => get('/fapi/v1/premiumIndex', { symbol }),
  klines: (symbol, interval, opts = {}) => get('/fapi/v1/klines', { symbol, interval, ...opts }),
  fundingRate: (symbol, startTime, endTime) =>
    get('/fapi/v1/fundingRate', { symbol, startTime, endTime, limit: 100 }),
  exchangeInfo: () => get('/fapi/v1/exchangeInfo'),
};
