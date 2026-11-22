// Paper trade engine: positions behave as if opened with real money on Binance USDT-M isolated margin.
// Units: prices in USDT, amounts in USDT, percentages in %.
const bn = require('./binance');
const db = require('./store');
const square = require('./square');

const CFG = {
  fee: +(process.env.TAKER_FEE ?? 0.0005), // 0.05 % taker, per side
  slip: +(process.env.SLIPPAGE ?? 0.0005), // 0.05 % adverse fill, per side
  mmr: +(process.env.MMR ?? 0.005), // maintenance margin rate
  liqBuffer: 0.002, // SL must sit at least 0.2 % inside the liquidation distance
  maxLev: +(process.env.DEFAULT_MAX_LEV ?? 50),
  startWallet: +(process.env.START_WALLET ?? 10),
  baseNotional: +(process.env.BASE_NOTIONAL ?? 6),
  maxOpen: +(process.env.MAX_OPEN ?? 3),
  minQv: +(process.env.MIN_QV_M ?? 50) * 1e6,
  topN: +(process.env.TOP_N ?? 10),
  survivalStops: 10, // gambler-core rule 8
};

const MIN = 60_000;
const rd = (x, d = 4) => (x == null || !isFinite(x) ? x : Math.round(x * 10 ** d) / 10 ** d);
const pad = (n) => String(n).padStart(15, '0');

// ---------- state ----------
async function getState() {
  let s = await db.getOne('state', 'main');
  if (!s) {
    s = { wallet: CFG.startWallet, startWallet: CFG.startWallet, version: 'v0', createdAt: Date.now(), seq: 0 };
    await db.put('state', 'main', s);
  }
  return s;
}

const notionalFor = (s, equity) =>
  Math.max(CFG.baseNotional, Math.floor((CFG.baseNotional * equity) / s.startWallet));

// Highest leverage whose liquidation distance still contains the stop (isolated margin).
function leverageFor(slPct, cap = CFG.maxLev, mmr = CFG.mmr) {
  const lev = Math.floor(1 / (slPct / 100 + mmr + CFG.liqBuffer));
  return Math.max(1, Math.min(cap, lev));
}

// Coin's own max leverage + maintenance margin for this notional (Binance leverageBracket); fallback DEFAULT_MAX_LEV.
async function coinLimits(symbol, notional) {
  try {
    const lb = await bn.leverageBracket(symbol);
    if (!lb) return { cap: CFG.maxLev, mmr: CFG.mmr, src: 'DEFAULT_MAX_LEV' };
    const row = Array.isArray(lb) ? lb.find((x) => x.symbol === symbol) || lb[0] : lb;
    const br = row.brackets.find((b) => notional >= b.notionalFloor && notional < b.notionalCap) || row.brackets[0];
    return { cap: br.initialLeverage, mmr: br.maintMarginRatio, src: 'binance' };
  } catch (e) {
    return { cap: CFG.maxLev, mmr: CFG.mmr, src: `DEFAULT_MAX_LEV (bracket hatası: ${e.message.slice(0, 80)})` };
  }
}

function compactPos(p) {
  const last = p.last ?? p.entry;
  return {
    id: p.id, sym: p.symbol, side: p.side, lev: p.lev,
    entry: rd(p.entry, 8), last: rd(last, 8), sl: rd(p.sl, 8), tp: rd(p.tp, 8), liq: rd(p.liq, 8),
    notional_usdt: rd(p.notional, 2), margin_usdt: rd(p.margin, 4),
    upnl_usdt: rd(p.qty * (last - p.entry) * p.dir + p.funding - p.feeIn, 4),
    mfe_pct: rd(p.mfe, 2), mae_pct: rd(p.mae, 2),
    age_h: rd((Date.now() - p.openedAt) / 3.6e6, 1), openedAt: p.openedAt, version: p.version,
  };
}

