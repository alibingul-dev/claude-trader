// Binance erisim testi: GET / -> her uc nokta icin HTTP kodu. Bagimlilik yok (Node 18+ fetch).
const http = require('http');
const URLS = [
  'https://fapi.binance.com/fapi/v1/ping',
  'https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT',
  'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=2',
  'https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=BTCUSDT&period=1h&limit=1',
  'https://api.binance.com/api/v3/ping',
];
async function probe() {
  const lines = [`time_utc: ${new Date().toISOString()}`];
  try { const r = await fetch('https://ipinfo.io/json'); const j = await r.json(); lines.push(`server: ${j.country} ${j.region} ${j.city}`); } catch (e) { lines.push('server: ?'); }
  for (const u of URLS) {
    try { const r = await fetch(u); const t = (await r.text()).slice(0, 100).replace(/\s+/g, ' '); lines.push(`${r.status}  ${u}  ${t}`); }
    catch (e) { lines.push(`ERR  ${u}  ${e.message}`); }
  }
  const ok = lines.filter((l) => l.startsWith('200')).length;
  lines.push(ok === URLS.length ? 'SONUC: Binance erisimi ACIK' : `SONUC: ${ok}/${URLS.length} acik`);
  return lines.join('\n');
}
http.createServer(async (req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(await probe());
}).listen(process.env.PORT || 10000);
