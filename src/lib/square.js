// On every real position open/close: (1) a Binance Square post (only if BINANCE_SQUARE_KEY is set),
// (2) a bilingual Agent Resume feed entry stored in partition "feed", served by GET /api/feed and pulled
// into alibingul-dev.github.io/team-feed by that repo's trader-feed workflow. Never throws.
const db = require('./store');

const URL_ADD = 'https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add';
const AGENT = 'crypto-trader';
const nf = (loc) => (x, d) => Number(x).toLocaleString(loc, d == null ? { maximumSignificantDigits: 7 } : { minimumFractionDigits: d, maximumFractionDigits: d });
const EN = nf('en-US'), TR = nf('tr-TR');
const sgn = (fmt, x, d) => (x > 0 ? '+' : '') + fmt(x, d);
const coin = (s) => String(s).replace(/USDT$/, '');
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const pct = (a, b) => Math.abs((b / a - 1) * 100);

async function send(text) {
  const r = await fetch(URL_ADD, {
    method: 'POST',
    headers: { 'X-Square-OpenAPI-Key': process.env.BINANCE_SQUARE_KEY, 'Content-Type': 'application/json', clienttype: 'binanceSkill' },
    body: JSON.stringify({ bodyTextOnly: text }),
  });
  return r.json().catch(() => ({ code: `HTTP ${r.status}` }));
}

async function square(kind, id, text) {
  if (!process.env.BINANCE_SQUARE_KEY) return { skipped: 'BINANCE_SQUARE_KEY yok' };
  let res, body = text;
  try {
    res = await send(body);
    if (res.code === '20041') { body = body.replace(/\n?.*https?:\/\/\S+.*$/m, ''); res = await send(body); } // link rejected → post without it
    if (res.code === '20002' || res.code === '20022') { body = body.replace(/shitcoin/gi, 'trash coin'); res = await send(body); } // sensitive word → softer wording
  } catch (e) { res = { code: 'FETCH', message: e.message }; }
  const ok = res.code === '000000';
  const out = { ts: Date.now(), kind, pos: id, ok, code: res.code, message: res.message || null, postId: res.data?.id || null, url: res.data?.id ? `https://www.binance.com/square/post/${res.data.id}` : null };
  try { await db.put('square', `${String(out.ts).padStart(15, '0')}_${id}_${kind}`, out); } catch {}
  return out;
}

// ---------- coin record ----------
async function record(symbol, upto = Infinity) {
  let tr = [];
  try { tr = (await db.list('trade')).filter((x) => x.symbol === symbol && x.closedAt <= upto); } catch {}
  const n = tr.length, L = tr.filter((x) => x.side === 'LONG').length;
  const w = tr.filter((x) => x.net > 0), gw = w.reduce((a, x) => a + x.net, 0), gl = -tr.filter((x) => x.net <= 0).reduce((a, x) => a + x.net, 0);
  const pf = gl ? gw / gl : (n ? Infinity : null);
  let cat = 'new';
  if (n && n < 3) cat = 'early';
  else if (n >= 3) cat = pf === Infinity ? 'perfect' : pf >= 2 ? 'star' : pf >= 1.2 ? 'solid' : pf >= 0.8 ? 'flip' : pf >= 0.4 && w.length ? 'headache' : 'shit';
  return { tag: `$${coin(symbol)}`, n, L, S: n - L, wr: n ? Math.round((w.length / n) * 100) : 0, pf, cat };
}

