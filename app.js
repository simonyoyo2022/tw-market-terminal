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
    saveFavorites(list.slice(0, 12));
    renderFavorites();
  }
  function renderFavorites() {
    const favs = loadFavorites();
    els.favoritesList.innerHTML = "";
    for (const code of favs) {
      const entry = stockIndex && stockIndex.get(code);
      const li = document.createElement("li");
      li.textContent = entry ? `${entry.name} ${code}` : code;
      li.addEventListener("click", () => selectStock(code));
      els.favoritesList.appendChild(li);
    }
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

  // Lightweight live fallback for stocks not in the pre-fetched watchlist:
  // pulls price + institutional flow only (2 calls) directly from the
  // browser. Requires FinMind's server to allow cross-origin requests.
  async function fetchLive(code) {
    const start = isoDaysAgo(130);
    const end = isoDaysAgo(0);

    const priceUrl = new URL(FINMIND_URL);
    priceUrl.searchParams.set("dataset", "TaiwanStockPrice");
    priceUrl.searchParams.set("data_id", code);
    priceUrl.searchParams.set("start_date", start);
    priceUrl.searchParams.set("end_date", end);

    const instUrl = new URL(FINMIND_URL);
    instUrl.searchParams.set("dataset", "TaiwanStockInstitutionalInvestorsBuySellWide");
    instUrl.searchParams.set("data_id", code);
    instUrl.searchParams.set("start_date", start);
    instUrl.searchParams.set("end_date", end);

    const [priceRes, instRes] = await Promise.all([fetch(priceUrl), fetch(instUrl)]);
    if (!priceRes.ok && !instRes.ok) throw new Error("live fetch failed");

    const priceJson = priceRes.ok ? await priceRes.json() : { data: [] };
    const instJson = instRes.ok ? await instRes.json() : { data: [] };

    const price = (priceJson.data || [])
      .map((r) => ({ date: r.date, open: r.open, max: r.max, min: r.min, close: r.close, volume: r.Trading_Volume }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const institutional = normalizeInstRows(instJson.data || []);

    return {
      code,
      updatedAt: new Date().toISOString(),
      live: true,
      price: { daily: price, monthly: [], quarterly: [] },
      technical: [],
      valuation: [],
      institutional,
      margin: [],
      shareholding: [],
      lending: [],
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

  function b64EncodeUnicode(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }

  async function writeWatchlistViaApi(owner, repo, token, newList) {
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
        message: `chore: add ${newList[newList.length - 1]} to watchlist`,
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

  async function copyFallback(owner, repo, code, currentList) {
    const newList = currentList ? [...currentList, code] : [code];
    const text = JSON.stringify(newList, null, 2) + "\n";
    try {
      await navigator.clipboard.writeText(text);
    } catch { /* clipboard may be unavailable; instructions still shown */ }
    const editUrl = owner ? `https://github.com/${owner}/${repo}/edit/main/watchlist.json` : "";
    setAddStatus(
      `已把完整清單複製到剪貼簿（含 ${code}）。${editUrl ? "點這裡開啟編輯頁貼上取代全部內容：" + editUrl : "到 GitHub 打開 watchlist.json 貼上取代全部內容。"}下次盤前排程跑完就有完整資料。`
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

    if (currentList && currentList.includes(code)) {
      setAddStatus(`${code} 已經在常駐清單裡了，下次排程就會有完整資料。`);
      return;
    }

    const token = localStorage.getItem(GH_TOKEN_KEY);
    if (token && or_) {
      try {
        const newList = currentList ? [...currentList, code] : [code];
        await writeWatchlistViaApi(or_.owner, or_.repo, token, newList);
        setAddStatus(`已把 ${code} 加入常駐清單！下次盤前排程（或手動 Run workflow）跑完就有完整六項資料。`);
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
      setStatus(`${code} 不在常駐快取清單中，嘗試即時查詢股價與法人資料…`);
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

    setStatus(payload.live ? "即時查詢結果（只有股價／法人，未快取，僅本次有效；籌碼／借券／技術面需加入 watchlist.json）" : "");
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
      : `<p class="footnote">技術面資料不足（即時查詢模式下無技術指標，請加入 watchlist.json）。</p>`;

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
      tbody.innerHTML = `<tr><td colspan="3" class="col-date">此股票近期沒有借券成交，或未快取（即時查詢模式不含借券資料）。</td></tr>`;
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