// ---------- 1m replay ----------
// Walks closed 1m candles after pos.checkedTs. Returns an exit or null. Same-candle SL+TP => SL (conservative).
function replay(pos, kl, now) {
  const d = pos.dir;
  for (const k of kl) {
    const ot = k[0], o = +k[1], h = +k[2], l = +k[3], c = +k[4], ct = k[6];
    if (ct >= now) break; // candle not closed yet
    if (ot < pos.checkedTs) continue;
    if (ot - pos.openedAt >= pos.maxHoldMs) return { price: o, reason: 'SÜRE', ts: ot };
    const adverse = d === 1 ? l : h;
    const favorable = d === 1 ? h : l;
    pos.mfe = Math.max(pos.mfe, (d * (favorable - pos.entry) / pos.entry) * 100);
    pos.mae = Math.min(pos.mae, (d * (adverse - pos.entry) / pos.entry) * 100);
    const hitSL = d === 1 ? l <= pos.sl : h >= pos.sl;
    const hitTP = d === 1 ? h >= pos.tp : l <= pos.tp;
    if (hitSL) {
      const gap = d === 1 ? o <= pos.sl : o >= pos.sl;
      const px = gap ? o : pos.sl;
      const beyondLiq = d === 1 ? px <= pos.liq : px >= pos.liq;
      return { price: px, reason: beyondLiq ? 'LİKİDASYON' : 'STOP', ts: ot };
    }
    if (hitTP) {
      const gap = d === 1 ? o >= pos.tp : o <= pos.tp;
      return { price: gap ? o : pos.tp, reason: 'TP', ts: ot };
    }
    pos.checkedTs = ct + 1;
    pos.last = c;
  }
  return null;
}

async function klinesSince(symbol, start, now) {
  const out = [];
  let t = Math.ceil(start / MIN) * MIN;
  while (t < now - MIN) {
    const batch = await bn.klines(symbol, '1m', { startTime: t, limit: 1500 });
    if (!batch.length) break;
    out.push(...batch);
    t = batch[batch.length - 1][0] + MIN;
    if (batch.length < 1500) break;
  }
  return out;
}

async function applyFunding(pos, s, endTs) {
  if (endTs <= pos.fundingCheckedTs) return;
  const fr = await bn.fundingRate(pos.symbol, pos.fundingCheckedTs + 1, endTs);
  for (const f of fr) {
    if (f.fundingTime <= pos.fundingCheckedTs || f.fundingTime > endTs) continue;
    const px = +f.markPrice || pos.last || pos.entry;
    const pay = -pos.dir * +f.fundingRate * pos.qty * px; // long pays a positive rate
    pos.funding += pay;
    s.wallet += pay;
  }
  pos.fundingCheckedTs = endTs;
}

async function settle(pos, exit, s, book = REAL) {
  const liq = exit.reason === 'LİKİDASYON';
  const px = liq ? pos.liq : exit.price * (1 - pos.dir * CFG.slip);
  let gross = pos.qty * (px - pos.entry) * pos.dir;
  let feeOut = pos.qty * px * CFG.fee;
  if (liq) { gross = -pos.margin; feeOut = 0; } // isolated: the whole margin is gone
  s.wallet += gross - feeOut;
  const net = gross - pos.feeIn - feeOut + pos.funding;
  const t = {
    id: pos.id, symbol: pos.symbol, side: pos.side, lev: pos.lev, version: pos.version, reason: pos.reason,
    openedAt: pos.openedAt, closedAt: exit.ts, holdMin: Math.round((exit.ts - pos.openedAt) / MIN),
    entry: pos.entry, exit: px, sl: pos.sl, tp: pos.tp, sl_pct: pos.sl_pct, tp_pct: pos.tp_pct,
    qty: pos.qty, notional: pos.notional, margin: pos.margin,
    gross, feeIn: pos.feeIn, feeOut, funding: pos.funding, net,
    roiMarginPct: (net / pos.margin) * 100, mfe: pos.mfe, mae: pos.mae,
    exitReason: exit.reason, walletAfter: s.wallet,
  };
  await db.put(book.trade, `${pad(exit.ts)}_${pos.id}`, t);
  await db.del(book.pos, pos.id);
  if (book === REAL) t.square = await square.postClose(t);
  return t;
}

