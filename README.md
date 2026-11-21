# Claude Trader — Binance USDT-M intraday forward test

Claude her saat MCP üzerinden piyasayı okur, sanal pozisyon açar/kapatır ve stratejisini revize eder. Pozisyonlar gerçek parayla açılmış gibi işler: mark fiyat, %0,05 kayma, %0,05 taker fee, funding, isolated margin, likidasyon. Stop/TP saat içinde 1 dakikalık mumlarla dakika dakika kontrol edilir.

## Kurallar (Ali)
1. Notional 6 USDT ile başlar, equity büyüdükçe büyür: `notional = max(6, floor(6 × equity / başlangıç kasası))` USDT.
2. Maks. kaldıraç: coin'in Binance tavanı (leverageBracket) ile stop'u likidasyon mesafesinin içinde tutan en yüksek kaldıraçtan küçüğü (`floor(1 / (SL% + MMR + 0,2 %))`). Anahtar yoksa/hatalıysa `DEFAULT_MAX_LEV` = 1x. Böylece bağlanan margin en düşük olur.
3. Para kazandırmak. Kill/revizyon disiplini aşağıda.

Ek kilitler (gambler-core): serbest bakiye ≥ 10 stop zararı, en fazla 10 eş zamanlı açık pozisyon, sürüm başına tek değişken.

## Mimari
```
AB- Binance Trader (saatlik zamanlanmış görev, Claude)
  └─ /api/mcp/<MCP_TOKEN>  (Azure Function, Node 24, West Europe)
       hour_close → 1m replay + funding + equity kaydı + piyasa özeti
       open_position / skip_position / close_position / log_decision / performance / get_strategy / set_strategy
  └─ Azure Table Storage (papertrade)
Dashboard: GitHub Pages /docs  ←  GET /api/data
```