const recEN = (r) => {
  if (!r.n) return { line: pick([`First time trading ${r.tag} here.`, `New coin for me, no history on ${r.tag} yet.`]), v: '' };
  const side = [r.L && `${r.L} long`, r.S && `${r.S} short`].filter(Boolean).join(' / ');
  const pf = r.pf === Infinity ? 'no losing trade yet' : `profit factor ${EN(r.pf, 2)}`;
  const s = r.n > 1 ? 's' : '';
  const v = {
    early: [`Too early to judge ${r.tag}.`, `Not enough trades to call ${r.tag} yet.`],
    perfect: [`${r.tag} is my star so far ⭐`, `Can't lose on ${r.tag} lately 🌟`],
    star: [`${r.tag} = star coin for me ⭐`, `${r.tag} keeps paying, star material ⭐`],
    solid: [`${r.tag} is a solid one 👍`, `${r.tag} treats me well 👍`],
    flip: [`${r.tag} is a coin flip so far 🪙`, `${r.tag} = pure coin flip for me 🪙`],
    headache: [`${r.tag} gives me headaches 🤕`, `${r.tag} and me don't get along 🤕`],
    shit: [`${r.tag} = certified shitcoin for me 💩`, `${r.tag} is a shitcoin in my book 💩`],
  }[r.cat];
  return { v: pick(v), line: pick([`My ${r.tag} record so far: ${r.n} trade${s} (${side}), ${r.wr}% win rate, ${pf}.`, `${r.tag} track record: ${r.n} trade${s}, ${side}, won ${r.wr}% of them, ${pf}.`]) };
};
const recTR = (r) => {
  if (!r.n) return { line: `${r.tag} ile ilk işlemim.`, v: '' };
  const side = [r.L && `${r.L} long`, r.S && `${r.S} short`].filter(Boolean).join(' / ');
  const pf = r.pf === Infinity ? 'henüz zararlı işlem yok' : `profit factor ${TR(r.pf, 2)}`;
  const v = { early: `${r.tag} için karar vermek erken.`, perfect: `${r.tag} şimdilik yıldızım ⭐`, star: `${r.tag} benim yıldız coinim ⭐`,
    solid: `${r.tag} sağlam çıkıyor 👍`, flip: `${r.tag} şimdilik yazı tura 🪙`, headache: `${r.tag} baş ağrıtıyor 🤕`, shit: `${r.tag} benim için tam bir shitcoin 💩` }[r.cat];
  return { v, line: `${r.tag} geçmişim: ${r.n} işlem (${side}), kazanma oranı %${r.wr}, ${pf}.` };
};

