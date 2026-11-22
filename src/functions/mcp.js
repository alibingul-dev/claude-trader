// Stateless MCP server (Streamable HTTP, JSON responses) at /api/mcp/{token}
const { app } = require('@azure/functions');
const eng = require('../lib/engine');

const TOOLS = [
  {
    name: 'hour_close',
    description:
      'Saatlik koşunun İLK çağrısı. Açık pozisyonları son kontrolden bu yana 1 dakikalık mumlarla dakika dakika oynatır (stop/TP/likidasyon/süre, funding), kapananları loglar, equity kaydı atar; ardından BTC + en hareketli USDT-M coinlerin kısa piyasa özetini döner.',
    inputSchema: { type: 'object', properties: {} },
    run: () => eng.hourClose(),
  },
  {
    name: 'open_position',
    description:
      'Gerçek parayla açılmış gibi sanal pozisyon açar: mark fiyat + %0,05 kayma, %0,05 taker fee, isolated margin. Notional 6 USDT’den başlar, equity büyüdükçe büyür. Kaldıraç otomatik: stop likidasyon mesafesinin içinde kalan en yüksek kaldıraç (≤ DEFAULT_MAX_LEV). Hayatta kalma kuralı: serbest bakiye ≥ 10 stop zararı.',
    inputSchema: {
      type: 'object',
      required: ['symbol', 'side', 'sl_pct', 'tp_pct', 'reason'],
      properties: {
        symbol: { type: 'string', description: 'ör. SOLUSDT' },
        side: { type: 'string', enum: ['LONG', 'SHORT'] },
        sl_pct: { type: 'number', description: 'Girişe göre stop mesafesi, % (0,3–10)' },
        tp_pct: { type: 'number', description: 'Girişe göre TP mesafesi, %' },
        max_hold_h: { type: 'number', description: 'En uzun tutma süresi, saat (varsayılan 24)' },
        reason: { type: 'string', description: 'Giriş gerekçesi, kısa' },
      },
    },
    run: (a) => eng.openPosition(a),
  },
  {
    name: 'skip_position',
    description:
      'Değerlendirip AÇMADIĞIN her aday için çağır. open_position ile aynı giriş, kaldıraç, fee ve likidasyon hesabıyla gölge pozisyon kaydeder; kasaya dokunmaz. hour_close her saat bunları da 1m mumlarla izler, "açsaydım ne olurdu" sonucunu ayrı tabloya yazar.',
    inputSchema: {
      type: 'object',
      required: ['symbol', 'side', 'sl_pct', 'tp_pct', 'reason'],
      properties: {
        symbol: { type: 'string', description: 'ör. SOLUSDT' },
        side: { type: 'string', enum: ['LONG', 'SHORT'] },
        sl_pct: { type: 'number', description: 'Açsaydın kullanacağın stop, % (0,3–10)' },
        tp_pct: { type: 'number', description: 'Açsaydın kullanacağın TP, %' },
        max_hold_h: { type: 'number', description: 'En uzun tutma süresi, saat (varsayılan 24)' },
        reason: { type: 'string', description: 'Neden açmadın, kısa (hangi koşul tutmadı ya da hangi risk)' },
      },
    },
    run: (a) => eng.skipPosition(a),
  },
  {
    name: 'square_post',
    description: 'Kuyrukta bekleyen açılış/kapanış olaylarını hemen tek toplu post olarak Square ve Agent Resume\'a gönderir (normalde log_decision bunu kendisi yapar).',
    inputSchema: { type: 'object', properties: {} },
    run: async () => { const s = await eng.performance(); return require('../lib/square').flushDigest(s.wallet_usdt); },
  },
  {
    name: 'close_position',
    description: 'Açık pozisyonu mark fiyattan kapatır (önce aradaki 1m mumlarda stop/TP olmuş mu kontrol eder).',
    inputSchema: {
      type: 'object',
      required: ['id', 'reason'],
      properties: { id: { type: 'string', description: 'ör. P12' }, reason: { type: 'string' } },
    },
    run: (a) => eng.closePosition(a),
  },
  {
    name: 'log_decision',
    description: 'Saatin kararını ve gerekçesini dashboard karar günlüğüne yazar. Her koşunun SON çağrısı. Metin herkese açık sitede yayınlanır: kısaltmasız, sade dille yaz.',
    inputSchema: {
      type: 'object',
      required: ['summary'],
      properties: {
        summary: { type: 'string', description: 'Bu saatin kararı ve nedeni, 1–3 cümle. SADE DİL: ilk kez okuyan anlasın; ch1h/ch4h/ch24/vr/rng/fund/atr1h/MFE kısaltmalarını YAZMA. Örnek: "BTC ch1h −0,59 %" yerine "BTC son 1 saatte %0,59 düştü"; "vr 1,3" yerine "hacim ortalamanın 1,3 katı"; "rng 0,85" yerine "fiyat 24 saatlik aralığın tepesine yakın". Biçim aynı kalır: "Gördüm: … | Karar: … | Beklenti: … || EN: Saw: … | Decision: … | Expectation: …" (EN kısmı da sade).' },
        actions: { type: 'array', items: { type: 'string' }, description: 'ör. ["OPEN P12 SOLUSDT LONG", "HOLD P11"]' },
      },
    },
    run: (a) => eng.logDecision(a),
  },
  {
    name: 'performance',
    description: 'Kasa, getiri %, max drawdown %, n, BSR %, WSR %, PF, net/fee/funding USDT, sürüm kırılımı, son 10 işlem.',
    inputSchema: { type: 'object', properties: { version: { type: 'string', description: 'Opsiyonel: yalnız bu sürüm' } } },
    run: (a) => eng.performance(a),
  },
  {
    name: 'add_lab_strategy',
    description:
      'Laboratuvara yeni ADAY strateji ekler (kod gerekmez). hour_close bundan sonra her saat bu kuralı piyasa özetine uygular, tutan adayları kasaya dokunmadan gölgede izler; sonuç performance.lab[id] altında. Koşul: [alan, op, değer]; alanlar px, ch24, ch4h, ch1h (%), atr1h (%), vr, rng (0..1), fund (%/8h), qvM (M USDT); BTC için "btc." öneki (ör. btc.ch1h). op: > >= < <= == !=. Bir listedeki koşulların hepsi tutmalı (VE). En fazla 6 aktif aday; elenen 4 aile (spike fade/follow, Bollinger ortalamaya dönüş, funding fade, SMC) tekrar eklenmez.',
    inputSchema: {
      type: 'object',
      required: ['id', 'desc', 'exit', 'hypothesis'],
      properties: {
        id: { type: 'string', description: 'L-xxx (küçük harf, rakam, tire)' },
        desc: { type: 'string', description: 'Kuralın tek satır özeti' },
        long: { type: 'array', items: { type: 'array' }, description: 'LONG koşulları, ör. [["ch1h",">",1],["vr",">=",2],["btc.ch1h",">",0]]' },
        short: { type: 'array', items: { type: 'array' }, description: 'SHORT koşulları' },
        exit: {
          type: 'object',
          required: ['sl_atr_k', 'sl_min', 'sl_max', 'tp_mult', 'max_hold_h'],
          properties: {
            sl_atr_k: { type: 'number', description: 'SL = atr1h × k' },
            sl_min: { type: 'number', description: 'SL alt sınırı, % (≥ 0,3)' },
            sl_max: { type: 'number', description: 'SL üst sınırı, % (≤ 10)' },
            tp_mult: { type: 'number', description: 'TP = SL × bu çarpan' },
            max_hold_h: { type: 'number', description: 'En uzun tutma, saat (≤ 72)' },
          },
        },
        cooldown_h: { type: 'number', description: 'Aynı coine tekrar giriş beklemesi, saat (varsayılan 12)' },
        hypothesis: { type: 'string', description: 'Neden kazanmalı; hangi teşhise (giriş yönü / çıkış / maliyet) cevap veriyor' },
      },
    },
    run: (a) => eng.addLabStrategy(a),
  },
  {
    name: 'retire_lab_strategy',
    description: 'Eklenmiş bir adayı emekli eder: yeni tarama durur, geçmiş sonuçları performance.lab içinde kalır. Yerleşik sürümler (v1, v2, L-wide, L-btc) emekli edilemez.',
    inputSchema: {
      type: 'object',
      required: ['id', 'reason'],
      properties: { id: { type: 'string' }, reason: { type: 'string', description: 'n, PF, net ile gerekçe' } },
    },
    run: (a) => eng.retireLabStrategy(a),
  },
  {
    name: 'get_strategy',
    description: 'Geçerli strateji sürümünün kuralları ve sürüm geçmişi.',
    inputSchema: { type: 'object', properties: {} },
    run: () => eng.getStrategy(),
  },
  {
    name: 'set_strategy',
    description: 'Yeni strateji sürümü kaydeder ve geçerli yapar. Sonraki işlemler bu sürümle etiketlenir.',
    inputSchema: {
      type: 'object',
      required: ['version', 'rules', 'reason'],
      properties: {
        version: { type: 'string', description: 'v1, v2, v2.1 …' },
        rules: { type: 'string', description: 'Giriş/çıkış/boyut kuralları, tam metin' },
        reason: { type: 'string', description: 'Revizyon gerekçesi ve kanıtı (n, PF, WSR …)' },
      },
    },
    run: (a) => eng.setStrategy(a),
  },
];

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(m, ctx) {
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return err(m?.id ?? null, -32600, 'invalid request');
  if (m.id === undefined || m.id === null) return null; // notification
  switch (m.method) {
    case 'initialize':
      return ok(m.id, {
        protocolVersion: m.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'claude-trader', version: '1.0.0' },
        instructions: 'Binance USDT-M paper trader. Her saat: hour_close → (gerekirse open/close) → log_decision.',
      });
    case 'ping':
      return ok(m.id, {});
    case 'tools/list':
      return ok(m.id, { tools: TOOLS.map(({ run, ...t }) => t) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === m.params?.name);
      if (!tool) return err(m.id, -32602, `unknown tool ${m.params?.name}`);
      try {
        const res = await tool.run(m.params?.arguments || {});
        return ok(m.id, { content: [{ type: 'text', text: JSON.stringify(res) }] });
      } catch (e) {
        ctx.warn(`tool ${tool.name} failed: ${e.message}`);
        return ok(m.id, { content: [{ type: 'text', text: `HATA: ${e.message}` }], isError: true });
      }
    }
    default:
      return err(m.id, -32601, `method not found: ${m.method}`);
  }
}

app.http('mcp', {
  methods: ['POST', 'GET', 'DELETE'],
  authLevel: 'anonymous',
  route: 'mcp/{token}',
  handler: async (req, ctx) => {
    if (!process.env.MCP_TOKEN || req.params.token !== process.env.MCP_TOKEN) return { status: 401, body: 'unauthorized' };
    if (req.method !== 'POST') return { status: 405, headers: { Allow: 'POST' } };
    let body;
    try {
      body = await req.json();
    } catch {
      return { status: 400, jsonBody: err(null, -32700, 'parse error') };
    }
    const msgs = Array.isArray(body) ? body : [body];
    const out = [];
    for (const m of msgs) {
      const r = await handle(m, ctx);
      if (r) out.push(r);
    }
    if (!out.length) return { status: 202 };
    return { status: 200, jsonBody: Array.isArray(body) ? out : out[0] };
  },
});
