// app.js — 法人籌碼 PWA (股價／籌碼／法人／借券)
(() => {
  "use strict";

  const DEFAULT_CODE = "8069"; // 元太科技
  const FAVORITES_KEY = "tif.favorites.v1";
  const GH_TOKEN_KEY = "tif.githubToken";
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
    watchlistTokenForm: document.getElementById("watchlist-token-form"),
    ghTokenInput: document.getElementById("gh-token-input"),
    ghTokenSave: document.getElementById("gh-token-save"),
    ghTokenSkip: document.getElementById("gh-token-skip"),
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
    },
    emptyState: document.getElementById("empty-state"),
    favoritesList: document.getElementById("favorites-list"),
  };

  let stockList = [];
  let stockIndex = null;
  let currentPayload = null;
  let currentTab = "price";
  let pricePeriod = "daily";
  const ranges = { price: 60, chips: 20, inst: 20, lending: 20 };

  // ---------- generic helpers ----------

  const fmtNum = (n) => {
    if (n == null || Number.isNaN(n)) return "—";
    const sign = n > 0 ? "+" : "";
    return sign + Math.round(n).toLocaleString("zh-TW");
  };
  const fmtPrice = (n) => (n == null || Number.isNaN(n) ? "—" : n.toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
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
    return rows.map((r) => {
      const foreign =
        (r.Foreign_Investor_buy || 0) - (r.Foreign_Investor_sell || 0) +
        (r.Foreign_Dealer_Self_buy || 0) - (r.Foreign_Dealer_Self_sell || 0);
      const trust = (r.Investment_Trust_buy || 0) - (r.Investment_Trust_sell || 0);
      const dealer =
        (r.Dealer_buy || 0) - (r.Dealer_sell || 0) +
        (r.Dealer_self_buy || 0) - (r.Dealer_self_sell || 0) +
        (r.Dealer_Hedging_buy || 0) - (r.Dealer_Hedging_sell || 0);
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
  function normalizeMarginRows(rows) {
    return rows
      .map((r) => ({
        date: r.date,
        marginBalance: r.MarginPurchaseTodayBalance,
        marginChange: (r.MarginPurchaseBuy || 0) - (r.MarginPurchaseSell || 0) - (r.MarginPurchaseCashRepayment || 0),
        shortBalance: r.ShortSaleTodayBalance,
        shortChange: (r.ShortSaleSell || 0) - (r.ShortSaleBuy || 0) - (r.ShortSaleCashRepayment || 0),
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

  function buildTechnical(priceDaily) {
    const closes = priceDaily.map((r) => r.close);
    const e5 = emaSeries(closes, 5), e20 = emaSeries(closes, 20), e60 = emaSeries(closes, 60);
    const r14 = rsiSeries(closes, 14);
    const { macdLine, signalLine, hist } = macdSeries(closes);
    return priceDaily.map((r, i) => ({
      date: r.date,
      ema5: round2(e5[i]), ema20: round2(e20[i]), ema60: round2(e60[i]),
      rsi14: round2(r14[i]),
      macd: round2(macdLine[i]), macdSignal: round2(signalLine[i]), macdHist: round2(hist[i]),
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

  function b64EncodeUnicode(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }

  async function writeWatchlistViaApi(owner, repo, token, newList, addedCode) {
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
        message: `chore: add ${addedCode} to watchlist`,
        content,
        sha: getJson.sha,
      }),
    });
    if (!putRes.ok) {
      const text = await putRes.text().catch(() => "");
      throw new Error(`寫入失敗 (HTTP ${putRes.status}): ${text.slice(0, 150)}`);
    }
  }

  function setAddStatus(msg, isError = false) {
    els.watchlistAddStatus.hidden = !msg;
    els.watchlistAddStatus.textContent = msg;
    els.watchlistAddStatus.style.color = isError ? COLORS.buy : "";
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
      `已把完整清單複製到剪貼簿（含 ${code}）。${editUrl ? "點這裡開啟編輯頁貼上取代全部內容：" + editUrl : "到 GitHub 打開 watchlist.json 貼上取代全部內容。"}下次盤前排程跑完就會快取、可離線查詢。`
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
      setAddStatus(`${code} 已經在常駐清單裡了，可離線快速查詢。`);
      return;
    }

    const token = localStorage.getItem(GH_TOKEN_KEY);
    if (token && or_) {
      try {
        const entry = newWatchlistEntry(code);
        const newList = currentList ? [...currentList, entry] : [entry];
        await writeWatchlistViaApi(or_.owner, or_.repo, token, newList, code);
        setAddStatus(`已把 ${code} 加入常駐清單！下次盤前排程（或手動 Run workflow）跑完就會快取，之後開啟更快、可離線查詢。`);
        renderWatchlistCount();
        return;
      } catch (e) {
        console.warn("auto-write failed:", e.message);
        localStorage.removeItem(GH_TOKEN_KEY);
        setAddStatus(`自動寫入失敗（${e.message}），已改用複製方式。`, true);
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

  // ---------- watchlist log viewer ----------

  async function renderWatchlistCount() {
    const or_ = parseOwnerRepo();
    if (!or_) return;
    try {
      const list = await fetchWatchlistRaw(or_.owner, or_.repo);
      els.watchlistViewCount.textContent = `(${list.length})`;
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
      const entries = raw.map(normalizeWatchlistEntry);
      // most-recently-added first; entries without a timestamp (legacy/manual) sort last, original order preserved among themselves
      const withTime = entries.filter((e) => e.addedAt).sort((a, b) => b.addedAt.localeCompare(a.addedAt));
      const withoutTime = entries.filter((e) => !e.addedAt);
      const ordered = [...withTime, ...withoutTime];

      els.watchlistViewStatus.textContent = `共 ${entries.length} 檔，資料每日盤前 08:00 自動更新。`;
      els.watchlistViewCount.textContent = `(${entries.length})`;

      els.watchlistViewList.innerHTML = "";
      for (const entry of ordered) {
        const info = stockIndex && stockIndex.get(entry.code);
        const name = entry.name || (info && info.name) || entry.code;
        const market = info ? info.market : "";
        const when = entry.addedAt ? new Date(entry.addedAt).toLocaleString("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "原始清單";
        const li = document.createElement("li");
        li.innerHTML = `<span class="wv-name">${escapeHtml(name)}</span><span class="wv-code">${entry.code}</span>` +
          `<div class="wv-meta">${market ? market + " · " : ""}加入時間：${when}</div>`;
        li.addEventListener("click", () => {
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
      localStorage.setItem(GH_TOKEN_KEY, token);
      els.ghTokenInput.value = "";
      els.watchlistTokenForm.hidden = true;
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
      els.watchlistAddBtn.dataset.code = code;
      els.watchlistAddBtn.hidden = false;
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