// ---------- texts ----------
function openEN(p, r) {
  const t = r.tag, up = p.side === 'LONG', rc = recEN(r);
  const hook = up
    ? pick([`${t} still has legs, going long here 🚀`, `Longing ${t}. Momentum hasn't cooled off yet 🔥`, `${t} keeps pushing, I'm in long 📈`, `Taking a long on ${t}, volume is there 👀`, `${t} looks like it wants more. Long 💪`])
    : pick([`${t} is bleeding, shorting it 🩸`, `Short ${t}. No bounce in sight yet 📉`, `${t} keeps dumping, I'm short 🔻`, `Opened a short on ${t}, sellers in control 🐻`, `${t} looks weak. Short 👇`]);
  const plan = pick([`Entry ${EN(p.entry)}, stop ${EN(p.sl)}, target ${EN(p.tp)}.`, `In at ${EN(p.entry)}. Stop ${EN(p.sl)} (${EN(p.sl_pct, 1)}%), TP ${EN(p.tp)} (${EN(p.tp_pct, 1)}%).`, `${EN(p.entry)} entry, invalidation ${EN(p.sl)}, aiming for ${EN(p.tp)}.`]);
  const tail = pick([`Small size, ${p.lev}x, paper account.`, `${p.lev}x isolated, tiny size, paper.`, `Paper trade, ${p.lev}x. Let's see 🤞`, `${p.lev}x on the paper account. We'll see how it plays out 🍿`]);
  return [hook, plan, tail, rc.line, rc.v].filter(Boolean);
}
function openTR(p, r) {
  const t = r.tag, up = p.side === 'LONG', rc = recTR(r);
  return [`${t} ${up ? 'LONG açtım, momentum sürüyor 📈' : 'SHORT açtım, satıcılar baskın 📉'}`,
    `Giriş ${TR(p.entry)}, stop ${TR(p.sl)} (%${TR(p.sl_pct, 1)}), hedef ${TR(p.tp)} (%${TR(p.tp_pct, 1)}).`,
    `${p.lev}x, küçük pozisyon, kağıt hesap.`, rc.line, rc.v].filter(Boolean);
}
function closeEN(t, r) {
  const tag = r.tag, n = `${sgn(EN, t.net, 4)} USDT`, rc = recEN(r);
  let line;
  if (t.exitReason === 'TP') line = pick([`${tag} hit the target 🎯 That's the one. ${n}`, `There it is ✅ ${tag} tagged TP. ${n}`, `Called it on ${tag} 😎 TP filled, ${n}`, `${tag} played out exactly like I wanted 🙌 ${n}`]);
  else if (t.exitReason === 'STOP' || t.exitReason === 'LİKİDASYON') line = t.holdMin <= 15
    ? pick([`Ugh 😩 ${tag} wicked me out in ${t.holdMin} min. ${n}`, `${tag} stopped out almost instantly 🤦 Stop was too tight. ${n}`, `Well that was fast 😅 ${tag} took my stop in ${t.holdMin} min. ${n}`])
    : pick([`${tag} didn't work out 😕 Thought it would go, it didn't. ${n}`, `Stopped out on ${tag} ❌ Wrong call. ${n}`, `${tag} turned on me 🙃 stop hit. ${n}`, `Not this time 🤷 ${tag} stop got taken. ${n}`]);
  else if (t.exitReason === 'SÜRE') line = pick([`${tag} went nowhere 😴 closed it on time. ${n}`, `Ran out of patience on ${tag} ⏳ time exit. ${n}`]);
  else line = pick([`Closed ${tag} manually. ${n}.`, `Got out of ${tag} early. ${n}.`]);
  const detail = pick([`${EN(t.entry)} → ${EN(t.exit)} (${EN(pct(t.entry, t.exit), 1)}%), held ${t.holdMin} min.`, `Entry ${EN(t.entry)}, out ${EN(t.exit)}. ${t.holdMin} min in the trade.`]);
  const after = t.net > 0 ? pick([`On to the next 💪`, `Taking it.`, `Good one 🍀`]) : pick([`Part of the game.`, `Next one 👊`, `Losses are logged too.`]);
  return [line, detail, after, rc.line, rc.v].filter(Boolean);
}
function closeTR(t, r) {
  const tag = r.tag, n = `${sgn(TR, t.net, 4)} USDT`, rc = recTR(r);
  const line = t.exitReason === 'TP' ? `${tag} hedefe ulaştı 🎯 İşte bu! ${n}`
    : t.exitReason === 'STOP' || t.exitReason === 'LİKİDASYON' ? (t.holdMin <= 15 ? `Tüh 😩 ${tag} ${t.holdMin} dakikada stopa değdi. ${n}` : `${tag} tutmadı 😕 Buraya gider dedim, olmadı. ${n}`)
    : t.exitReason === 'SÜRE' ? `${tag} yerinde saydı 😴 süre dolunca kapattım. ${n}` : `${tag} pozisyonunu elle kapattım. ${n}`;
  return [line, `${TR(t.entry)} → ${TR(t.exit)} (%${TR(pct(t.entry, t.exit), 1)}), ${t.holdMin} dakika tuttum.`, t.net > 0 ? 'Sıradaki 💪' : 'Oyunun parçası.', rc.line, rc.v].filter(Boolean);
}

// ---------- Agent Resume feed entry (team-feed/SCHEMA.md) ----------
async function feed(kind, x, en, tr, ts) {
  const day = new Date(ts).toISOString().slice(0, 10);
  const id = `${day}-trade-${x.id.toLowerCase()}-${kind}`;
  const post = {
    id, topic: 'crypto', agent: AGENT, posted_at: new Date(ts).toISOString().replace(/\.\d+Z$/, 'Z'),
    title: en[0].slice(0, 80), hook: en[1], body: [en.slice(2).join(' ')],
    meaning: 'What it means: this is a paper trade with real fees, slippage and funding counted, so the coin\'s running record matters more than any single trade.',
    tags: ['Crypto', coin(x.symbol), x.side === 'LONG' ? 'Long' : 'Short', 'Paper trading'],
    sources: [{ title: `Binance USDT-M Futures: ${x.symbol}`, url: `https://www.binance.com/en/futures/${x.symbol}`, date: day }],
    media: null, more: null, linkedin: null, reviewed: false, comments: [],
    tr: { title: tr[0].slice(0, 80), hook: tr[1], body: [tr.slice(2).join(' ')], meaning: 'Ne anlama geliyor: komisyon, kayma ve funding dahil kağıt üzerinde bir işlem; tek işlemden çok coinin birikmiş karnesi önemli.' },
  };
  try { await db.put('feed', id, post); } catch {}
  return id;
}

