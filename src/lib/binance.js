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

// Read-only signed call (USER_DATA). Needs a key with only "Enable Reading"; returns null without a key.
const crypto = require('crypto');
async function signedGet(path, params = {}) {
  const key = process.env.BINANCE_API_KEY, secret = process.env.BINANCE_API_SECRET;
  if (!key || !secret) return null;
  const qs = new URLSearchParams({ ...params, recvWindow: 10000, timestamp: Date.now() }).toString();
  const sig = crypto.createHmac('sha256', secret).update(qs).digest('hex');
  const res = await fetch(`${BASE}${path}?${qs}&signature=${sig}`, { headers: { 'X-MBX-APIKEY': key } });
  if (!res.ok) throw new Error(`Binance ${path} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

module.exports = {
  leverageBracket: (symbol) => signedGet('/fapi/v1/leverageBracket', { symbol }),
  ticker24h: () => get('/fapi/v1/ticker/24hr'),
  premiumAll: () => get('/fapi/v1/premiumIndex'),
  premium: (symbol) => get('/fapi/v1/premiumIndex', { symbol }),
  klines: (symbol, interval, opts = {}) => get('/fapi/v1/klines', { symbol, interval, ...opts }),
  fundingRate: (symbol, startTime, endTime) =>
    get('/fapi/v1/fundingRate', { symbol, startTime, endTime, limit: 100 }),
  exchangeInfo: () => get('/fapi/v1/exchangeInfo'),
};