const REAL = { pos: 'pos', trade: 'trade' };
const SHADOW = { pos: 'spos', trade: 'strade' }; // skipped candidates: same simulation, never touches the wallet

async function processPos(pos, s, now, book = REAL) {
  const kl = await klinesSince(pos.symbol, pos.checkedTs, now);
  const exit = replay(pos, kl, now);
  await applyFunding(pos, s, exit ? exit.ts : now);
  if (exit) return settle(pos, exit, s, book);
  await db.put(book.pos, pos.id, pos);
  return null;
}

const compactTrade = (t) => ({
  id: t.id, sym: t.symbol, side: t.side, exit_reason: t.exitReason, hold_min: t.holdMin,
  net_usdt: rd(t.net, 4), roi_margin_pct: rd(t.roiMarginPct, 1), mfe_pct: rd(t.mfe, 2), version: t.version,
  ...(t.square ? { square: t.square.ok ? t.square.url || 'ok' : t.square.skipped || `HATA ${t.square.code}` } : {}),
});

// ---------- market snapshot ----------
async function snapshot() {
  const [tk, pr] = await Promise.all([bn.ticker24h(), bn.premiumAll()]);
  const fund = new Map(pr.map((p) => [p.symbol, +p.lastFundingRate]));
  const cands = tk
    .filter((t) => t.symbol.endsWith('USDT') && fund.has(t.symbol) && +t.quoteVolume >= CFG.minQv)
    .sort((a, b) => Math.abs(+b.priceChangePercent) - Math.abs(+a.priceChangePercent))
    .slice(0, CFG.topN);
  const bySym = new Map(tk.map((t) => [t.symbol, t]));
  const syms = ['BTCUSDT', ...cands.map((c) => c.symbol).filter((x) => x !== 'BTCUSDT')];
  return Promise.all(
    syms.map(async (sym) => {
      const k = await bn.klines(sym, '1h', { limit: 26 });
      const done = k.slice(0, -1); // completed 1h bars
      const cl = done.map((x) => +x[4]);
      const last = +k[k.length - 1][4];
      const n = cl.length;
      let tr = 0;
      for (let i = n - 14; i < n; i++) {
        const h = +done[i][2], l = +done[i][3], pc = +done[i - 1][4];
        tr += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)) / pc;
      }
      const qv = done.map((x) => +x[7]);
      const avgQv = qv.slice(0, -1).reduce((a, b) => a + b, 0) / (qv.length - 1);
      const t = bySym.get(sym);
      const hi = +t.highPrice, lo = +t.lowPrice;
      return {
        s: sym, px: last,
        ch24: rd(+t.priceChangePercent, 2),
        ch4h: rd((last / cl[n - 4] - 1) * 100, 2),
        ch1h: rd((last / cl[n - 1] - 1) * 100, 2),
        atr1h: rd((tr / 14) * 100, 2),
        vr: rd(qv[n - 1] / avgQv, 2),
        rng: rd(hi > lo ? (last - lo) / (hi - lo) : 0.5, 2),
        fund: rd(fund.get(sym) * 100, 4),
        qvM: rd(+t.quoteVolume / 1e6, 0),
      };
    })
  );
}

// ---------- tools ----------
async function hourClose() {
  const s = await getState();
  const now = Date.now();
  const closed = [];
  for (const pos of await db.list('pos')) {
    const t = await processPos(pos, s, now);
    if (t) closed.push(t);
  }
  const ghost = { wallet: 0 };
  const skippedClosed = [];
  for (const sp of await db.list('spos')) {
    const t = await processPos(sp, ghost, now, SHADOW);
    if (t) skippedClosed.push(t);
  }
  const open = await db.list('pos');
  const upnl = open.reduce((a, p) => a + p.qty * ((p.last ?? p.entry) - p.entry) * p.dir, 0);
  const equity = s.wallet + upnl;
  await db.put('state', 'main', s);
  await db.put('equity', pad(now), { ts: now, wallet: s.wallet, equity, open: open.length });
  const market = await snapshot();
  await db.put('market', 'last', { ts: now, market });
  return {
    ts_utc: new Date(now).toISOString(),
    version: s.version,
    wallet_usdt: rd(s.wallet), equity_usdt: rd(equity),
    next_notional_usdt: notionalFor(s, equity), max_open: CFG.maxOpen,
    closed_this_hour: closed.map(compactTrade),
    open: open.map(compactPos),
    skipped_closed_this_hour: skippedClosed.map(compactTrade),
    skipped_open: (await db.list('spos')).map(compactPos),
    market_keys: 'px USDT · ch24/ch4h/ch1h % · atr1h % (14x1h) · vr = son 1h hacim / 24h ort · rng 0..1 = 24h aralıktaki yeri · fund % / 8h · qvM M USDT',
    market,
  };
}