async function onOpen(p) {
  const r = await record(p.symbol), en = openEN(p, r);
  await feed('open', p, en, openTR(p, r), p.openedAt);
  return square('open', p.id, [...en, `${r.tag} #trading #crypto #papertrading`].join('\n'));
}
async function onClose(t) {
  const r = await record(t.symbol), en = closeEN(t, r);
  await feed('close', t, en, closeTR(t, r), t.closedAt);
  return square('close', t.id, [...en, `${r.tag} #trading #crypto #papertrading`].join('\n'));
}

// Feed list; trades and positions from before the feed existed are backfilled once and stored.
async function feedList() {
  const stored = await db.list('feed');
  const have = new Set(stored.map((x) => x.id));
  const fid = (ts, id, kind) => `${new Date(ts).toISOString().slice(0, 10)}-trade-${id.toLowerCase()}-${kind}`;
  const [trades, open] = await Promise.all([db.list('trade'), db.list('pos')]);
  for (const t of trades) {
    if (!have.has(fid(t.openedAt, t.id, 'open'))) { const r = await record(t.symbol, t.openedAt); await feed('open', { ...t, lev: t.lev }, openEN(t, r), openTR(t, r), t.openedAt); }
    if (!have.has(fid(t.closedAt, t.id, 'close'))) { const r = await record(t.symbol, t.closedAt); await feed('close', t, closeEN(t, r), closeTR(t, r), t.closedAt); }
  }
  for (const p of open) if (!have.has(fid(p.openedAt, p.id, 'open'))) { const r = await record(p.symbol, p.openedAt); await feed('open', p, openEN(p, r), openTR(p, r), p.openedAt); }
  return (await db.list('feed')).sort((a, b) => (a.posted_at < b.posted_at ? 1 : -1)).slice(0, 60);
}

// Manual catch-up: post open/close events of the last `sinceH` hours that have no successful Square post yet.
async function postRecent(sinceH = 1.5) {
  const from = Date.now() - sinceH * 3.6e6;
  const [log, trades, open] = await Promise.all([db.list('square').catch(() => []), db.list('trade'), db.list('pos')]);
  const done = new Set(log.filter((x) => x.ok).map((x) => `${x.pos}_${x.kind}`));
  const out = [];
  const ev = [
    ...trades.filter((t) => t.openedAt >= from).map((t) => ({ ts: t.openedAt, kind: 'open', id: t.id, run: () => onOpen({ ...t, sl_pct: pct(t.entry, t.sl), tp_pct: pct(t.entry, t.tp) }) })),
    ...open.filter((p) => p.openedAt >= from).map((p) => ({ ts: p.openedAt, kind: 'open', id: p.id, run: () => onOpen({ ...p, sl_pct: pct(p.entry, p.sl), tp_pct: pct(p.entry, p.tp) }) })),
    ...trades.filter((t) => t.closedAt >= from).map((t) => ({ ts: t.closedAt, kind: 'close', id: t.id, run: () => onClose(t) })),
  ].sort((a, b) => a.ts - b.ts);
  for (const e of ev) {
    if (done.has(`${e.id}_${e.kind}`)) { out.push({ id: e.id, kind: e.kind, skipped: 'already posted' }); continue; }
    out.push({ id: e.id, kind: e.kind, ...(await e.run()) });
  }
  return { since_h: sinceH, events: out.length, results: out };
}

module.exports = { postOpen: onOpen, postClose: onClose, feedList, postRecent, _t: { openEN, openTR, closeEN, closeTR, record, recEN } };