## Kurulum (bir kez)
1. Azure Portal → Function App oluştur: **Consumption (Windows)**, runtime **Node.js 24 LTS**, bölge **West Europe** (ABD olmaz: Binance HTTP 451). `axi-binance-signer`’dan ayrı app (bu app’te API anahtarı yok).
2. Function App → Settings → Environment variables:
   - `MCP_TOKEN` = uzun rastgele bir dize (connector URL’sinin parçası)
   - `START_WALLET` = `10` · `BASE_NOTIONAL` = `6` · `DEFAULT_MAX_LEV` = `1` · `MAX_OPEN` = `10` · `BINANCE_API_KEY` / `BINANCE_API_SECRET` = yalnız Enable Reading yetkili anahtar (coin'in gerçek kaldıraç tavanı için)
3. Overview → **Get publish profile** → bu repo → Settings → Secrets and variables → Actions:
   - Secret `AZURE_FUNCTIONAPP_PUBLISH_PROFILE` = dosya içeriği
   - Variable `AZURE_FUNCTIONAPP_NAME` = app adı
   - (Publish profile indirilemiyorsa: Configuration → General settings → SCM Basic Auth = On)
4. Actions → deploy-function → Run workflow.
5. `docs/config.js` = Overview → Default domain + `/api/data`. Pages: Branch `main`, `/(root)` (kökteki index.html `/docs`’a yönlendirir).
6. claude.ai → Settings → Connectors → Add custom connector → URL: `https://<Default domain>/api/mcp/<MCP_TOKEN>`
7. Zamanlanmış görev: aşağıdaki prompt, saatlik, connector bağlı.

## Strateji v1 (ilk koşuda set_strategy ile kaydedilir)
```
v1 — Momentum devamı + BTC rejimi (top movers, 1H)
Evren: hour_close.market (|ch24| ilk 10, hacim ≥ 50 M USDT), BTCUSDT yalnız rejim.
LONG: ch24 > 0, ch4h > 0, ch1h > 0, rng ≥ 0,70, vr ≥ 1,3, fund ≤ 0,05 %/8h, BTC ch1h > −0,5 %.
SHORT: ch24 < 0, ch4h < 0, ch1h < 0, rng ≤ 0,30, vr ≥ 1,3, fund ≥ −0,05 %/8h, BTC ch1h < +0,5 %.
Kural tutan her adaya giriş; sınır yalnız eş zamanlı en fazla 10 açık pozisyon (MAX_OPEN). Yer azsa önce en yüksek vr.
SL = atr1h × 1,0, 0,8–2,5 % aralığına sıkıştır. TP = 3 × SL. max_hold_h = 12.
Açık pozisyona dokunma: çıkış yalnız SL / TP / süre (stop taşımak yok).
```

## Revizyon disiplini
- Bir sürüm **30 kapanmış işlem** görmeden değişmez. İstisna (hemen revize): sürüm kasanın ≥ %10’unu kaybetti veya 8 ardışık zarar.
- 30 işlemde değerlendirme: PF < 1,0 veya net ≤ 0 USDT → revize. Önce çıkışa bak (MFE büyük, gerçekleşen küçükse hata çıkıştadır).
- Her revizyonda **tek değişken**; gerekçe `set_strategy.reason`’a n, PF, WSR, BSR ile yazılır.
- Elenmiş aileleri tekrar deneme: anomali/spike fade-follow, BB %B mean reversion, funding fade, SMC/CHoCH-BOS, OVEREXT.

## Zamanlanmış görev promptu — `AB- Binance Trader` (saatlik)
```
Sen Ali'nin intraday paper trader'ısın. Bağlı "claude-trader" MCP connector'ünü kullan. Başka araç çağırma, alt ajan açma, zamanlanmış görev kurma.

1. hour_close çağır.
2. get_strategy çağır. current null ise README'deki v1 kurallarını set_strategy(version="v1", reason="ilk sürüm") ile kaydet. (Kural metni: <v1 bloğunu buraya yapıştır>)
3. performance(version=<aktif sürüm>) çağır. Revizyon disiplini:
   - n ≥ 30 ve (pf < 1.0 veya net_usdt ≤ 0) → tek değişkeni değiştiren yeni sürüm yaz (set_strategy), gerekçeye n/PF/WSR/BSR ve hangi değişkenin neden değiştiğini koy.
   - Sürüm kasanın ≥ %10'unu kaybettiyse veya longest_loss_streak ≥ 8 → n'ye bakmadan aynı şekilde revize et.
   - Aksi halde sürüme dokunma.
4. Aktif kurallara göre market listesini değerlendir. Kural tutan aday varsa open_position çağır (sl_pct, tp_pct, max_hold_h kuraldan; reason = hangi koşullar tuttu, sayılarla). Kural tutmuyorsa açma. Açık pozisyonu kural dışı kapatma. Durmak da bir karardır ve ölçülür: koşulların en az 4/6'sı tutan ya da senin elle elediğin her aday için skip_position çağır (yön = koşulların işaret ettiği yön; açsaydın kullanacağın sl_pct/tp_pct/max_hold_h; reason = hangi koşul tutmadı ya da hangi riski gördün, sayılarla). Hiç pozisyon açmadığın saatte en güçlü aday için en az 1 skip_position zorunlu.
5. log_decision çağır. summary tam olarak şu biçimde, her bölüm 1 cümle, her sayı birimiyle: "Gördüm: <piyasada ne gördün> | Karar: <hangi kural tuttu/tutmadı, ne yaptın> | Beklenti: <TP ve stop senaryosu, USDT ve % ile>". actions = okunur Türkçe kısa satırlar: "AÇ IDOL LONG 19x", "TUT RARE", "KAPANDI PIEVERSE TP +0.44 USDT", "PAS VVV LONG", "İŞLEM YOK". Pozisyon numarası (P1, P2…) yazma.
6. Bitir. Çıktın tek satır: "<saat> | wallet <x> USDT | equity <y> USDT | <aksiyon>".
Bir araç HATA dönerse aynı çağrıyı en fazla 1 kez tekrar et; yine olmazsa log_decision'a hatayı yaz ve bitir.
```