async function openPosition({ symbol, side, sl_pct, tp_pct, max_hold_h = 24, reason = '' }) {
  symbol = String(symbol || '').toUpperCase();
  side = String(side || '').toUpperCase();
  sl_pct = +sl_pct; tp_pct = +tp_pct; max_hold_h = +max_hold_h;
  checkArgs({ symbol, side, sl_pct, tp_pct, max_hold_h });
  const s = await getState();
  if (s.version === 'v0') throw new Error('Önce set_strategy ile bir strateji sürümü kaydet');
  const open = await db.list('pos');
  if (open.length >= CFG.maxOpen) throw new Error(`En fazla ${CFG.maxOpen} açık pozisyon`);
  if (open.some((p) => p.symbol === symbol)) throw new Error(`${symbol} için zaten açık pozisyon var`);

  const { pos, lim } = await buildPos({ symbol, side, sl_pct, tp_pct, max_hold_h, reason }, s, open);
  const free = s.wallet - open.reduce((a, p) => a + p.margin, 0);
  const maxLoss = pos.notional * (sl_pct / 100 + 2 * CFG.fee + 2 * CFG.slip);
  if (free < pos.margin + pos.feeIn) throw new Error(`Serbest bakiye yetersiz: ${rd(free)} USDT`);
  if (free < CFG.survivalStops * maxLoss)
    throw new Error(`Hayatta kalma kuralı: serbest bakiye ${rd(free)} USDT < 10 stop × ${rd(maxLoss)} USDT`);
  s.seq += 1;
  pos.id = `P${s.seq}`;
  s.wallet -= pos.feeIn;
  await db.put('pos', pos.id, pos);
  await db.put('state', 'main', s);
  const sq = await square.postOpen(pos);
  return { opened: { ...compactPos(pos), coin_max_lev: lim.cap, lev_source: lim.src }, wallet_usdt: rd(s.wallet), square: sq };
}

function checkArgs({ symbol, side, sl_pct, tp_pct, max_hold_h }) {
  if (!['LONG', 'SHORT'].includes(side)) throw new Error('side LONG veya SHORT olmalı');
  if (!(sl_pct >= 0.3 && sl_pct <= 10)) throw new Error('sl_pct 0.3–10 % aralığında olmalı');
  if (!(tp_pct > 0)) throw new Error('tp_pct > 0 olmalı');
  if (!(max_hold_h > 0 && max_hold_h <= 72)) throw new Error('max_hold_h 0–72 saat');
  if (!symbol) throw new Error('symbol gerekli');
}

