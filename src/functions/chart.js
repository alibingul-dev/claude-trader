// Public price path for one position: GET /api/chart?symbol=IDOLUSDT&from=<ms>&to=<ms>
// Nothing is stored: candles are fetched from Binance on demand.
const { app } = require('@azure/functions');
const bn = require('../lib/binance');

const MIN = 60_000;

app.http('chart', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'chart',
  handler: async (req) => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' };
    const symbol = String(req.query.get('symbol') || '').toUpperCase();
    const from = +req.query.get('from'), to = +req.query.get('to') || Date.now();
    if (!/^[A-Z0-9]{2,30}USDT$/.test(symbol) || !(from > 0) || !(to > from) || to - from > 5 * 864e5)
      return { status: 400, headers, jsonBody: { error: 'symbol, from, to (ms) gerekli; aralık en fazla 5 gün' } };
    const pad = Math.max(30 * MIN, (to - from) * 0.15);
    const start = from - pad, end = to + pad;
    const span = (end - start) / MIN;
    const interval = span <= 1400 ? '1m' : span <= 7000 ? '5m' : '15m';
    try {
      const kl = await bn.klines(symbol, interval, { startTime: Math.floor(start), endTime: Math.floor(end), limit: 1500 });
      return { status: 200, headers, jsonBody: { symbol, interval, candles: kl.map((k) => [k[0], +k[2], +k[3], +k[4]]) } };
    } catch (e) {
      return { status: 502, headers, jsonBody: { error: e.message } };
    }
  },
});
