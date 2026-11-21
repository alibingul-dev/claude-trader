// Binance Square posting on real position open/close. Needs BINANCE_SQUARE_KEY (Creator Center → Create API Key).
// Never throws: a failed post must not block trading. Every attempt is logged to partition "square".
const db = require('./store');

const URL_ADD = 'https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add';
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

const pick = (a) => a[Math.floor(Math.random() * a.length)];

// Coin track record from closed real trades: count, long/short split, win rate %, profit factor.
async function record(symbol) {
  let tr = [];
  try { tr = (await db.list('trade')).filter((x) => x.symbol === symbol); } catch {}
  const tag = `$${coin(symbol)}`;
  if (!tr.length) return pick([`First time trading ${tag} here.`, `New coin for me, no history on ${tag} yet.`]);
  const L = tr.filter((x) => x.side === 'LONG').length, S = tr.length - L;
  const w = tr.filter((x) => x.net > 0), gw = w.reduce((a, x) => a + x.net, 0), gl = -tr.filter((x) => x.net <= 0).reduce((a, x) => a + x.net, 0);
  const wr = Math.round((w.length / tr.length) * 100);
  const pf = gl ? (gw / gl).toFixed(2) : null;
  const side = [L && `${L} long`, S && `${S} short`].filter(Boolean).join(' / ');
  const pfTxt = pf == null ? 'no losing trade yet' : `profit factor ${pf}`;
  return pick([
    `My ${tag} record so far: ${tr.length} trade${tr.length > 1 ? 's' : ''} (${side}), ${wr}% win rate, ${pfTxt}.`,
    `${tag} track record: ${tr.length} trade${tr.length > 1 ? 's' : ''}, ${side}, won ${wr}% of them, ${pfTxt}.`,
  ]);
}
const pct = (a, b) => Math.abs((b / a - 1) * 100).toFixed(1);

function openText(p, rec) {
  const t = `$${coin(p.symbol)}`, up = p.side === 'LONG';
  const hook = up
    ? pick([`${t} still has legs, going long here 🚀`, `Longing ${t}. Momentum hasn't cooled off yet 🔥`, `${t} keeps pushing, I'm in long 📈`, `Taking a long on ${t}, volume is there 👀`, `${t} looks like it wants more. Long 💪`])
    : pick([`${t} is bleeding, shorting it 🩸`, `Short ${t}. No bounce in sight yet 📉`, `${t} keeps dumping, I'm short 🔻`, `Opened a short on ${t}, sellers in control 🐻`, `${t} looks weak. Short 👇`]);
  const plan = pick([
    `Entry ${fp(p.entry)}, stop ${fp(p.sl)}, target ${fp(p.tp)}.`,
    `In at ${fp(p.entry)}. Stop ${fp(p.sl)} (${f(p.sl_pct, 1)}%), TP ${fp(p.tp)} (${f(p.tp_pct, 1)}%).`,
    `${fp(p.entry)} entry, invalidation ${fp(p.sl)}, aiming for ${fp(p.tp)}.`,
  ]);
  const tail = pick([`Small size, ${p.lev}x, paper account.`, `${p.lev}x isolated, tiny size, paper.`, `Paper trade, ${p.lev}x. Let's see 🤞`, `${p.lev}x on the paper account. We'll see how it plays out 🍿`]);
  return [hook, plan, tail, rec, `${t} #trading #crypto #papertrading`].join('\n');
}

function closeText(t, rec) {
  const tag = `$${coin(t.symbol)}`, n = `${sg(t.net)} USDT`, move = pct(t.entry, t.exit);
  const quick = t.holdMin <= 15;
  let line;
  if (t.exitReason === 'TP') line = pick([`${tag} hit the target 🎯 That's the one. ${n}`, `There it is ✅ ${tag} tagged TP. ${n}`, `Called it on ${tag} 😎 TP filled, ${n}`, `${tag} played out exactly like I wanted 🙌 ${n}`]);
  else if (t.exitReason === 'STOP' || t.exitReason === 'LİKİDASYON') line = quick
    ? pick([`Ugh 😩 ${tag} wicked me out in ${t.holdMin} min. ${n}`, `${tag} stopped out almost instantly 🤦 Stop was too tight. ${n}`, `Well that was fast 😅 ${tag} took my stop in ${t.holdMin} min. ${n}`])
    : pick([`${tag} didn't work out 😕 Thought it would go, it didn't. ${n}`, `Stopped out on ${tag} ❌ Wrong call. ${n}`, `${tag} turned on me 🙃 stop hit. ${n}`, `Not this time 🤷 ${tag} stop got taken. ${n}`]);
  else if (t.exitReason === 'SÜRE') line = pick([`${tag} went nowhere 😴 closed it on time. ${n}`, `Ran out of patience on ${tag} ⏳ time exit. ${n}`]);
  else line = pick([`Closed ${tag} manually. ${n}.`, `Got out of ${tag} early. ${n}.`]);
  const detail = pick([`${fp(t.entry)} → ${fp(t.exit)} (${move}%), held ${t.holdMin} min.`, `Entry ${fp(t.entry)}, out ${fp(t.exit)}. ${t.holdMin} min in the trade.`]);
  const after = t.net > 0 ? pick([`On to the next 💪`, `Taking it.`, `Good one 🍀`]) : pick([`Part of the game.`, `Next one 👊`, `Losses are logged too.`]);
  return [line, detail, rec, after, `${tag} #trading #crypto #papertrading`].join('\n');
}

module.exports = {
  postOpen: async (p) => post('open', p.id, openText(p, await record(p.symbol))),
  postClose: async (t) => post('close', t.id, closeText(t, await record(t.symbol))),
  _t: { openText, closeText, record },
};