// Same entry, size, leverage, fees and liquidation as a real opening, without balance checks.
async function buildPos({ symbol, side, sl_pct, tp_pct, max_hold_h, reason }, s, open) {
  const [pi, info] = await Promise.all([bn.premium(symbol), bn.exchangeInfo()]);
  const sym = info.symbols.find((x) => x.symbol === symbol);
  if (!sym || sym.status !== 'TRADING' || sym.contractType !== 'PERPETUAL')
    throw new Error(`${symbol} işlem gören bir USDT-M perpetual değil`);
  const minNot = +(sym.filters.find((f) => f.filterType === 'MIN_NOTIONAL')?.notional ?? 5);

  const upnl = open.reduce((a, p) => a + p.qty * ((p.last ?? p.entry) - p.entry) * p.dir, 0);
  const notional = notionalFor(s, s.wallet + upnl);
  if (notional < minNot) throw new Error(`${symbol} minNotional ${minNot} USDT > notional ${notional} USDT`);

  const lim = await coinLimits(symbol, notional);
  const lev = leverageFor(sl_pct, lim.cap, lim.mmr);
  const margin = notional / lev;
  const dir = side === 'LONG' ? 1 : -1;
  const mark = +pi.markPrice;
  const entry = mark * (1 + dir * CFG.slip);
  const qty = notional / entry;
  const feeIn = notional * CFG.fee;
  const now = Date.now();
  const pos = {
    id: '', symbol, side, dir, lev, mark, entry, qty, notional, margin, feeIn, funding: 0,
    sl_pct, tp_pct,
    sl: entry * (1 - (dir * sl_pct) / 100),
    tp: entry * (1 + (dir * tp_pct) / 100),
    liq: entry * (1 - dir * (1 / lev - lim.mmr)),
    coinMaxLev: lim.cap, levSource: lim.src,
    openedAt: now, checkedTs: now, fundingCheckedTs: now, maxHoldMs: max_hold_h * 3.6e6,
    version: s.version, reason: String(reason).slice(0, 500), mfe: 0, mae: 0,
  };
  return { pos, lim };
}

async function skipPosition({ symbol, side, sl_pct, tp_pct, max_hold_h = 24, reason = '' }) {
  symbol = String(symbol || '').toUpperCase();
  side = String(side || '').toUpperCase();
  sl_pct = +sl_pct; tp_pct = +tp_pct; max_hold_h = +max_hold_h;
  checkArgs({ symbol, side, sl_pct, tp_pct, max_hold_h });
  const s = await getState();
  const open = await db.list('pos');
  if ((await db.list('spos')).some((p) => p.symbol === symbol && p.side === side))
    throw new Error(`${symbol} ${side} zaten pas geçilenler listesinde izleniyor`);
  const { pos } = await buildPos({ symbol, side, sl_pct, tp_pct, max_hold_h, reason }, s, open);
  s.sseq = (s.sseq || 0) + 1;
  pos.id = `S${s.sseq}`;
  pos.skipped = true;
  await db.put('spos', pos.id, pos);
  await db.put('state', 'main', s);
  return { skipped: compactPos(pos), note: 'Kasaya dokunmaz; açılsaydı ne olurdu diye 1m mumlarla izlenir.' };
}

async function closePosition({ id, reason = '' }) {
  const s = await getState();
  const pos = await db.getOne('pos', String(id));
  if (!pos) throw new Error(`${id} açık pozisyon değil`);
  const now = Date.now();
  const auto = await processPos(pos, s, now); // a stop/TP may already have hit since the last check
  let t = auto;
  if (!t) {
    const pi = await bn.premium(pos.symbol);
    t = await settle(pos, { price: +pi.markPrice, reason: `MANUEL: ${String(reason).slice(0, 200)}`, ts: now }, s);
  }
  await db.put('state', 'main', s);
  return { closed: compactTrade(t), wallet_usdt: rd(s.wallet) };
}

function stats(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.net > 0);
  const gw = wins.reduce((a, t) => a + t.net, 0);
  const gl = -trades.filter((t) => t.net <= 0).reduce((a, t) => a + t.net, 0);
  let streak = 0, worst = 0;
  for (const t of trades) { streak = t.net > 0 ? 0 : streak + 1; worst = Math.max(worst, streak); }
  return {
    n, net_usdt: rd(gw - gl),
    bsr_pct: n ? rd((wins.length / n) * 100, 1) : null,
    wsr_pct: gw + gl ? rd((gw / (gw + gl)) * 100, 1) : null,
    pf: gl ? rd(gw / gl, 3) : null,
    avg_win_usdt: wins.length ? rd(gw / wins.length) : null,
    avg_loss_usdt: n - wins.length ? rd(-gl / (n - wins.length)) : null,
    fees_usdt: rd(trades.reduce((a, t) => a + t.feeIn + t.feeOut, 0)),
    funding_usdt: rd(trades.reduce((a, t) => a + t.funding, 0)),
    longest_loss_streak: worst,
  };
}

