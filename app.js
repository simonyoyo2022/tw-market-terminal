// app.js — 法人籌碼 PWA (股價／籌碼／法人／借券)
(() => {
  "use strict";

  const DEFAULT_CODE = "8069"; // 元太科技
  const FAVORITES_KEY = "tif.favorites.v1";
  const GH_TOKEN_KEY = "tif.githubToken";
  // Separate, version-independent Cache Storage bucket for a backup copy of
  // the token. Must exactly match TOKEN_CACHE_NAME in service-worker.js,
  // which is deliberately excluded from the CACHE_VERSION cleanup so this
  // survives every future deploy. See getGithubToken() for why this exists:
  // iOS Safari has been observed clearing localStorage for this app within
  // a couple of hours while leaving Cache Storage entries untouched.
  const TOKEN_CACHE_NAME = "tif-token-store";
  const TOKEN_CACHE_URL = new URL("__gh_token__", location.href).href;
  const FINMIND_URL = "https://api.finmindtrade.com/api/v4/data";

  const COLORS = {
    buy: "#e5484d",
    sell: "#2f9e5b",
    flat: "#3a3f4d",
    gold: "#d4a24e",
    blue: "#7fb8f5",
    muted: "#8b8f9c",
    text: "#e8e9ed",
  };

  const els = {
    search: document.getElementById("search"),
    searchResults: document.getElementById("search-results"),
    status: document.getElementById("status"),
    stockCard: document.getElementById("stock-card"),
    stockName: document.getElementById("stock-name"),
    stockCode: document.getElementById("stock-code"),
    stockMarket: document.getElementById("stock-market"),
    stockIndustry: document.getElementById("stock-industry"),
    pinBtn: document.getElementById("pin-btn"),
    watchlistAddPanel: document.getElementById("watchlist-add-panel"),
    watchlistAddBtn: document.getElementById("watchlist-add-btn"),
    watchlistTokenHint: document.getElementById("watchlist-token-hint"),
    watchlistTokenForm: document.getElementById("watchlist-token-form"),
    ghTokenInput: document.getElementById("gh-token-input"),
    ghTokenSave: document.getElementById("gh-token-save"),
    ghTokenSkip: document.getElementById("gh-token-skip"),
    ghTokenReset: document.getElementById("gh-token-reset"),
    watchlistAddStatus: document.getElementById("watchlist-add-status"),
    watchlistViewBtn: document.getElementById("watchlist-view-btn"),
    watchlistViewCount: document.getElementById("watchlist-view-count"),
    watchlistViewPanel: document.getElementById("watchlist-view-panel"),
    watchlistViewClose: document.getElementById("watchlist-view-close"),
    watchlistViewStatus: document.getElementById("watchlist-view-status"),
    watchlistViewList: document.getElementById("watchlist-view-list"),
    favoritesViewBtn: document.getElementById("favorites-view-btn"),
    favoritesViewCount: document.getElementById("favorites-view-count"),
    favoritesViewPanel: document.getElementById("favorites-view-panel"),
    favoritesViewClose: document.getElementById("favorites-view-close"),
    favoritesViewStatus: document.getElementById("favorites-view-status"),
    favoritesViewList: document.getElementById("favorites-view-list"),
    quickStats: document.getElementById("quick-stats"),
    tabBtns: Array.from(document.querySelectorAll(".tab-btn")),
    panels: {
      price: document.getElementById("tab-price"),
      chips: document.getElementById("tab-chips"),
      inst: document.getElementById("tab-inst"),
      lending: document.getElementById("tab-lending"),
      signal: document.getElementById("tab-signal"),
      report: document.getElementById("tab-report"),
    },
    emptyState: document.getElementById("empty-state"),
    favoritesList: document.getElementById("favorites-list"),
  };

  let stockList = [];
  let stockIndex = null;
  let currentPayload = null;
  let currentCode = null;
  let currentTab = "price";
  let pricePeriod = "daily";
  let cachedWatchlist = null; // most recently known-good watchlist entries (guards against raw.githubusercontent.com's CDN lag after a write)
  let cachedWatchlistAt = 0; // when cachedWatchlist was last set from a write WE just made
  const CACHED_WATCHLIST_TRUST_MS = 5 * 60 * 1000; // how long to keep preferring it over a fresh CDN read

  // Whether to prefer our own in-memory cachedWatchlist over a freshly
  // fetched `raw` list from GitHub's raw-content CDN. Needed because that
  // CDN can lag a few minutes behind a commit we just made — for either an
  // add (cachedWatchlist longer than raw) or a remove (cachedWatchlist
  // shorter than raw), so this checks a plain length mismatch rather than
  // "longer than". Bounded by CACHED_WATCHLIST_TRUST_MS so that after a
  // while we go back to trusting fresh reads (e.g. picking up a change made
  // from another device), instead of trusting a self-made snapshot forever.
  function shouldTrustCachedWatchlist(raw) {
    if (!cachedWatchlist) return false;
    if (Date.now() - cachedWatchlistAt > CACHED_WATCHLIST_TRUST_MS) return false;
    return cachedWatchlist.length !== raw.length;
  }

  // Adopt a list as the current known-good snapshot AND refresh the trust
  // timestamp — use this whenever `list` is freshly proven correct (a write
  // we just made ourselves, or a CDN read we've decided to trust). Do NOT
  // call this when merely continuing to rely on an older cachedWatchlist
  // (see shouldTrustCachedWatchlist's bounded trust window) — that would
  // keep resetting the clock and defeat the point of the bound.
  function adoptWatchlistSnapshot(list) {
    cachedWatchlist = list;
    cachedWatchlistAt = Date.now();
  }
  const ranges = { price: 60, chips: 20, inst: 20, lending: 20, signalLookback: 10, marginRatio: 60 };

  // ---------- generic helpers ----------

  const fmtNum = (n) => {
    if (n == null || Number.isNaN(n)) return "—";
    const sign = n > 0 ? "+" : "";
    return sign + Math.round(n).toLocaleString("zh-TW");
  };
  const fmtPrice = (n) => (n == null || Number.isNaN(n) ? "—" : n.toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  // magnitude-only formatter: for use when the sign is already conveyed by
  // accompanying Chinese wording (賣超/回補/淨增加...), so we don't show a
  // redundant "+" in front of a number that's already been described as e.g. "賣超".
  const fmtAbsNum = (n) => (n == null || Number.isNaN(n) ? "—" : Math.round(Math.abs(n)).toLocaleString("zh-TW"));
  const signClass = (n) => (n > 0 ? "is-buy" : n < 0 ? "is-sell" : "is-flat");
  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function setStatus(msg, isError = false) {
    if (!msg) { els.status.hidden = true; return; }
    els.status.hidden = false;
    els.status.textContent = msg;
    els.status.classList.toggle("is-error", isError);
  }

  function loadFavorites() {
    try { return JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]"); } catch { return []; }
  }
  function saveFavorites(list) { localStorage.setItem(FAVORITES_KEY, JSON.stringify(list)); }
  function isFavorite(code) { return loadFavorites().includes(code); }
  function toggleFavorite(code) {
    const list = loadFavorites();
    const i = list.indexOf(code);
    if (i >= 0) list.splice(i, 1); else list.unshift(code);
    saveFavorites(list.slice(0, 100));
    renderFavorites();
  }
  function removeFavorite(code) {
    saveFavorites(loadFavorites().filter((c) => c !== code));
    renderFavorites();
  }
  function renderFavorites() {
    const favs = loadFavorites();
    els.favoritesViewCount.textContent = favs.length ? `(${favs.length})` : "";

    els.favoritesList.innerHTML = "";
    for (const code of favs) {
      const entry = stockIndex && stockIndex.get(code);
      const li = document.createElement("li");
      li.textContent = entry ? `${entry.name} ${code}` : code;
      li.addEventListener("click", () => selectStock(code));
      els.favoritesList.appendChild(li);
    }

    els.favoritesViewList.innerHTML = "";
    if (favs.length === 0) {
      els.favoritesViewStatus.textContent = "還沒有自選股。查看任何股票時，點名稱旁邊的 ☆ 就能加進來。";
    } else {
      els.favoritesViewStatus.textContent = `共 ${favs.length} 檔。`;
      for (const code of favs) {
        const entry = stockIndex && stockIndex.get(code);
        const li = document.createElement("li");
        li.innerHTML =
          `<span class="wv-name">${escapeHtml(entry ? entry.name : code)}</span><span class="wv-code">${code}</span>` +
          `<div class="wv-meta">${entry ? entry.market : ""}</div>` +
          `<button class="wv-remove" data-code="${code}" aria-label="移除">移除</button>`;
        li.addEventListener("click", (e) => {
          if (e.target.closest(".wv-remove")) {
            e.stopPropagation();
            removeFavorite(code);
            return;
          }
          closeFavoritesView();
          selectStock(code);
        });
        els.favoritesViewList.appendChild(li);
      }
    }
  }

  function openFavoritesView() {
    renderFavorites();
    els.favoritesViewPanel.hidden = false;
  }
  function closeFavoritesView() {
    els.favoritesViewPanel.hidden = true;
  }

  // ---------- stock list / search ----------

  async function loadStockList() {
    try {
      const res = await fetch("data/stock-list.json", { cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();
      stockList = json.list || [];
      stockIndex = new Map(stockList.map((s) => [s.code, s]));
      localStorage.setItem("tif.stockList.cache", JSON.stringify(json));
    } catch (e) {
      console.warn("stock-list.json unavailable, trying local cache:", e.message);
      try {
        const cached = JSON.parse(localStorage.getItem("tif.stockList.cache") || "null");
        if (cached) {
          stockList = cached.list || [];
          stockIndex = new Map(stockList.map((s) => [s.code, s]));
        }
      } catch { /* ignore */ }
    }
  }

  function searchStocks(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const isCodeQuery = /^\d+$/.test(q);
    const results = [];
    for (const s of stockList) {
      if (isCodeQuery ? s.code.startsWith(q) : s.name.toLowerCase().includes(q) || s.code.startsWith(q)) {
        results.push(s);
        if (results.length >= 25) break;
      }
    }
    return results;
  }

  function renderSearchResults(results) {
    els.searchResults.innerHTML = "";
    if (results.length === 0) { els.searchResults.hidden = true; return; }
    for (const s of results) {
      const li = document.createElement("li");
      li.innerHTML =
        `<span><span class="result-name">${escapeHtml(s.name)}</span> <span class="result-code">${s.code}</span></span>` +
        `<span class="result-market">${s.market}</span>`;
      li.addEventListener("click", () => {
        els.search.value = `${s.name} ${s.code}`;
        els.searchResults.hidden = true;
        selectStock(s.code);
      });
      els.searchResults.appendChild(li);
    }
    els.searchResults.hidden = false;
  }

  // ---------- data fetching ----------

  async function fetchCached(code) {
    const res = await fetch(`data/stocks/${code}.json`, { cache: "no-cache" });
    if (!res.ok) throw new Error("no cached file");
    return res.json();
  }

  function isoDaysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  }

  function normalizeInstRows(rows) {
    // Same unit fix as scripts/fetch-data.mjs: FinMind's institutional
    // buy/sell fields are in 股 (shares), so divide by 1000 to get 張,
    // matching every other "張" figure shown in this app.
    const toLots = (n) => Math.round(n / 1000);
    return rows.map((r) => {
      const foreign = toLots(
        (r.Foreign_Investor_buy || 0) - (r.Foreign_Investor_sell || 0) +
        (r.Foreign_Dealer_Self_buy || 0) - (r.Foreign_Dealer_Self_sell || 0)
      );
      const trust = toLots((r.Investment_Trust_buy || 0) - (r.Investment_Trust_sell || 0));
      const dealer = toLots(
        (r.Dealer_buy || 0) - (r.Dealer_sell || 0) +
        (r.Dealer_self_buy || 0) - (r.Dealer_self_sell || 0) +
        (r.Dealer_Hedging_buy || 0) - (r.Dealer_Hedging_sell || 0)
      );
      return { date: r.date, foreign, trust, dealer, total: foreign + trust + dealer };
    }).sort((a, b) => a.date.localeCompare(b.date));
  }
  function normalizePriceRows(rows) {
    return rows
      .map((r) => ({ date: r.date, open: r.open, max: r.max, min: r.min, close: r.close, volume: r.Trading_Volume, turnoverMoney: r.Trading_money, spread: r.spread }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }
  function normalizeValuationRows(rows) {
    return rows.map((r) => ({ date: r.date, per: r.PER, pbr: r.PBR, dividendYield: r.dividend_yield })).sort((a, b) => a.date.localeCompare(b.date));
  }
  // 每日增減一律用「今日餘額 − 昨日餘額」推導（資料源兩個欄位都有），
  // 流量欄位（買/賣/現償）只當缺 YesterdayBalance 時的備援。
  // 理由：融券餘額還會被停券、強制回補、額度調整等機制性事件改動，
  // 只加總流量欄位會跟顯示的餘額對不上帳（曾出現「近10日淨增9張」
  // 但「餘額0張」的矛盾）。餘額差推導讓這種矛盾在數學上不可能發生。
  function balanceDiffChange(today, yesterday, flowFallback) {
    return today != null && yesterday != null ? today - yesterday : flowFallback;
  }
  function normalizeMarginRows(rows) {
    return rows
      .map((r) => ({
        date: r.date,
        marginBalance: r.MarginPurchaseTodayBalance,
        marginChange: balanceDiffChange(
          r.MarginPurchaseTodayBalance,
          r.MarginPurchaseYesterdayBalance,
          (r.MarginPurchaseBuy || 0) - (r.MarginPurchaseSell || 0) - (r.MarginPurchaseCashRepayment || 0)
        ),
        shortBalance: r.ShortSaleTodayBalance,
        shortChange: balanceDiffChange(
          r.ShortSaleTodayBalance,
          r.ShortSaleYesterdayBalance,
          (r.ShortSaleSell || 0) - (r.ShortSaleBuy || 0) - (r.ShortSaleCashRepayment || 0)
        ),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }
  function normalizeShareholdingRows(rows) {
    return rows
      .map((r) => ({ date: r.date, foreignSharesRatio: r.ForeignInvestmentSharesRatio, foreignRemainRatio: r.ForeignInvestmentRemainRatio }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }
  function normalizeLendingRows(rows) {
    const byDate = new Map();
    for (const r of rows) {
      const d = byDate.get(r.date) || { date: r.date, volume: 0, feeSum: 0, feeCount: 0 };
      d.volume += r.volume || 0;
      if (r.fee_rate != null) { d.feeSum += r.fee_rate * (r.volume || 0); d.feeCount += r.volume || 0; }
      byDate.set(r.date, d);
    }
    return [...byDate.values()]
      .map((d) => ({ date: d.date, volume: d.volume, avgFeeRate: d.feeCount ? round2(d.feeSum / d.feeCount) : null }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  // ---------- technical indicators + period bars (mirrors scripts/fetch-data.mjs) ----------

  function round2(n) { return n == null ? null : Math.round(n * 100) / 100; }

  function emaSeries(values, period) {
    const k = 2 / (period + 1);
    const out = new Array(values.length).fill(null);
    let prev = null;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null) continue;
      prev = prev == null ? v : v * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function rsiSeries(closes, period = 14) {
    const out = new Array(closes.length).fill(null);
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      const gain = Math.max(change, 0);
      const loss = Math.max(-change, 0);
      if (i <= period) {
        avgGain += gain / period;
        avgLoss += loss / period;
        if (i === period) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      } else {
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    }
    return out;
  }

  function macdSeries(closes, fast = 12, slow = 26, signalPeriod = 9) {
    const emaFast = emaSeries(closes, fast);
    const emaSlow = emaSeries(closes, slow);
    const macdLine = closes.map((_, i) => (emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null));
    const signalLine = emaSeries(macdLine, signalPeriod);
    const hist = macdLine.map((v, i) => (v != null && signalLine[i] != null ? v - signalLine[i] : null));
    return { macdLine, signalLine, hist };
  }

  // Taiwan-convention KD (slow stochastic, 2/3-1/3 RSV smoothing, seeded at
  // 50/50) — must stay identical to kd() in scripts/fetch-data.mjs so live
  // queries and cached watchlist stocks show the same KD for the same day.
  function kdSeries(priceDaily, period = 9) {
    const n = priceDaily.length;
    const kOut = new Array(n).fill(null);
    const dOut = new Array(n).fill(null);
    let prevK = 50, prevD = 50;
    for (let i = period - 1; i < n; i++) {
      let hi = -Infinity, lo = Infinity;
      for (let j = i - period + 1; j <= i; j++) {
        if (priceDaily[j].max > hi) hi = priceDaily[j].max;
        if (priceDaily[j].min < lo) lo = priceDaily[j].min;
      }
      const close = priceDaily[i].close;
      const rsv = hi === lo ? 50 : ((close - lo) / (hi - lo)) * 100;
      const k = prevK * (2 / 3) + rsv * (1 / 3);
      const d = prevD * (2 / 3) + k * (1 / 3);
      kOut[i] = k;
      dOut[i] = d;
      prevK = k;
      prevD = d;
    }
    return { k: kOut, d: dOut };
  }

  function buildTechnical(priceDaily) {
    const closes = priceDaily.map((r) => r.close);
    const e5 = emaSeries(closes, 5), e20 = emaSeries(closes, 20), e60 = emaSeries(closes, 60);
    const r14 = rsiSeries(closes, 14);
    const { macdLine, signalLine, hist } = macdSeries(closes);
    const { k: kdK, d: kdD } = kdSeries(priceDaily, 9);
    return priceDaily.map((r, i) => ({
      date: r.date,
      ema5: round2(e5[i]), ema20: round2(e20[i]), ema60: round2(e60[i]),
      rsi14: round2(r14[i]),
      macd: round2(macdLine[i]), macdSignal: round2(signalLine[i]), macdHist: round2(hist[i]),
      kdK: round2(kdK[i]), kdD: round2(kdD[i]),
    }));
  }

  function aggregateBars(priceDaily, keyFn) {
    const buckets = new Map();
    for (const r of priceDaily) {
      const key = keyFn(r.date);
      if (!buckets.has(key)) {
        buckets.set(key, { period: key, date: r.date, open: r.open, high: r.max, low: r.min, close: r.close, volume: r.volume });
      } else {
        const b = buckets.get(key);
        b.high = Math.max(b.high, r.max);
        b.low = Math.min(b.low, r.min);
        b.close = r.close;
        b.volume += r.volume;
      }
    }
    return [...buckets.values()];
  }
  const monthKey = (d) => d.slice(0, 7);
  const quarterKey = (d) => {
    const [y, m] = d.slice(0, 7).split("-");
    return `${y}-Q${Math.ceil(Number(m) / 3)}`;
  };

  // Full client-side snapshot for any stock, not just watchlist ones: pulls
  // all 6 FinMind datasets in parallel from the browser and derives the same
  // technical indicators / monthly-quarterly bars as the server-side script.
  // Falls back gracefully per-dataset (Promise.allSettled) so one failing
  // call doesn't blank out the rest.
  async function fetchLiveField(dataset, code, historyDays) {
    const url = new URL(FINMIND_URL);
    url.searchParams.set("dataset", dataset);
    url.searchParams.set("data_id", code);
    url.searchParams.set("start_date", isoDaysAgo(historyDays));
    url.searchParams.set("end_date", isoDaysAgo(0));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${dataset} HTTP ${res.status}`);
    const json = await res.json();
    return json.data || [];
  }

  async function fetchLive(code) {
    const settled = await Promise.allSettled([
      fetchLiveField("TaiwanStockPrice", code, 400),
      fetchLiveField("TaiwanStockPER", code, 130),
      fetchLiveField("TaiwanStockInstitutionalInvestorsBuySellWide", code, 130),
      fetchLiveField("TaiwanStockMarginPurchaseShortSale", code, 130),
      fetchLiveField("TaiwanStockShareholding", code, 130),
      fetchLiveField("TaiwanStockSecuritiesLending", code, 130),
    ]);
    const val = (r) => (r.status === "fulfilled" ? r.value : []);
    const [priceRaw, valRaw, instRaw, marginRaw, shareRaw, lendRaw] = settled.map(val);

    const price = normalizePriceRows(priceRaw);
    const institutional = normalizeInstRows(instRaw);
    if (price.length === 0 && institutional.length === 0) throw new Error("live fetch returned no data");

    const technical = buildTechnical(price);
    return {
      code,
      updatedAt: new Date().toISOString(),
      live: true,
      price: { daily: price, monthly: aggregateBars(price, monthKey), quarterly: aggregateBars(price, quarterKey) },
      technical,
      valuation: normalizeValuationRows(valRaw),
      institutional,
      margin: normalizeMarginRows(marginRaw),
      shareholding: normalizeShareholdingRows(shareRaw),
      lending: normalizeLendingRows(lendRaw),
    };
  }

  // ---------- add-to-watchlist (reads/writes watchlist.json on GitHub) ----------

  function parseOwnerRepo() {
    const repoUrl = (window.APP_CONFIG && window.APP_CONFIG.repoUrl) || "";
    const m = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!m) return null;
    return { owner: m[1], repo: m[2].replace(/\.git$/, "") };
  }

  async function fetchWatchlistRaw(owner, repo) {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/main/watchlist.json?t=${Date.now()}`;
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`讀取 watchlist.json 失敗 (HTTP ${res.status})`);
    return res.json();
  }

  // watchlist.json entries may be plain code strings (original/manual
  // entries) or {code, name, addedAt} objects (entries added from the app).
  // Both are supported everywhere so old and new entries mix freely.
  function normalizeWatchlistEntry(item) {
    if (typeof item === "string") return { code: item, name: null, addedAt: null };
    return { code: item.code, name: item.name || null, addedAt: item.addedAt || null };
  }

  // Best-effort check against whatever watchlist snapshot we already have in
  // memory (populated once the "常駐清單" panel has been opened this
  // session — see cachedWatchlist). Being IN watchlist.json is a different
  // fact from having a data/stocks/{code}.json cache file: the former is
  // written instantly by the add-to-watchlist flow, the latter only shows up
  // after the next scheduled/manual Actions run. If we haven't loaded a
  // watchlist snapshot yet this session, we simply can't tell — callers
  // should treat `false` here as "unknown", not "definitely not in the list".
  function isInCachedWatchlist(code) {
    if (!cachedWatchlist) return false;
    return cachedWatchlist.some((item) => normalizeWatchlistEntry(item).code === code);
  }

  function b64EncodeUnicode(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }

  async function writeWatchlistViaApi(owner, repo, token, newList, commitMessage) {
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/watchlist.json`;
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };

    const getRes = await fetch(apiUrl, { headers });
    if (!getRes.ok) throw new Error(`讀取失敗 (HTTP ${getRes.status})，token 可能沒有這個 repo 的權限`);
    const getJson = await getRes.json();

    const content = b64EncodeUnicode(JSON.stringify(newList, null, 2) + "\n");
    const putRes = await fetch(apiUrl, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: commitMessage,
        content,
        sha: getJson.sha,
      }),
    });
    if (!putRes.ok) {
      const text = await putRes.text().catch(() => "");
      throw new Error(`寫入失敗 (HTTP ${putRes.status}): ${text.slice(0, 150)}`);
    }
  }

  // ---------- GitHub token storage (localStorage + Cache Storage backup) ----------
  //
  // localStorage is the fast, synchronous primary copy. The Cache Storage
  // bucket is a slower-but-sturdier backup: a user report + a check of
  // Settings → Safari → Advanced → Website Data confirmed that iOS Safari
  // can clear this app's localStorage (wiping the saved token) within a
  // couple of hours, while its Service-Worker Cache Storage entries — the
  // same mechanism holding the cached app shell/data — survived untouched.
  // So every read goes through getGithubToken(), which falls back to the
  // backup and silently repairs localStorage when the fast copy is missing.

  async function persistTokenBackup(token) {
    if (!("caches" in window)) return;
    try {
      const cache = await caches.open(TOKEN_CACHE_NAME);
      await cache.put(TOKEN_CACHE_URL, new Response(token));
    } catch (e) { /* best effort only */ }
  }
  async function clearTokenBackup() {
    if (!("caches" in window)) return;
    try {
      const cache = await caches.open(TOKEN_CACHE_NAME);
      await cache.delete(TOKEN_CACHE_URL);
    } catch (e) { /* best effort only */ }
  }
  async function readTokenBackup() {
    if (!("caches" in window)) return null;
    try {
      const cache = await caches.open(TOKEN_CACHE_NAME);
      const res = await cache.match(TOKEN_CACHE_URL);
      return res ? await res.text() : null;
    } catch (e) { return null; }
  }
  async function getGithubToken() {
    const local = localStorage.getItem(GH_TOKEN_KEY);
    if (local) return local;
    const backup = await readTokenBackup();
    if (backup) {
      try { localStorage.setItem(GH_TOKEN_KEY, backup); } catch (e) { /* ignore */ }
    }
    return backup;
  }
  async function setGithubToken(token) {
    try { localStorage.setItem(GH_TOKEN_KEY, token); } catch (e) { /* ignore */ }
    await persistTokenBackup(token);
  }
  async function clearGithubToken() {
    try { localStorage.removeItem(GH_TOKEN_KEY); } catch (e) { /* ignore */ }
    await clearTokenBackup();
  }

  function setAddStatus(msg, isError = false) {
    els.watchlistAddStatus.hidden = !msg;
    els.watchlistAddStatus.textContent = msg;
    els.watchlistAddStatus.style.color = isError ? COLORS.buy : "";
  }

  // Makes the "is a token currently saved?" state visible instead of only
  // implicit (previously you could only tell by whether the reset button
  // happened to be showing) — this is what actually answers "why is it
  // asking me again", since the answer is always "because no token is
  // currently available (localStorage nor its backup) in this browser".
  // Also self-heals localStorage from the Cache Storage backup when needed,
  // and owns the reset-button visibility so there's one source of truth.
  async function updateTokenHint() {
    const token = await getGithubToken();
    const hasToken = !!token;
    els.watchlistTokenHint.textContent = hasToken
      ? "🔑 已儲存 token，點下方按鈕會直接自動加入常駐清單，不會再問一次。"
      : "尚未儲存 token（這台瀏覽器裡沒有）。點下方按鈕加入時，選「儲存並加入」才會存，選「略過，改用複製」不會存。";
    els.watchlistTokenHint.classList.toggle("token-ok", hasToken);
    els.ghTokenReset.hidden = !hasToken;
  }

  function newWatchlistEntry(code) {
    const entry = stockIndex && stockIndex.get(code);
    return { code, name: entry ? entry.name : null, addedAt: new Date().toISOString() };
  }

  async function copyFallback(owner, repo, code, currentList) {
    const entry = newWatchlistEntry(code);
    const newList = currentList ? [...currentList, entry] : [entry];
    const text = JSON.stringify(newList, null, 2) + "\n";
    try {
      await navigator.clipboard.writeText(text);
    } catch { /* clipboard may be unavailable; instructions still shown */ }
    const editUrl = owner ? `https://github.com/${owner}/${repo}/edit/main/watchlist.json` : "";
    setAddStatus(
      `已把完整清單複製到剪貼簿（含 ${code}）。${editUrl ? "點這裡開啟編輯頁貼上取代全部內容：" + editUrl : "到 GitHub 打開 watchlist.json 貼上取代全部內容。"}下次排程（17:30／21:30）跑完就會快取、可離線查詢。`
    );
  }

  async function handleAddToWatchlist(code) {
    const or_ = parseOwnerRepo();
    setAddStatus("處理中…");
    els.watchlistTokenForm.hidden = true;

    let currentList = null;
    try {
      if (or_) currentList = await fetchWatchlistRaw(or_.owner, or_.repo);
    } catch (e) {
      console.warn("could not read current watchlist.json:", e.message);
    }

    if (currentList && currentList.some((item) => normalizeWatchlistEntry(item).code === code)) {
      adoptWatchlistSnapshot(currentList);
      setAddStatus(
        `${code} 已經在常駐清單裡了，只是資料還沒被排程抓進來——要等下次排程更新` +
        `（平日 17:30／21:30）或手動到 Actions 頁面點 Run workflow，跑完之後才會變成離線快取。`
      );
      return;
    }

    const token = await getGithubToken();
    if (token && or_) {
      try {
        const entry = newWatchlistEntry(code);
        const newList = currentList ? [...currentList, entry] : [entry];
        await writeWatchlistViaApi(or_.owner, or_.repo, token, newList, `chore: add ${code} to watchlist`);
        setAddStatus(`已把 ${code} 加入常駐清單！下次排程（17:30／21:30，或手動 Run workflow）跑完就會快取，之後開啟更快、可離線查詢。`);
        adoptWatchlistSnapshot(newList); // GitHub's raw-content CDN can lag a few minutes behind a just-made commit; use what we know we just wrote instead of re-fetching immediately.
        renderWatchlistCount(newList.length);
        return;
      } catch (e) {
        console.warn("auto-write failed:", e.message);
        setAddStatus(
          `自動寫入失敗（${e.message}）。Token 還留著沒清掉；如果你確定是 token 本身失效，可以到下面「清除已存的 token」重設。這次先用複製方式：`,
          true
        );
        await copyFallback(or_?.owner, or_?.repo, code, currentList);
        return;
      }
    }

    if (!or_) {
      setAddStatus("尚未在 config.js 設定 repoUrl，無法產生編輯連結；先手動把代號加進 watchlist.json。");
      return;
    }

    // no token saved yet -> offer the choice
    els.watchlistTokenForm.hidden = false;
    els.watchlistAddStatus.hidden = true;
    els.watchlistTokenForm.dataset.code = code;
  }

  async function copyRemoveFallback(owner, repo, code, newList) {
    const text = JSON.stringify(newList, null, 2) + "\n";
    try {
      await navigator.clipboard.writeText(text);
    } catch { /* clipboard may be unavailable; instructions still shown */ }
    const editUrl = owner ? `https://github.com/${owner}/${repo}/edit/main/watchlist.json` : "";
    els.watchlistViewStatus.textContent =
      `已把移除 ${code} 之後的清單複製到剪貼簿。${editUrl ? "點這裡開啟編輯頁貼上取代全部內容：" + editUrl : "到 GitHub 打開 watchlist.json 貼上取代全部內容。"}`;
  }

  // Mirrors handleAddToWatchlist but filters the code OUT instead of
  // appending it. Removing from watchlist.json only stops future scheduled
  // fetches from touching that stock — it does NOT by itself delete the
  // already-cached data/stocks/{code}.json, which would otherwise sit there
  // silently going stale forever and keep getting served as if it were
  // current. scripts/fetch-data.mjs's cleanupOrphanedStockFiles() deletes
  // any data/stocks/*.json whose code is no longer in watchlist.json, on the
  // next scheduled/manual Actions run — same lag as everything else here.
  async function handleRemoveFromWatchlist(code) {
    const or_ = parseOwnerRepo();
    if (!or_) {
      els.watchlistViewStatus.textContent = "尚未在 config.js 設定 repoUrl，無法自動移除；到 GitHub 手動編輯 watchlist.json 刪除這筆。";
      return;
    }

    els.watchlistViewStatus.textContent = `正在移除 ${code}…`;

    let currentList = null;
    try {
      currentList = await fetchWatchlistRaw(or_.owner, or_.repo);
    } catch (e) {
      els.watchlistViewStatus.textContent = `讀取目前清單失敗（${e.message}），無法安全移除，避免誤刪其他股票，先停在這裡。`;
      return;
    }

    const newList = currentList.filter((item) => normalizeWatchlistEntry(item).code !== code);
    if (newList.length === currentList.length) {
      els.watchlistViewStatus.textContent = `${code} 已經不在常駐清單裡了。`;
      adoptWatchlistSnapshot(currentList);
      return;
    }

    const token = await getGithubToken();
    if (token) {
      try {
        await writeWatchlistViaApi(or_.owner, or_.repo, token, newList, `chore: remove ${code} from watchlist`);
        adoptWatchlistSnapshot(newList);
        renderWatchlistCount(newList.length);
        await openWatchlistView(); // re-render the list without this entry
        return;
      } catch (e) {
        console.warn("auto-remove failed:", e.message);
        els.watchlistViewStatus.textContent = `自動移除失敗（${e.message}）。這次先用複製方式：`;
        await copyRemoveFallback(or_.owner, or_.repo, code, newList);
        return;
      }
    }

    await copyRemoveFallback(or_.owner, or_.repo, code, newList);
  }

  // ---------- watchlist log viewer ----------

  async function renderWatchlistCount(knownCount) {
    if (knownCount != null) {
      els.watchlistViewCount.textContent = `(${knownCount})`;
      return;
    }
    const or_ = parseOwnerRepo();
    if (!or_) return;
    try {
      const list = await fetchWatchlistRaw(or_.owner, or_.repo);
      // Opportunistically warm cachedWatchlist here too (this already-paid-for
      // fetch runs once at boot) so isInCachedWatchlist() works right away,
      // instead of only after the user has opened the 常駐清單 panel once.
      if (!shouldTrustCachedWatchlist(list)) adoptWatchlistSnapshot(list);
      const count = cachedWatchlist.length;
      els.watchlistViewCount.textContent = `(${count})`;
    } catch { /* ignore */ }
  }

  async function openWatchlistView() {
    els.watchlistViewPanel.hidden = false;
    els.watchlistViewStatus.textContent = "載入中…";
    els.watchlistViewList.innerHTML = "";

    const or_ = parseOwnerRepo();
    if (!or_) {
      els.watchlistViewStatus.textContent = "尚未在 config.js 設定 repoUrl。";
      return;
    }
    try {
      const raw = await fetchWatchlistRaw(or_.owner, or_.repo);
      const usingCache = shouldTrustCachedWatchlist(raw);
      if (!usingCache) adoptWatchlistSnapshot(raw);
      const source = cachedWatchlist;
      const entries = source.map(normalizeWatchlistEntry);
      // most-recently-added first; entries without a timestamp (legacy/manual) sort last, original order preserved among themselves
      const withTime = entries.filter((e) => e.addedAt).sort((a, b) => b.addedAt.localeCompare(a.addedAt));
      const withoutTime = entries.filter((e) => !e.addedAt);
      const ordered = [...withTime, ...withoutTime];

      els.watchlistViewStatus.textContent = usingCache
        ? `共 ${entries.length} 檔（剛剛的新增/移除，GitHub 那邊還在同步，可能要等幾分鐘才會反映在 raw 檔案上，但這裡先顯示正確結果）。`
        : `共 ${entries.length} 檔，資料每日 17:30／21:30 分兩段自動更新。`;
      els.watchlistViewCount.textContent = `(${entries.length})`;

      els.watchlistViewList.innerHTML = "";
      for (const entry of ordered) {
        const info = stockIndex && stockIndex.get(entry.code);
        const name = entry.name || (info && info.name) || entry.code;
        const market = info ? info.market : "";
        const when = entry.addedAt ? new Date(entry.addedAt).toLocaleString("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "原始清單";
        const li = document.createElement("li");
        li.innerHTML = `<span class="wv-name">${escapeHtml(name)}</span><span class="wv-code">${entry.code}</span>` +
          `<div class="wv-meta">${market ? market + " · " : ""}加入時間：${when}</div>` +
          `<button class="wv-remove" data-code="${entry.code}" aria-label="移除">移除</button>`;
        li.addEventListener("click", (e) => {
          if (e.target.closest(".wv-remove")) {
            e.stopPropagation();
            if (confirm(`確定要把「${name}」(${entry.code}) 從常駐清單移除嗎？`)) {
              handleRemoveFromWatchlist(entry.code);
            }
            return;
          }
          closeWatchlistView();
          selectStock(entry.code);
        });
        els.watchlistViewList.appendChild(li);
      }
    } catch (e) {
      els.watchlistViewStatus.textContent = `讀取失敗：${e.message}`;
    }
  }

  function closeWatchlistView() {
    els.watchlistViewPanel.hidden = true;
  }

  function wireWatchlistAddPanel() {
    els.watchlistAddBtn.addEventListener("click", () => {
      const code = els.watchlistAddBtn.dataset.code;
      if (code) handleAddToWatchlist(code);
    });
    els.ghTokenSave.addEventListener("click", async () => {
      const token = els.ghTokenInput.value.trim();
      const code = els.watchlistTokenForm.dataset.code;
      if (!token) return;
      await setGithubToken(token);
      els.ghTokenInput.value = "";
      els.watchlistTokenForm.hidden = true;
      await updateTokenHint();
      if (code) handleAddToWatchlist(code);
    });
    els.ghTokenSkip.addEventListener("click", async () => {
      const code = els.watchlistTokenForm.dataset.code;
      els.watchlistTokenForm.hidden = true;
      const or_ = parseOwnerRepo();
      let currentList = null;
      try { if (or_) currentList = await fetchWatchlistRaw(or_.owner, or_.repo); } catch { /* ignore */ }
      await copyFallback(or_?.owner, or_?.repo, code, currentList);
    });
    els.watchlistViewBtn.addEventListener("click", openWatchlistView);
    els.watchlistViewClose.addEventListener("click", closeWatchlistView);
    els.favoritesViewBtn.addEventListener("click", openFavoritesView);
    els.favoritesViewClose.addEventListener("click", closeFavoritesView);
    els.ghTokenReset.addEventListener("click", async () => {
      await clearGithubToken();
      await updateTokenHint();
      setAddStatus("已清除已存的 token（含備份），下次點「加入常駐清單」會重新問你要不要輸入。");
    });
  }

  async function selectStock(code) {
    location.hash = code;
    setStatus(`載入 ${code} 中…`);
    els.stockCard.hidden = true;
    els.emptyState.hidden = true;

    let payload;
    try {
      payload = await fetchCached(code);
    } catch {
      setStatus(`${code} 不在常駐快取清單中，即時查詢完整資料中…`);
      try {
        payload = await fetchLive(code);
      } catch (liveErr) {
        console.warn("live fetch failed:", liveErr.message);
        const repoUrl = (window.APP_CONFIG && window.APP_CONFIG.repoUrl) || "";
        const hint = repoUrl
          ? `到 ${repoUrl} 編輯 watchlist.json 加入 ${code}，下次自動更新後即可查詢完整資料。`
          : `到 GitHub 專案編輯 watchlist.json 加入 ${code}，下次自動更新後即可查詢完整資料。`;
        setStatus(`查無 ${code} 的資料（尚未加入常駐清單，且瀏覽器即時查詢受限）。${hint}`, true);
        return;
      }
    }

    if (!payload.price || (!payload.price.daily.length && !payload.institutional.length)) {
      setStatus(`${code} 目前沒有可用的資料。`, true);
      return;
    }

    setStatus(payload.live ? "即時查詢結果（未快取，關閉後要再重查；點下方按鈕可加入常駐清單，之後就能離線快速讀取）" : "");
    currentPayload = payload;
    currentCode = code;
    renderStock(code, payload);
  }

  // ---------- SVG chart primitives ----------

  function svgLine(x1, y1, x2, y2, opts = {}) {
    const { stroke = "#2a2e3a", width = 1 } = opts;
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${width}" />`;
  }

  function renderDivergingBars(svgEl, rows, valueFn) {
    const vb = svgEl.viewBox.baseVal;
    const W = vb.width || 600, H = vb.height || 150;
    const padL = 4, padR = 4, padTop = 10, padBottom = 10;
    const baseline = H / 2;
    const plotW = W - padL - padR;
    const n = rows.length || 1;
    const slot = plotW / n;
    const barW = Math.max(1.5, slot * 0.6);
    const vals = rows.map(valueFn);
    const maxAbs = Math.max(1, ...vals.map((v) => Math.abs(v || 0)));
    const halfH = H / 2 - padTop - padBottom;

    let svg = svgLine(padL, baseline, W - padR, baseline);
    rows.forEach((r, i) => {
      const v = valueFn(r) || 0;
      const x = padL + i * slot + (slot - barW) / 2;
      const h = (Math.abs(v) / maxAbs) * halfH;
      const y = v >= 0 ? baseline - h : baseline;
      const fill = v > 0 ? COLORS.buy : v < 0 ? COLORS.sell : COLORS.flat;
      svg += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="1.5" fill="${fill}"><title>${r.date}: ${fmtNum(v)}</title></rect>`;
    });
    svgEl.innerHTML = svg;
  }

  function renderBars(svgEl, rows, valueFn, color) {
    const vb = svgEl.viewBox.baseVal;
    const W = vb.width || 600, H = vb.height || 150;
    const padL = 4, padR = 4, padTop = 8, padBottom = 8;
    const plotH = H - padTop - padBottom;
    const plotW = W - padL - padR;
    const n = rows.length || 1;
    const slot = plotW / n;
    const barW = Math.max(1.5, slot * 0.6);
    const vals = rows.map(valueFn).map((v) => v || 0);
    const maxV = Math.max(1, ...vals);

    let svg = "";
    rows.forEach((r, i) => {
      const v = valueFn(r) || 0;
      const h = (v / maxV) * plotH;
      const x = padL + i * slot + (slot - barW) / 2;
      const y = H - padBottom - h;
      svg += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="1.5" fill="${color}"><title>${r.date}: ${fmtNum(v)}</title></rect>`;
    });
    svgEl.innerHTML = svg;
  }

  // series: [{ color, points: [value,...] (nulls allowed) }], rows for x labels/tooltips
  function renderLineChart(svgEl, rows, series) {
    const vb = svgEl.viewBox.baseVal;
    const W = vb.width || 600, H = vb.height || 200;
    const padL = 6, padR = 6, padTop = 10, padBottom = 10;
    const plotW = W - padL - padR;
    const plotH = H - padTop - padBottom;
    const n = rows.length || 1;

    let min = Infinity, max = -Infinity;
    for (const s of series) {
      for (const v of s.points) {
        if (v == null) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!isFinite(min) || !isFinite(max)) { svgEl.innerHTML = ""; return; }
    if (min === max) { min -= 1; max += 1; }
    const pad = (max - min) * 0.08;
    min -= pad; max += pad;

    const xAt = (i) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const yAt = (v) => padTop + plotH - ((v - min) / (max - min)) * plotH;

    let svg = "";
    // light horizontal gridlines
    for (let g = 0; g <= 2; g++) {
      const y = padTop + (plotH / 2) * g;
      svg += svgLine(padL, y, W - padR, y, { stroke: "#242833", width: 1 });
    }

    for (const s of series) {
      let d = "";
      let started = false;
      s.points.forEach((v, i) => {
        if (v == null) { started = false; return; }
        const cmd = started ? "L" : "M";
        d += `${cmd}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)} `;
        started = true;
      });
      if (d) svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width || 1.6}" stroke-linejoin="round" stroke-linecap="round" opacity="${s.opacity ?? 1}" />`;
    }
    svgEl.innerHTML = svg;
  }

  // ---------- render: identity + quick stats ----------

  function renderStock(code, payload) {
    const entry = (stockIndex && stockIndex.get(code)) || { name: code, market: "", industry: "" };
    els.stockName.textContent = entry.name;
    els.stockCode.textContent = code;
    els.stockMarket.textContent = entry.market || "—";
    els.stockIndustry.textContent = entry.industry || "";
    els.stockIndustry.hidden = !entry.industry;

    els.pinBtn.classList.toggle("is-pinned", isFavorite(code));
    els.pinBtn.textContent = isFavorite(code) ? "★" : "☆";
    els.pinBtn.onclick = () => {
      toggleFavorite(code);
      els.pinBtn.classList.toggle("is-pinned", isFavorite(code));
      els.pinBtn.textContent = isFavorite(code) ? "★" : "☆";
    };

    renderQuickStats(payload);
    renderActiveTab();

    els.watchlistTokenForm.hidden = true;
    els.watchlistAddStatus.hidden = true;
    if (payload.live) {
      els.watchlistAddPanel.hidden = false;
      if (isInCachedWatchlist(code)) {
        // Already in watchlist.json, just not fetched into data/stocks/ yet —
        // that only happens on the next scheduled Actions run (or a manual
        // workflow_dispatch), never immediately after the commit. Showing the
        // "+ 加入" button again here would be confusing (it IS already added),
        // so explain the actual wait instead of re-inviting them to add it.
        els.watchlistAddBtn.hidden = true;
        els.watchlistTokenHint.hidden = true;
        els.ghTokenReset.hidden = true;
        setAddStatus(
          `${code} 已經在常駐清單裡了，只是資料還沒被排程抓進來——要等下次排程更新` +
          `（平日 17:30／21:30）或你自己到 GitHub 專案的 Actions 頁面手動 Run workflow，` +
          `跑完之後才會變成離線快取。在那之前開啟這檔股票都還是會像現在這樣即時查詢一次。`
        );
      } else {
        els.watchlistAddBtn.dataset.code = code;
        els.watchlistAddBtn.hidden = false;
        els.watchlistTokenHint.hidden = false;
        updateTokenHint(); // async; also self-heals localStorage from the Cache Storage backup if needed
      }
    } else {
      els.watchlistAddPanel.hidden = true;
    }

    els.stockCard.hidden = false;
    els.emptyState.hidden = true;
  }

  function renderQuickStats(payload) {
    const priceRows = payload.price.daily;
    const lastPrice = priceRows[priceRows.length - 1];
    const prevPrice = priceRows[priceRows.length - 2];
    const lastInst = payload.institutional[payload.institutional.length - 1];
    const lastVal = payload.valuation[payload.valuation.length - 1];

    const chips = [];
    if (lastPrice) {
      const chg = prevPrice ? lastPrice.close - prevPrice.close : null;
      const chgPct = prevPrice && prevPrice.close ? (chg / prevPrice.close) * 100 : null;
      chips.push({
        label: `收盤 ${lastPrice.date.slice(5)}`,
        value: fmtPrice(lastPrice.close),
        note: chgPct != null ? `${chgPct > 0 ? "+" : ""}${chgPct.toFixed(2)}%` : "",
        cls: chgPct == null ? "" : signClass(chgPct),
      });
    }
    if (lastVal) {
      chips.push({ label: "本益比 PER", value: lastVal.per ?? "—" });
      chips.push({ label: "股價淨值比 PBR", value: lastVal.pbr ?? "—" });
    }
    if (lastInst) {
      chips.push({ label: "法人合計(張)", value: fmtNum(lastInst.total), cls: signClass(lastInst.total) });
    }

    const compositePreview = computeComposite(
      computeInstSignal(payload),
      computeMarginSignal(payload, ranges.signalLookback || 10, ranges.marginRatio || 60),
      computeShortSignal(payload, ranges.signalLookback || 10)
    );
    if (compositePreview.available) {
      chips.push({ label: "籌碼訊號", value: compositePreview.shortLabel, cls: compositePreview.cls });
    }

    els.quickStats.innerHTML = chips
      .map(
        (c) =>
          `<div class="stat-chip"><div class="stat-label">${c.label}</div><div class="stat-value ${c.cls || ""}">${c.value}${c.note ? ` <span class="tc-note">${c.note}</span>` : ""}</div></div>`
      )
      .join("");
  }

  // ---------- tabs ----------

  function renderActiveTab() {
    if (!currentPayload) return;
    if (currentTab === "price") renderPriceTab();
    else if (currentTab === "chips") renderChipsTab();
    else if (currentTab === "inst") renderInstTab();
    else if (currentTab === "lending") renderLendingTab();
    else if (currentTab === "signal") renderSignalTab();
    else if (currentTab === "report") renderReportTab();
  }

  function sliceRange(rows, n) {
    return n >= 9999 ? rows : rows.slice(-n);
  }

  function renderPriceTab() {
    const p = currentPayload;
    const bucket = pricePeriod === "monthly" ? p.price.monthly : pricePeriod === "quarterly" ? p.price.quarterly : p.price.daily;
    const rows = pricePeriod === "daily" ? sliceRange(bucket, ranges.price) : bucket.slice(-24);

    const chartEl = document.getElementById("price-chart");
    if (pricePeriod === "daily" && p.technical.length) {
      const techByDate = new Map(p.technical.map((t) => [t.date, t]));
      const closeSeries = rows.map((r) => r.close);
      const ema5 = rows.map((r) => techByDate.get(r.date)?.ema5 ?? null);
      const ema20 = rows.map((r) => techByDate.get(r.date)?.ema20 ?? null);
      const ema60 = rows.map((r) => techByDate.get(r.date)?.ema60 ?? null);
      renderLineChart(chartEl, rows, [
        { points: closeSeries, color: COLORS.text, width: 2 },
        { points: ema5, color: COLORS.gold, width: 1.3 },
        { points: ema20, color: COLORS.blue, width: 1.3 },
        { points: ema60, color: "#c56b7a", width: 1.3, opacity: 0.9 },
      ]);
    } else {
      renderLineChart(chartEl, rows, [{ points: rows.map((r) => r.close), color: COLORS.text, width: 2 }]);
    }

    // technical snapshot cards (based on latest daily technical row, regardless of period toggle)
    const lastTech = p.technical[p.technical.length - 1];
    document.getElementById("tech-cards").innerHTML = lastTech
      ? [
          {
            label: "RSI(14)",
            value: lastTech.rsi14 ?? "—",
            note: lastTech.rsi14 == null ? "" : lastTech.rsi14 >= 70 ? "偏超買" : lastTech.rsi14 <= 30 ? "偏超賣" : "中性",
          },
          {
            label: "MACD 柱",
            value: lastTech.macdHist ?? "—",
            note: lastTech.macdHist == null ? "" : lastTech.macdHist > 0 ? "偏多" : "偏空",
          },
          {
            label: "KD",
            value: lastTech.kdK != null ? `K${lastTech.kdK.toFixed(0)} / D${lastTech.kdD.toFixed(0)}` : "—",
            note:
              lastTech.kdK == null
                ? ""
                : lastTech.kdK >= 80
                ? "偏超買"
                : lastTech.kdK <= 20
                ? "偏超賣"
                : lastTech.kdK > lastTech.kdD
                ? "K>D 偏多"
                : "K<D 偏空",
          },
          {
            label: "均線排列",
            value: lastTech.ema5 != null && lastTech.ema20 != null ? (lastTech.ema5 > lastTech.ema20 ? "多頭" : "空頭") : "—",
            note: "EMA5 vs EMA20",
          },
        ]
          .map(
            (c) =>
              `<div class="tech-card"><div class="tc-label">${c.label}</div><div class="tc-value">${c.value}</div><div class="tc-note">${c.note}</div></div>`
          )
          .join("")
      : `<p class="footnote">目前價格資料不足，無法計算技術指標。</p>`;

    // table
    const tbody = document.getElementById("price-tbody");
    tbody.innerHTML = "";
    const labelFn = pricePeriod === "daily" ? (r) => r.date : (r) => r.period;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td class="col-date">${labelFn(r)}</td>` +
        `<td data-label="開">${fmtPrice(r.open)}</td>` +
        `<td data-label="高">${fmtPrice(r.max ?? r.high)}</td>` +
        `<td data-label="低">${fmtPrice(r.min ?? r.low)}</td>` +
        `<td data-label="收">${fmtPrice(r.close)}</td>` +
        `<td data-label="量">${fmtNum(Math.round((r.volume || 0) / 1000))}</td>`;
      tbody.appendChild(tr);
    }
  }

  function renderChipsTab() {
    const p = currentPayload;
    const marginRows = sliceRange(p.margin, ranges.chips);
    renderDivergingBars(document.getElementById("margin-chart"), marginRows, (r) => r.marginChange);

    const mtbody = document.getElementById("margin-tbody");
    mtbody.innerHTML = "";
    for (let i = marginRows.length - 1; i >= 0; i--) {
      const r = marginRows[i];
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td class="col-date">${r.date}</td>` +
        `<td data-label="融資增減" class="${signClass(r.marginChange)}">${fmtNum(r.marginChange)}</td>` +
        `<td data-label="融資餘額">${fmtNum(r.marginBalance)}</td>` +
        `<td data-label="融券增減" class="${signClass(r.shortChange)}">${fmtNum(r.shortChange)}</td>` +
        `<td data-label="融券餘額">${fmtNum(r.shortBalance)}</td>`;
      mtbody.appendChild(tr);
    }

    const shareRows = sliceRange(p.shareholding, ranges.chips);
    renderLineChart(document.getElementById("share-chart"), shareRows, [
      { points: shareRows.map((r) => r.foreignSharesRatio), color: COLORS.gold, width: 2 },
    ]);

    const chipsNote = document.getElementById("chips-empty-note");
    if (p.margin.length === 0 && p.shareholding.length === 0) {
      chipsNote.hidden = false;
    } else {
      chipsNote.hidden = true;
    }
  }

  function renderInstTab() {
    const p = currentPayload;
    const last = p.institutional[p.institutional.length - 1];
    if (last) {
      document.getElementById("ledger-total").textContent = fmtNum(last.total) + " 張";
      document.getElementById("ledger-total").className = "ledger-total " + signClass(last.total);
      document.getElementById("ledger-date").textContent = last.date;
      renderFlowBar(last);
    }

    const rows = sliceRange(p.institutional, ranges.inst);
    renderDivergingBars(document.getElementById("inst-chart"), rows, (r) => r.total);

    const tbody = document.getElementById("inst-tbody");
    tbody.innerHTML = "";
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td class="col-date">${r.date}</td>` +
        `<td data-label="外資" class="${signClass(r.foreign)}">${fmtNum(r.foreign)}</td>` +
        `<td data-label="投信" class="${signClass(r.trust)}">${fmtNum(r.trust)}</td>` +
        `<td data-label="自營商" class="${signClass(r.dealer)}">${fmtNum(r.dealer)}</td>` +
        `<td data-label="合計" class="col-total ${signClass(r.total)}">${fmtNum(r.total)}</td>`;
      tbody.appendChild(tr);
    }
  }

  function renderFlowBar(day) {
    const parts = [
      { key: "foreign", val: day.foreign, cls: "flow-seg-foreign" },
      { key: "trust", val: day.trust, cls: "flow-seg-trust" },
      { key: "dealer", val: day.dealer, cls: "flow-seg-dealer" },
    ];
    const sumAbs = parts.reduce((s, p) => s + Math.abs(p.val), 0) || 1;
    const el = document.getElementById("flow-bar");
    el.innerHTML = "";
    for (const p of parts) {
      const seg = document.createElement("div");
      seg.className = "flow-seg " + p.cls + (p.val < 0 ? " is-sell" : "");
      seg.style.width = (Math.abs(p.val) / sumAbs) * 100 + "%";
      seg.title = `${p.key}: ${fmtNum(p.val)}`;
      el.appendChild(seg);
    }
  }

  function renderLendingTab() {
    const p = currentPayload;
    const rows = sliceRange(p.lending, ranges.lending);
    renderBars(document.getElementById("lending-chart"), rows, (r) => r.volume, COLORS.gold);

    // 融券借券賣出餘額（官方快照逐日累積，只有常駐清單股票才有）
    const sblEl = document.getElementById("lending-sbl-summary");
    if (sblEl) {
      const sblRows = (p.sbl || []).filter((r) => r.balance != null);
      if (sblRows.length) {
        const last = sblRows[sblRows.length - 1];
        const first = sblRows[0];
        const net = last.balance - first.balance;
        const netTxt = sblRows.length > 1
          ? `，自 ${first.date} 累積以來${net > 0 ? "淨增 " : net < 0 ? "淨減 " : "持平 "}${fmtAbsNum(net)} 張（已累積 ${sblRows.length} 個交易日）`
          : "（快照才剛開始累積，趨勢要等幾天後才看得出來）";
        sblEl.textContent =
          `借券賣出餘額：${fmtAbsNum(last.balance)} 張（${last.date}）${netTxt}` +
          (p.sblUnitDivisor ? "" : "【單位未校正，首次啟用請對照官方頁核對數字】");
        sblEl.hidden = false;
      } else {
        sblEl.hidden = true;
      }
    }

    const tbody = document.getElementById("lending-tbody");
    tbody.innerHTML = "";
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td class="col-date">${r.date}</td>` +
        `<td data-label="量">${fmtNum(r.volume)}</td>` +
        `<td data-label="費率">${r.avgFeeRate ?? "—"}</td>`;
      tbody.appendChild(tr);
    }
    if (p.lending.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" class="col-date">此股票近期沒有借券成交紀錄。</td></tr>`;
    }
  }

  // ---------- 籌碼結構訊號判讀 (rule-based, not a probability model) ----------
  //
  // Generalizes the hand-worked single-stock chip-structure writeup into three
  // reusable, data-backed checks using only what this app actually has:
  //   1. 法人結構 — is today's institutional net (buy/sell) small & dealer-led
  //      (mechanical, e.g. warrant-hedging/market-making) or large & led by
  //      foreign/trust (more likely directional)?
  //   2. 融資健康度 — weighted-average cost of margin money that entered over
  //      the lookback window, unrealized loss vs current price, and an
  //      approximate maintenance ratio / forced-liquidation buffer.
  //   3. 券資氣氛 — are short sellers (融券) net covering or net adding, and
  //      what's the recent 借券 (securities lending) volume trend?
  // Deliberately NOT included: 券商分點進出 and 內外盤比 — this app has no
  // data source for either (see README), so those two checks always read
  // "資料不足" here rather than being silently guessed at.

  function toDateCloseMap(priceRows) {
    const m = new Map();
    for (const r of priceRows) m.set(r.date, r.close);
    return m;
  }

  function scoreCls(score) { return score > 0 ? "is-buy" : score < 0 ? "is-sell" : "is-flat"; }

  // 近 N 日淨增減 = 窗口最後一列餘額 − 窗口起點前的基準餘額。
  // 保證跟畫面上顯示的「餘額」永遠自洽（不會再出現餘額 0 卻淨增 9 張）。
  function windowNetFromBalance(series, lookback, balanceKey, changeKey) {
    if (!series.length) return 0;
    const rows = series.slice(-lookback);
    const last = rows[rows.length - 1];
    const beforeIdx = series.length - rows.length - 1;
    const baseline = beforeIdx >= 0
      ? series[beforeIdx][balanceKey]
      : rows[0][balanceKey] - (rows[0][changeKey] || 0);
    if (last[balanceKey] == null || baseline == null) return 0;
    return last[balanceKey] - baseline;
  }

  function computeInstSignal(payload) {
    const priceRows = payload.price.daily;
    const lastPrice = priceRows[priceRows.length - 1];
    const instRows = payload.institutional;
    const lastInst = instRows[instRows.length - 1];
    if (!lastPrice || !lastInst) return { available: false };
    const volumeLots = Math.round((lastPrice.volume || 0) / 1000);
    if (!volumeLots) return { available: false };

    const pctOfVolume = (Math.abs(lastInst.total) / volumeLots) * 100;
    const dealerAbs = Math.abs(lastInst.dealer);
    const directionalAbs = Math.abs(lastInst.foreign) + Math.abs(lastInst.trust);
    const dealerDominant = dealerAbs >= directionalAbs;

    let score = 0, label = "買賣互抵", reason =
      `三大法人今日買賣互抵（合計 ${fmtNum(lastInst.total)} 張），無明顯方向。`;

    if (lastInst.total > 0) {
      score = 1;
      label = "法人買超";
      reason = `三大法人合計買超 ${fmtAbsNum(lastInst.total)} 張，佔當日成交量約 ${pctOfVolume.toFixed(1)}%。`;
    } else if (lastInst.total < 0) {
      if (pctOfVolume < 15 && dealerDominant) {
        score = 1;
        label = "賣壓偏機制性";
        reason =
          `三大法人合計賣超 ${fmtAbsNum(lastInst.total)} 張，僅占當日成交量約 ${pctOfVolume.toFixed(1)}%，` +
          `且以自營商為主（自營商 ${fmtNum(lastInst.dealer)} 張，外資+投信合計 ${fmtNum(lastInst.foreign + lastInst.trust)} 張），` +
          `較可能是權證避險／造市等機制性調節，而非外資或投信主動看空出貨。`;
      } else {
        score = -1;
        label = "賣壓偏方向性";
        reason =
          `三大法人合計賣超 ${fmtAbsNum(lastInst.total)} 張，占當日成交量約 ${pctOfVolume.toFixed(1)}%` +
          `${dealerDominant ? "" : "，且以外資／投信為主"}，規模或組成上較像主動調節，需留意。`;
      }
    }

    return { available: true, score, label, reason, date: lastInst.date };
  }

  function computeMarginSignal(payload, lookback, marginRatioPct) {
    const priceRows = payload.price.daily;
    const lastPrice = priceRows[priceRows.length - 1];
    const marginRows = payload.margin.slice(-lookback);
    if (!lastPrice || !marginRows.length) return { available: false };

    const priceMap = toDateCloseMap(priceRows);
    // 窗口淨增減用「首尾餘額差」而非逐日變動加總：
    // 基準 = 窗口前一列的餘額；窗口涵蓋整個序列時，用第一列餘額減其當日變動回推。
    const netChangeAll = windowNetFromBalance(payload.margin, lookback, "marginBalance", "marginChange");
    let sumChange = 0, sumChangeCost = 0;
    for (const r of marginRows) {
      if (r.marginChange > 0) {
        const close = priceMap.get(r.date);
        if (close != null) {
          sumChange += r.marginChange;
          sumChangeCost += r.marginChange * close;
        }
      }
    }
    if (sumChange <= 0) return { available: false, netChangeAll };

    const weightedCost = sumChangeCost / sumChange;
    const currentClose = lastPrice.close;
    const lossPct = ((currentClose - weightedCost) / weightedCost) * 100;
    const marginRatio = marginRatioPct / 100;
    const estMaintenance = (currentClose / weightedCost / marginRatio) * 100;

    let riskLabel, riskScore;
    if (estMaintenance >= 150) { riskLabel = "斷頭壓力低"; riskScore = 1; }
    else if (estMaintenance >= 130) { riskLabel = "接近警戒水位"; riskScore = 0; }
    else { riskLabel = "斷頭壓力高"; riskScore = -1; }

    const balanceTrendTxt = netChangeAll > 0 ? "淨增加" : netChangeAll < 0 ? "淨減少" : "持平";
    const reason =
      `近 ${lookback} 個交易日新增融資的加權平均成本約 ${fmtPrice(weightedCost)} 元` +
      `（用當日收盤價近似估算，非真實成交均價）；對比現價 ${fmtPrice(currentClose)} 元，帳面損益約 ` +
      `${lossPct > 0 ? "+" : ""}${lossPct.toFixed(1)}%。以融資成數 ${marginRatioPct}% 概算，估計維持率約 ` +
      `${estMaintenance.toFixed(0)}%。近 ${lookback} 日融資餘額${balanceTrendTxt} ${fmtAbsNum(netChangeAll)} 張。`;

    return { available: true, score: riskScore, label: riskLabel, reason, weightedCost, lossPct, estMaintenance };
  }

  function computeShortSignal(payload, lookback) {
    const marginRows = payload.margin.slice(-lookback);
    const sblRows = (payload.sbl || []).filter((r) => r.balance != null);
    if (!marginRows.length && !sblRows.length) return { available: false };

    const shortNet = marginRows.length
      ? windowNetFromBalance(payload.margin, lookback, "shortBalance", "shortChange")
      : null;
    // sbl rows carry no per-day change field; windowNetFromBalance's fallback
    // baseline (first row's balance) makes this a clean first-vs-last diff.
    const sblNet = sblRows.length
      ? windowNetFromBalance(sblRows, lookback, "balance", "change")
      : null;
    const sblLast = sblRows.length ? sblRows[sblRows.length - 1] : null;
    const sblUnitOk = !!payload.sblUnitDivisor;

    const lendingRows = payload.lending.slice(-lookback);
    const lastLendingVol = lendingRows.length ? lendingRows[lendingRows.length - 1].volume : null;

    // 合併淨變化：融券 + 借券賣出餘額都是「還在場上的空方部位」，同單位(張)可相加。
    // 借券單位未校正時不納入評分，只在文字中揭露並標註未驗證。
    const combinedNet = (shortNet || 0) + (sblNet != null && sblUnitOk ? sblNet : 0);
    let score = 0, label = "券資持平";
    if (combinedNet < 0) { score = 1; label = "空頭回補為主"; }
    else if (combinedNet > 0) { score = -1; label = "空頭增碼為主"; }

    const parts = [];
    if (shortNet != null) {
      parts.push(
        `融券餘額${shortNet < 0 ? "淨減少（回補）" : shortNet > 0 ? "淨增加（加碼放空）" : "持平"} ${fmtAbsNum(shortNet)} 張`
      );
    }
    if (sblLast != null) {
      parts.push(
        `借券賣出餘額 ${fmtAbsNum(sblLast.balance)} 張（${sblLast.date}）` +
        (sblNet != null ? `，區間${sblNet < 0 ? "淨減 " : sblNet > 0 ? "淨增 " : "持平 "}${fmtAbsNum(sblNet)} 張` : "") +
        (sblUnitOk ? "" : "【單位未校正，僅供參考】")
      );
    }
    if (lastLendingVol != null) parts.push(`最近一日借券成交量 ${fmtAbsNum(lastLendingVol)} 張`);
    const reason = `近 ${lookback} 個交易日：` + parts.join("；") + "。";

    return { available: true, score, label, reason, shortNet, sblNet, sblLast };
  }

  function computeComposite(instSig, marginSig, shortSig) {
    const parts = [];
    if (instSig.available) parts.push(instSig.score);
    if (marginSig.available) parts.push(marginSig.score);
    if (shortSig.available) parts.push(shortSig.score);
    if (!parts.length) return { available: false, count: 0 };

    const sum = parts.reduce((a, b) => a + b, 0);
    let shortLabel, cls;
    if (sum >= 2) { shortLabel = "偏多"; cls = "is-buy"; }
    else if (sum === 1) { shortLabel = "略偏多"; cls = "is-buy"; }
    else if (sum === 0) { shortLabel = "中性／訊號不一致"; cls = "is-flat"; }
    else if (sum === -1) { shortLabel = "略偏空"; cls = "is-sell"; }
    else { shortLabel = "偏空"; cls = "is-sell"; }

    return { available: true, count: parts.length, sum, shortLabel, cls, label: "籌碼訊號" + shortLabel };
  }

  function signalCard(title, label, cls, reason) {
    return (
      `<div class="signal-card">` +
      `<div class="signal-card-head"><span class="signal-card-title">${title}</span>` +
      `<span class="signal-card-badge ${cls}">${escapeHtml(label)}</span></div>` +
      `<p class="signal-card-reason">${reason}</p>` +
      `</div>`
    );
  }

  function renderSignalTab() {
    const p = currentPayload;
    const lookback = ranges.signalLookback || 10;
    const marginRatioPct = ranges.marginRatio || 60;

    const instSig = computeInstSignal(p);
    const marginSig = computeMarginSignal(p, lookback, marginRatioPct);
    const shortSig = computeShortSignal(p, lookback);
    const composite = computeComposite(instSig, marginSig, shortSig);

    const lastInstDate = p.institutional.length ? p.institutional[p.institutional.length - 1].date : "";
    document.getElementById("signal-verdict").innerHTML = composite.available
      ? `<div class="ledger-label">綜合判讀（${composite.count}/3 項訊號可用，非機率、非勝率）</div>` +
        `<div class="ledger-total ${composite.cls}">${composite.label}</div>` +
        `<div class="ledger-date">${lastInstDate}</div>`
      : `<div class="ledger-label">綜合判讀</div>` +
        `<div class="ledger-total is-flat">資料不足</div>` +
        `<div class="ledger-date">這檔股票近期缺法人／融資／融券資料，無法判讀。</div>`;

    const cards = [
      instSig.available
        ? signalCard("法人結構", instSig.label, scoreCls(instSig.score), instSig.reason)
        : signalCard("法人結構", "資料不足", "is-flat", "近期查無三大法人買賣超或成交量資料。"),
      marginSig.available
        ? signalCard("融資健康度", marginSig.label, scoreCls(marginSig.score), marginSig.reason)
        : signalCard(
            "融資健康度",
            "資料不足",
            "is-flat",
            `近 ${lookback} 個交易日沒有融資淨增加的交易日，無法估算加權成本；也可能是這檔股票融資交易量本來就很少，或處於不可信用交易狀態。`
          ),
      shortSig.available
        ? signalCard("券資氣氛", shortSig.label, scoreCls(shortSig.score), shortSig.reason)
        : signalCard("券資氣氛", "資料不足", "is-flat", "近期查無融券或借券資料。"),
    ];
    document.getElementById("signal-cards").innerHTML = cards.join("");
  }

  // ---------- 每日籌碼結構報告 (report tab) ----------
  //
  // Mirrors the section structure of a manually-written single-stock 籌碼分析
  // writeup, restricted to what's actually computable from this app's data.
  // Reuses computeInstSignal/computeMarginSignal/computeShortSignal from the
  // 訊號 tab so the two views never disagree about the same underlying
  // numbers. Two things are NEVER shown as computed figures, only as an
  // explicit "做不到" note with the reason: 分點進出 (needs FinMind's paid
  // TaiwanStockTradingDailyReport) and 內外盤 (needs tick-level order-book
  // data no source here has). Faking either with a substitute number would
  // be worse than clearly saying it's unavailable.
  //
  // The "三大核心假說" / "明日情境一二三" framing from a typical hand-written
  // writeup is deliberately NOT reproduced as-is: presenting a forced single
  // narrative or next-day scenarios (with or without an attached percentage)
  // is a predictive claim dressed as data, not a report of data. Section 五
  // lists each available signal's own reading without collapsing them into
  // one verdict; section 六 lists concrete technical levels to watch instead
  // of a scenario tree with implied odds.

  function reportVolumeTrend(payload) {
    const rows = payload.price.daily;
    if (rows.length < 2) return null;
    const last = rows[rows.length - 1];
    const priorRows = rows.slice(0, -1).slice(-5);
    const lastLots = Math.round((last.volume || 0) / 1000);
    if (!priorRows.length) return { lastLots, avg5Lots: null, ratioPct: null };
    const avg5 = priorRows.reduce((s, rr) => s + (rr.volume || 0), 0) / priorRows.length;
    return { lastLots, avg5Lots: Math.round(avg5 / 1000), ratioPct: avg5 ? (last.volume / avg5) * 100 : null };
  }

  function reportInstStructure(payload) {
    const rows = payload.institutional;
    const last = rows[rows.length - 1];
    if (!last) return null;
    const parts = [
      { name: "外資", value: last.foreign },
      { name: "投信", value: last.trust },
      { name: "自營商", value: last.dealer },
    ];
    return {
      date: last.date,
      total: last.total,
      sellers: parts.filter((c) => c.value < 0).sort((a, b) => a.value - b.value),
      buyers: parts.filter((c) => c.value > 0).sort((a, b) => b.value - a.value),
    };
  }

  function reportLendingSnapshot(payload, lookback) {
    const rows = payload.lending.slice(-lookback);
    if (!rows.length) return null;
    const last = rows[rows.length - 1];
    const prior = rows.slice(0, -1);
    const avgPrior = prior.length ? prior.reduce((s, rr) => s + (rr.volume || 0), 0) / prior.length : null;
    return { date: last.date, lastVolume: last.volume, avgFeeRate: last.avgFeeRate, avgPriorVolume: avgPrior };
  }

  function reportSblSnapshot(payload, lookback) {
    const rows = (payload.sbl || []).filter((r) => r.balance != null).slice(-lookback);
    if (!rows.length) return null;
    const last = rows[rows.length - 1];
    return {
      date: last.date,
      balance: last.balance,
      net: rows.length > 1 ? last.balance - rows[0].balance : null,
      days: rows.length,
      unitVerified: !!payload.sblUnitDivisor,
    };
  }

  function buildDailyReport(payload, lookback, marginRatioPct) {
    const priceRows = payload.price.daily;
    const lastPrice = priceRows[priceRows.length - 1];
    if (!lastPrice) return null;
    const prevPrice = priceRows[priceRows.length - 2];
    const chgPct = prevPrice && prevPrice.close ? ((lastPrice.close - prevPrice.close) / prevPrice.close) * 100 : null;
    const lastMarginRow = payload.margin[payload.margin.length - 1] || null;

    return {
      date: lastPrice.date,
      close: lastPrice.close,
      chgPct,
      volumeLots: Math.round((lastPrice.volume || 0) / 1000),
      lastTech: payload.technical[payload.technical.length - 1] || null,
      volumeTrend: reportVolumeTrend(payload),
      instStructure: reportInstStructure(payload),
      instSig: computeInstSignal(payload),
      marginSig: computeMarginSignal(payload, lookback, marginRatioPct),
      shortSig: computeShortSignal(payload, lookback),
      lendingSnap: reportLendingSnapshot(payload, lookback),
      sblSnap: reportSblSnapshot(payload, lookback),
      lastMarginRow,
      lookback,
    };
  }

  function reportSection(title, bodyHtml) {
    return `<div class="report-section"><h3 class="report-h">${title}</h3>${bodyHtml}</div>`;
  }

  // ---------- 分點分析請求（對話式 workaround） ----------
  //
  // Broker-branch (分點) data is Sponsor-tier on FinMind (verified against
  // finmind.github.io/llms-full.txt: TaiwanStockTradingDailyReport — Tier:
  // Sponsor) and the official TWSE/TPEx query pages are CAPTCHA-gated, so
  // this app cannot fetch it automatically. The workaround: package every
  // number this app DOES have into a structured analysis request, which the
  // user copies into a Claude conversation together with screenshots of the
  // 分點 page (from the official query system or their broker app). Claude
  // reads the screenshots + these numbers and does the cross-referenced
  // chip-structure analysis that this static app can't.

  function officialBranchReportUrl(market) {
    // Both are the authoritative sources every third-party 分點 site rescrapes.
    return market === "上櫃" || market === "tpex"
      ? "https://www.tpex.org.tw/web/stock/aftertrading/broker_trading/brokerBS.php?l=zh-tw"
      : "https://bsr.twse.com.tw/bshtm/";
  }

  // 本 App 抓不到、需要人工查了再貼給 Claude 的三類資料，各附查詢入口。
  // 連結對應「資料缺口」而非「資料集」：每一條都寫清楚能補什麼、有什麼限制。
  function manualDataLinksHtml(code, market) {
    const isTpex = market === "上櫃";
    const yahooUrl = `https://tw.stock.yahoo.com/quote/${code}${isTpex ? ".TWO" : ".TW"}`;
    const sblUrl = isTpex
      ? "https://www.tpex.org.tw/openapi/v1/tpex_margin_sbl"
      : "https://www.twse.com.tw/zh/products/sbl/disclosures/t13sa710.html";
    const sblLabel = isTpex
      ? "櫃買 OpenAPI：上櫃融券借券賣出餘額（JSON，搜尋股號即可）"
      : "證交所：歷史借券成交明細（可選日期區間）";
    return (
      `<p><strong>本 App 做不到、可手動查了補給 Claude 的資料：</strong></p>
      <ul class="manual-links">
        <li>內外盤比：<a href="${yahooUrl}" target="_blank" rel="noopener">Yahoo股市 ${code} 個股頁</a>
          <span class="footnote">只有「當日」看得到，收盤後隔天就查不回來，要當天截圖。</span></li>
        <li>借券明細：<a href="${sblUrl}" target="_blank" rel="noopener">${sblLabel}</a>
          <span class="footnote">借券賣出「餘額」已內建（借券分頁），此連結留作首次啟用時核對單位用。「哪個分點借的、賣在哪個價位」沒有任何公開來源，查不到是正常的。</span></li>
        <li>分點歷史背景（權證避險/外資指標分點的長期底倉）：沒有官方來源，
          需用你的券商 App 或第三方籌碼平台查該分點的歷史區間買賣，截圖附給 Claude。</li>
      </ul>`
    );
  }

  function buildClaudeBranchPrompt(code, payload, report, stockName, market) {
    const r = report;
    const t = r.lastTech;
    const inst = r.instStructure;
    const m = r.lastMarginRow;
    const lines = [];

    lines.push(`請幫我做 ${stockName}(${code}) ${r.date} 的券商分點籌碼結構分析。`);
    lines.push("");
    lines.push("我會附上當日券商分點買賣明細的截圖或CSV（來自證交所/櫃買中心買賣日報表查詢系統或券商App），請先把裡面的分點數據讀出來，再跟下面我的 App 已經算好的數據交叉比對。");
    lines.push("如有另外附上：內外盤比截圖（Yahoo股市當日）、借券明細截圖、特定分點的歷史買賣區間截圖，也請一併納入分析；沒附的部分照舊直說做不到。");
    lines.push("");
    lines.push("=== 我的 App 已有的數據（單位：張） ===");
    lines.push(`收盤 ${fmtPrice(r.close)} 元（${r.chgPct != null ? (r.chgPct > 0 ? "+" : "") + r.chgPct.toFixed(2) + "%" : "—"}），成交量 ${fmtAbsNum(r.volumeLots)} 張` +
      (r.volumeTrend && r.volumeTrend.ratioPct != null ? `（近5日均量的 ${r.volumeTrend.ratioPct.toFixed(0)}%）` : ""));
    if (inst) {
      lines.push(`三大法人：外資 ${fmtNum(payload.institutional[payload.institutional.length - 1].foreign)}、投信 ${fmtNum(payload.institutional[payload.institutional.length - 1].trust)}、自營商 ${fmtNum(payload.institutional[payload.institutional.length - 1].dealer)}，合計 ${fmtNum(inst.total)}`);
    }
    if (m) {
      lines.push(`融資餘額 ${fmtAbsNum(m.marginBalance)} 張（單日${m.marginChange > 0 ? "淨增 " + fmtAbsNum(m.marginChange) : m.marginChange < 0 ? "淨減 " + fmtAbsNum(m.marginChange) : "持平"}張）；融券餘額 ${fmtAbsNum(m.shortBalance)} 張`);
    }
    if (r.marginSig.available) lines.push(`融資估算：${r.marginSig.reason}`);
    if (r.shortSig.available) lines.push(`券資：${r.shortSig.reason}`);
    if (r.lendingSnap) lines.push(`借券：最近一日新成交 ${fmtAbsNum(r.lendingSnap.lastVolume)} 張${r.lendingSnap.avgFeeRate != null ? `，平均費率 ${r.lendingSnap.avgFeeRate}%` : ""}`);
    if (r.sblSnap) {
      lines.push(
        `借券賣出餘額：${fmtAbsNum(r.sblSnap.balance)} 張（${r.sblSnap.date}，官方快照）` +
        (r.sblSnap.net != null ? `；快照累積 ${r.sblSnap.days} 個交易日${r.sblSnap.net > 0 ? "淨增 " : r.sblSnap.net < 0 ? "淨減 " : "持平 "}${fmtAbsNum(r.sblSnap.net)} 張` : "") +
        (r.sblSnap.unitVerified ? "" : "（單位未校正，數字僅供參考）")
      );
    }
    if (t) {
      lines.push(`技術面：EMA5 ${fmtPrice(t.ema5)}／EMA20 ${fmtPrice(t.ema20)}／EMA60 ${fmtPrice(t.ema60)}，RSI14 ${t.rsi14 ?? "—"}，MACD柱 ${t.macdHist ?? "—"}，KD K${t.kdK != null ? t.kdK.toFixed(0) : "—"}/D${t.kdD != null ? t.kdD.toFixed(0) : "—"}`);
    }
    lines.push("");
    lines.push("=== 請分析 ===");
    lines.push("1. 從截圖整理主要賣超分點與買超分點（名稱、張數、均價），有歷史背景的分點（例如權證發行商避險分點、外資指標分點）請標註。");
    lines.push("2. 交叉比對：分點賣壓跟三大法人數據對不對得起來？賣壓是機制性（造市/避險）還是方向性？");
    lines.push("3. 買方結構：主要承接分點的買超均價落在哪個區間，跟均線位階的關係。");
    lines.push("4. 結合融資融券與借券數據，說明多空雙方的結構。");
    lines.push("5. 只根據數據講得出來的部分，講不出來的請直說做不到，不要腦補。");

    return lines.join("\n");
  }

  function renderReportTab() {
    const p = currentPayload;
    const lookback = ranges.signalLookback || 10;
    const marginRatioPct = ranges.marginRatio || 60;
    const r = buildDailyReport(p, lookback, marginRatioPct);
    const el = document.getElementById("report-body");
    if (!r) {
      el.innerHTML = `<p class="footnote">股價資料不足，無法產生報告。</p>`;
      return;
    }

    const chgTxt = r.chgPct != null ? `${r.chgPct > 0 ? "+" : ""}${r.chgPct.toFixed(2)}%` : "—";
    const chgCls = r.chgPct == null ? "" : signClass(r.chgPct);
    const t = r.lastTech;

    const sections = [];

    sections.push(
      reportSection(
        "一、基本盤勢整理",
        `<div class="tech-cards">
          <div class="tech-card"><div class="tc-label">收盤價</div><div class="tc-value">${fmtPrice(r.close)}</div></div>
          <div class="tech-card"><div class="tc-label">漲跌幅</div><div class="tc-value ${chgCls}">${chgTxt}</div></div>
          <div class="tech-card"><div class="tc-label">成交量(張)</div><div class="tc-value">${fmtAbsNum(r.volumeLots)}</div></div>
        </div>
        <p class="footnote">內外盤（買方/賣方主動成交比）需要逐筆成交揭示（tick-level order book）資料，FinMind 免費版與本工具目前串接的資料源都沒有這項，無法計算，不會用其他欄位湊一個代替數字。</p>`
      )
    );

    const volTxt = r.volumeTrend && r.volumeTrend.ratioPct != null
      ? `${fmtAbsNum(r.volumeTrend.lastLots)}張，近5日均量的${r.volumeTrend.ratioPct.toFixed(0)}%`
      : "—";
    sections.push(
      reportSection(
        "二、技術線型分析",
        `<div class="tech-cards">
          <div class="tech-card"><div class="tc-label">量能</div><div class="tc-value" style="font-size:14px">${volTxt}</div></div>
          <div class="tech-card"><div class="tc-label">KD</div><div class="tc-value" style="font-size:15px">${t && t.kdK != null ? `K${t.kdK.toFixed(0)}/D${t.kdD.toFixed(0)}` : "—"}</div></div>
          <div class="tech-card"><div class="tc-label">MACD柱</div><div class="tc-value ${t && t.macdHist != null ? signClass(t.macdHist) : ""}">${t && t.macdHist != null ? t.macdHist : "—"}</div></div>
          <div class="tech-card"><div class="tc-label">RSI(14)</div><div class="tc-value">${t && t.rsi14 != null ? t.rsi14 : "—"}</div></div>
        </div>`
      )
    );

    const entry = (stockIndex && stockIndex.get(currentCode)) || { name: currentCode, market: "" };
    const bsrUrl = officialBranchReportUrl(entry.market);
    sections.push(
      reportSection(
        "三、券商分點軌跡",
        `<p>自動抓取做不到（FinMind 這個資料集是付費 Sponsor 限定，官方查詢系統有驗證碼擋自動化），但可以改用「對話式」半自動：</p>
        <p>1. 到<a href="${bsrUrl}" target="_blank" rel="noopener">官方買賣日報表查詢系統（${entry.market === "上櫃" ? "櫃買中心" : "證交所"}）</a>查 ${currentCode} 當日分點明細，截圖存下來（或用你券商 App 的分點頁截圖）。</p>
        <p>2. 點下面按鈕，會把這檔股票今天所有已知數據打包成一段分析請求、複製到剪貼簿。</p>
        <p>3. 打開 Claude，貼上文字 + 附上截圖，Claude 會讀出分點數據並跟本 App 的法人/融資/借券數據交叉分析。</p>
        <button id="report-copy-prompt" class="watchlist-add-btn" style="margin-top:6px">📋 複製分點分析請求（附截圖給 Claude 用）</button>
        <p id="report-copy-status" class="footnote" hidden></p>
        ${manualDataLinksHtml(currentCode, entry.market)}`
      )
    );

    const fmtParts = (arr) => (arr.length ? arr.map((c) => `${c.name} ${fmtNum(c.value)} 張`).join("、") : "（無）");
    const structHtml = r.instStructure
      ? `<p><strong>一、實質賣方結構：</strong>${fmtParts(r.instStructure.sellers)}</p>
         <p><strong>二、實質買方結構：</strong>${fmtParts(r.instStructure.buyers)}</p>
         <p class="footnote">三大法人合計 ${fmtNum(r.instStructure.total)} 張。只細到外資/投信/自營商層級，細到哪個券商分點無法取得（見上「券商分點軌跡」）。</p>`
      : `<p class="footnote">近期查無三大法人資料。</p>`;

    const mBal = r.lastMarginRow ? fmtAbsNum(r.lastMarginRow.marginBalance) + " 張" : "—";
    const mChg = r.lastMarginRow && r.lastMarginRow.marginChange != null
      ? r.lastMarginRow.marginChange > 0
        ? `淨增 ${fmtAbsNum(r.lastMarginRow.marginChange)} 張`
        : r.lastMarginRow.marginChange < 0
        ? `淨減 ${fmtAbsNum(r.lastMarginRow.marginChange)} 張`
        : "持平"
      : "資料不足";
    const sBal = r.lastMarginRow ? fmtAbsNum(r.lastMarginRow.shortBalance) + " 張" : "—";
    const lend = r.lendingSnap;
    const lendRatio = lend && lend.avgPriorVolume ? `，約為近期日均量(${fmtAbsNum(lend.avgPriorVolume)}張)的 ${((lend.lastVolume / lend.avgPriorVolume) * 100).toFixed(0)}%` : "";

    const sblLine = r.sblSnap
      ? `借券賣出餘額 ${fmtAbsNum(r.sblSnap.balance)} 張（${r.sblSnap.date}）` +
        (r.sblSnap.net != null
          ? `，快照累積 ${r.sblSnap.days} 日${r.sblSnap.net > 0 ? "淨增 " : r.sblSnap.net < 0 ? "淨減 " : "持平 "}${fmtAbsNum(r.sblSnap.net)} 張`
          : "（快照剛開始累積）") +
        (r.sblSnap.unitVerified ? "" : "【單位未校正】") + "。"
      : "";
    const marginLendingHtml = `
      <p><strong>三、融資 &amp; 借券數據：</strong></p>
      <p>融資：今日累計餘額 ${mBal}，單日${mChg}。${r.marginSig.available ? r.marginSig.reason : `近 ${lookback} 個交易日沒有融資淨增加的交易日，無法估算加權成本區。`}</p>
      <p>融券：今日累計餘額 ${sBal}。${r.shortSig.available ? r.shortSig.reason : "近期查無融券資料。"}</p>
      <p>借券：${lend ? `最近一日新成交 ${fmtAbsNum(lend.lastVolume)} 張${lend.avgFeeRate != null ? `，平均費率 ${lend.avgFeeRate}%` : ""}${lendRatio}。` : "近期查無借券成交資料。"}${sblLine}
      <span class="footnote">借券成交量不拆「借券賣出」vs「返還」也沒有成交價格，<strong>無法算出借券的加權平均成本區</strong>，硬湊一個數字出來會是假的，這裡不做。借券賣出餘額來自官方每日快照（常駐清單股票由排程逐日累積，歷史只會從加入清單後開始有）。</span></p>
    `;

    sections.push(reportSection(`四、數據總整理（結合三大法人，回看 ${lookback} 日）`, structHtml + marginLendingHtml));

    const obs = [r.instSig, r.marginSig, r.shortSig].filter((s) => s.available);
    const obsHtml = obs.length
      ? obs.map((s, i) => `<p><strong>觀察 ${i + 1}（${s.label}）：</strong>${s.reason}</p>`).join("")
      : `<p class="footnote">目前可用的訊號不足，無法整理觀察。</p>`;
    sections.push(
      reportSection(
        "五、今日數據觀察",
        obsHtml +
          `<p class="footnote">以上是把上面的原始數據拆開來看、各自的解讀方向，不是收斂成單一結論的「假說」，也不是機率或勝率——同一批數據常常同時支持不只一種解讀，這裡刻意不幫你選定「正確答案」，留給你自己判斷。</p>`
      )
    );

    const levels = [];
    if (t) {
      if (t.ema5 != null) levels.push(`EMA5 ${fmtPrice(t.ema5)}`);
      if (t.ema20 != null) levels.push(`EMA20 ${fmtPrice(t.ema20)}`);
      if (t.ema60 != null) levels.push(`EMA60 ${fmtPrice(t.ema60)}`);
    }
    sections.push(
      reportSection(
        "六、後續關注重點",
        `<p>可對照的均線位階：${levels.length ? levels.join("、") : "資料不足"}。</p>
        <p class="footnote">這裡不做「明日情境一/二/三」式的走勢預測——不管包裝成百分比機率還是別的，對單一交易日的方向做具體推演都超出「純數據整理」能給的確定性。上面列出的是接下來可以拿現價去對照的既有技術位階，站上/跌破分別代表什麼，由你自己依經驗判斷，這不是投資建議。</p>`
      )
    );

    el.innerHTML =
      `<div class="report-meta">${r.date} 收盤後純數據整理，僅供參考，不構成投資建議。回看天數／融資成數可以到「訊號」分頁調整。</div>` +
      sections.join("");

    const copyBtn = document.getElementById("report-copy-prompt");
    if (copyBtn) {
      copyBtn.addEventListener("click", async () => {
        const promptText = buildClaudeBranchPrompt(currentCode, p, r, entry.name || currentCode, entry.market);
        const statusEl = document.getElementById("report-copy-status");
        try {
          await navigator.clipboard.writeText(promptText);
          statusEl.textContent = "已複製！打開 Claude，貼上這段文字並附上分點截圖即可。";
        } catch {
          // iOS clipboard can fail outside a user gesture or in odd contexts;
          // fall back to showing the text so it can be selected manually.
          statusEl.textContent = "自動複製失敗，請手動長按選取下面文字複製：";
          const pre = document.createElement("pre");
          pre.style.cssText = "white-space:pre-wrap;font-size:12px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:10px;user-select:all;-webkit-user-select:all;";
          pre.textContent = promptText;
          statusEl.after(pre);
        }
        statusEl.hidden = false;
      });
    }
  }

  // ---------- events ----------

  let searchDebounce;
  els.search.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => renderSearchResults(searchStocks(els.search.value)), 80);
  });
  els.search.addEventListener("focus", () => {
    if (els.search.value.trim()) renderSearchResults(searchStocks(els.search.value));
  });
  document.addEventListener("click", (e) => {
    if (!els.searchResults.contains(e.target) && e.target !== els.search) els.searchResults.hidden = true;
  });

  for (const btn of els.tabBtns) {
    btn.addEventListener("click", () => {
      els.tabBtns.forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      Object.values(els.panels).forEach((p) => p.classList.remove("is-active"));
      currentTab = btn.dataset.tab;
      els.panels[currentTab].classList.add("is-active");
      renderActiveTab();
    });
  }

  document.querySelectorAll(".period-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".period-chip").forEach((c) => c.classList.remove("is-active"));
      chip.classList.add("is-active");
      pricePeriod = chip.dataset.period;
      renderPriceTab();
    });
  });

  document.querySelectorAll(".range-row").forEach((row) => {
    const scope = row.dataset.scope;
    row.querySelectorAll(".range-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        row.querySelectorAll(".range-chip").forEach((c) => c.classList.remove("is-active"));
        chip.classList.add("is-active");
        ranges[scope] = parseInt(chip.dataset.range, 10);
        renderActiveTab();
      });
    });
  });

  window.addEventListener("hashchange", () => {
    const code = location.hash.replace("#", "");
    if (code) selectStock(code);
  });

  // ---------- boot ----------

  async function boot() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("service-worker.js").catch(() => {});
    }
    wireWatchlistAddPanel();
    renderWatchlistCount();
    setStatus("載入股票清單中…");
    await loadStockList();
    setStatus("");

    const hashCode = location.hash.replace("#", "");
    const startCode = hashCode || DEFAULT_CODE;
    if (loadFavorites().length === 0) saveFavorites([DEFAULT_CODE]);
    renderFavorites();
    selectStock(startCode);
  }

  boot();
})();
