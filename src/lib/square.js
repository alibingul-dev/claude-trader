// Binance Square posting on real position open/close. Needs BINANCE_SQUARE_KEY (Creator Center → Create API Key).
// Never throws: a failed post must not block trading. Every attempt is logged to partition "square".
const db = require('./store');

const URL_ADD = 'https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add';
const DASH = 'https://alibingul-dev.github.io/claude-trader/';
const f = (x, d = 4) => Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fp = (x) => Number(x).toLocaleString('en-US', { maximumSignificantDigits: 7 });
const sg = (x, d = 4) => (x > 0 ? '+' : '') + f(x, d);
const coin = (s) => String(s).replace(/USDT$/, '');

async function send(text) {
  const r = await fetch(URL_ADD, {
    method: 'POST',
    headers: { 'X-Square-OpenAPI-Key': process.env.BINANCE_SQUARE_KEY, 'Content-Type': 'application/json', clienttype: 'binanceSkill' },
    body: JSON.stringify({ bodyTextOnly: text }),
  });
  return r.json().catch(() => ({ code: `HTTP ${r.status}` }));
}

async function post(kind, id, text) {
  if (!process.env.BINANCE_SQUARE_KEY) return { skipped: 'BINANCE_SQUARE_KEY yok' };
  let res, body = text;
  try {
    res = await send(body);
    if (res.code === '20041') { body = text.replace(/\n?.*https?:\/\/\S+.*$/m, ''); res = await send(body); } // link rejected → post without it
  } catch (e) { res = { code: 'FETCH', message: e.message }; }
  const ok = res.code === '000000';
  const out = { ts: Date.now(), kind, pos: id, ok, code: res.code, message: res.message || null, postId: res.data?.id || null, url: res.data?.id ? `https://www.binance.com/square/post/${res.data.id}` : null };
  try { await db.put('square', `${String(out.ts).padStart(15, '0')}_${id}_${kind}`, out); } catch {}
  return out;
}

function openText(p) {
  const tag = `$${coin(p.symbol)}`;
  return [
    `🤖 Claude Trader · ${p.side === 'LONG' ? '🟢 LONG' : '🔴 SHORT'} ${tag} ${p.lev}x`,
    `Entry ${fp(p.entry)} USDT · Stop ${fp(p.sl)} USDT (${f(p.sl_pct, 2)} %) · TP ${fp(p.tp)} USDT (${f(p.tp_pct, 2)} %)`,
    `Paper trade: ${f(p.notional, 2)} USDT notional, isolated margin, fees and funding included.`,
    `TR: Claude yapay zekâsı bu pozisyonu kağıt üzerinde açtı; kazanç da kayıp da kayıtlı.`,
    `Live log: ${DASH}`,
    `#ClaudeTrader #PaperTrading #AITrading ${tag}`,
  ].join('\n');
}

function closeText(t) {
  const tag = `$${coin(t.symbol)}`;
  const why = { STOP: 'Stop hit', TP: 'Take profit hit', 'SÜRE': 'Time exit', 'LİKİDASYON': 'Liquidated' }[t.exitReason] || 'Manual close';
  return [
    `🤖 Claude Trader · ${t.net > 0 ? '✅' : '❌'} CLOSED ${t.side} ${tag} ${t.lev}x`,
    `${why} · Net ${sg(t.net)} USDT (${sg(t.roiMarginPct, 1)} % on margin) · held ${t.holdMin} min`,
    `Entry ${fp(t.entry)} → Exit ${fp(t.exit)} USDT · fees ${f(t.feeIn + t.feeOut)} USDT`,
    `TR: Kapanan işlem; kazanç ve kayıp aynı şeffaflıkla yayınlanır.`,
    `Live log: ${DASH}`,
    `#ClaudeTrader #PaperTrading #AITrading ${tag}`,
  ].join('\n');
}

module.exports = { postOpen: (p) => post('open', p.id, openText(p)), postClose: (t) => post('close', t.id, closeText(t)), _t: { openText, closeText } };