async function performance({ version } = {}) {
  const s = await getState();
  const all = await db.list('trade');
  const trades = version ? all.filter((t) => t.version === version) : all;
  const eq = await db.list('equity');
  let peak = s.startWallet, dd = 0;
  for (const e of eq) { peak = Math.max(peak, e.equity); dd = Math.min(dd, (e.equity / peak - 1) * 100); }
  const byVersion = {};
  for (const t of all) (byVersion[t.version] ??= []).push(t);
  return {
    version_now: s.version, wallet_usdt: rd(s.wallet), start_wallet_usdt: s.startWallet,
    return_pct: rd((s.wallet / s.startWallet - 1) * 100, 2), max_drawdown_pct: rd(dd, 2),
    filter: version || 'all', ...stats(trades),
    by_version: Object.fromEntries(Object.entries(byVersion).map(([v, ts]) => [v, stats(ts)])),
    last10: trades.slice(-10).map(compactTrade),
  };
}

async function logDecision({ summary, actions = [] }) {
  const s = await getState();
  const now = Date.now();
  await db.put('decision', pad(now), {
    ts: now, version: s.version, summary: String(summary || '').slice(0, 2000),
    actions: Array.isArray(actions) ? actions.slice(0, 20).map(String) : [String(actions)],
  });
  // End-of-day recap for the previous Istanbul day, folded into this run's single post (first run after midnight).
  let eod = null;
  try {
    const dk = (ms) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Istanbul' });
    const yday = dk(now - 864e5);
    if (!s.lastEodDay) { s.lastEodDay = yday; await db.put('state', 'main', s); }
    else if (s.lastEodDay < yday) {
      const tr = (await db.list('trade')).filter((t) => dk(t.closedAt) === yday);
      eod = square.eodLines(yday, tr, s.wallet, (await db.list('pos')).length, s.startWallet);
      s.lastEodDay = yday; await db.put('state', 'main', s);
    }
  } catch (e) { eod = null; }
  let digest; // one Square + Agent Resume post for all opens/closes of this run
  try { digest = await square.flushDigest(s.wallet, eod); } catch (e) { digest = { error: e.message }; }
  return { logged: true, ts_utc: new Date(now).toISOString(), digest };
}

async function setStrategy({ version, rules, reason = '' }) {
  if (!/^v\d+(\.\d+)?$/.test(String(version))) throw new Error('version biçimi v1, v2, v2.1 …');
  if (!rules || String(rules).length < 20) throw new Error('rules en az 20 karakter');
  const s = await getState();
  if (await db.getOne('strategy', version)) throw new Error(`${version} zaten var; yeni numara ver`);
  const prev = s.version;
  await db.put('strategy', version, {
    version, prev, rules: String(rules).slice(0, 8000), reason: String(reason).slice(0, 2000), at: Date.now(),
  });
  s.version = version;
  await db.put('state', 'main', s);
  return { version_now: version, prev };
}

async function getStrategy() {
  const s = await getState();
  const all = await db.list('strategy');
  return {
    current: all.find((x) => x.version === s.version) || null,
    history: all.map((x) => ({ version: x.version, at_utc: new Date(x.at).toISOString(), reason: x.reason })),
  };
}

async function dashboardData() {
  const [state, pos, trades, equity, decisions, strategies, market, spos, strades] = await Promise.all([
    getState(), db.list('pos'), db.list('trade'), db.list('equity'), db.list('decision'), db.list('strategy'),
    db.getOne('market', 'last'), db.list('spos'), db.list('strade'),
  ]);
  return {
    generated_utc: new Date().toISOString(),
    config: { ...CFG, minQv: undefined, minQv_musdt: CFG.minQv / 1e6 },
    state, open: pos.map(compactPos), trades, equity: equity.slice(-3000),
    decisions: decisions.slice(-300), strategies, market,
    skipped_open: spos.map(compactPos), skipped: strades.slice(-1000),
  };
}

module.exports = {
  hourClose, openPosition, skipPosition, closePosition, performance, logDecision, setStrategy, getStrategy, dashboardData,
  _test: { replay, leverageFor, notionalFor, CFG },
};
