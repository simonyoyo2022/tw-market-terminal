// scripts/fetch-data.mjs
//
// Pulls a full daily snapshot per watchlist stock: price, valuation
// (PER/PBR), 三大法人買賣超, 融資融券, 外資持股, 借券. Monthly/quarterly bars
// and technical indicators (EMA/RSI/MACD) are derived locally from the daily
// price series.
//
// Data sources, per dataset:
//   price / valuation / shareholding / lending  → FinMind (unchanged)
//   三大法人買賣超 (上市 stocks)                  → TWSE T86 official report,
//                                                  FinMind fallback
//   融資融券 (上市 stocks)                        → TWSE MI_MARGN official
//                                                  OpenAPI, FinMind fallback
//   三大法人 / 融資融券 (上櫃 stocks)              → FinMind (see note below)
//
// Why 三大法人/融資融券 moved off FinMind for 上市 stocks: FinMind's free tier
// occasionally has unit/field surprises (see the toLots() note below — this
// bit us once already), whereas TWSE's own OpenAPI is the source of truth.
// TWSE's official endpoints only return a single day's snapshot (no
// date-range query), which is fine for *this* script because it runs daily
// and accumulates one more day into data/stocks/{code}.json each time — see
// mergeDailySeries(). It would NOT be fine for app.js's browser-side
// fetchLive() (arbitrary stock lookup, needs ~130 days in one shot), so that
// path intentionally keeps using FinMind's ranged query. This is also why
// 上櫃 (TPEx) stocks still use FinMind here: TPEx has an equivalent official
// per-stock institutional/margin OpenAPI, but its exact endpoint shape
// wasn't verified against a live response while building this (this sandbox
// has no network access to test with) — safer to leave 上櫃 alone than ship
// a guessed integration. If you want 上櫃 stocks on the official source too,
// check https://www.tpex.org.tw/openapi/ for the exact dataset names/fields
// and mirror the twseMarginSnapshot/twseInstitutionalSnapshot functions
// below.
//
// Every official-source call is wrapped so that any failure (network error,
// unexpected response shape, code not found in that day's snapshot) falls
// back to the exact FinMind call this script used before — so a live-run
// surprise degrades to "same as before", never to "no data". Check the
// GitHub Actions log after the first run: a `[official]` line means TWSE's
// data was used for that stock; `[finmind-fallback: ...]` means it fell
// back, with the reason.
//
// Run locally:   node scripts/fetch-data.mjs
// In CI:         set FINMIND_TOKEN as a repo secret to raise the rate limit
//                (optional — comfortably fine without it for a small watchlist).

import fs from "node:fs/promises";
import path from "node:path";

const FINMIND_URL = "https://api.finmindtrade.com/api/v4/data";
const TOKEN = process.env.FINMIND_TOKEN || "";
const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const STOCKS_DIR = path.join(DATA_DIR, "stocks");

const PRICE_HISTORY_DAYS = 400;   // ~ a bit over a year of calendar days, for monthly/quarterly bars + indicators
const CHIP_HISTORY_DAYS = 130;    // covers the 5/10/20/30/60-trading-day UI ranges

// ---------- small utils ----------

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callFinMind(params, { retries = 2 } = {}) {
  const url = new URL(FINMIND_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers = {};
  if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`Non-JSON response: ${text.slice(0, 300)}`);
      }
      if (json.status && json.status !== 200) {
        throw new Error(`FinMind status ${json.status}: ${json.msg || ""}`);
      }
      return Array.isArray(json.data) ? json.data : [];
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`    retry after error: ${err.message}`);
      await sleep(1500 * (attempt + 1));
    }
  }
  return [];
}

// ---------- official TWSE sources for 三大法人 / 融資融券 (上市 stocks) ----------

const TWSE_MARGIN_URL = "https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN";
const TWSE_T86_URL = "https://www.twse.com.tw/fund/T86";

function ymdCompact(iso) {
  return iso.replace(/-/g, "");
}
function numTW(v) {
  if (v == null) return 0;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

async function fetchJsonSafe(url, label) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (tw-market-terminal)" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`  [official] ${label} fetch failed: ${err.message}`);
    return null;
  }
}

// TWSE 集中市場融資融券餘額 (all 上市 stocks, single latest-day snapshot).
// Confirmed against https://openapi.twse.com.tw/v1/swagger.json — flat array,
// Chinese field names, values as comma-formatted numeric strings, no date
// field (it's always "whatever TWSE currently has settled").
async function fetchTwseMarginSnapshot() {
  const json = await fetchJsonSafe(TWSE_MARGIN_URL, "TWSE MI_MARGN (融資融券)");
  if (!Array.isArray(json)) return new Map();
  const map = new Map();
  for (const r of json) {
    const code = r["股票代號"];
    if (!code) continue;
    map.set(code, {
      marginBalance: numTW(r["融資今日餘額"]),
      marginChange: numTW(r["融資買進"]) - numTW(r["融資賣出"]) - numTW(r["融資現金償還"]),
      shortBalance: numTW(r["融券今日餘額"]),
      shortChange: numTW(r["融券賣出"]) - numTW(r["融券買進"]) - numTW(r["融券現券償還"]),
    });
  }
  return map;
}

// TWSE 三大法人買賣超日報 (T86, all 上市 stocks, single day specified by
// `dateISO`). This is TWSE's long-standing report endpoint (not part of the
// Swagger-documented catalog, but a stable, widely-used pattern) — response
// shape is the classic TWSE report JSON: { fields: [...], data: [[...], ...] }.
// If that shape ever changes, iCode below comes back -1 and this safely
// returns an empty map (→ every stock falls back to FinMind that run).
async function fetchTwseInstitutionalSnapshot(dateISO) {
  const url = `${TWSE_T86_URL}?response=json&date=${ymdCompact(dateISO)}&selectType=ALLBUT0999`;
  const json = await fetchJsonSafe(url, "TWSE T86 (三大法人)");
  if (!json || !Array.isArray(json.data) || !Array.isArray(json.fields)) return new Map();

  const idx = (name) => json.fields.indexOf(name);
  const iCode = idx("證券代號");
  const iForeignNet = idx("外陸資買賣超股數(不含外資自營商)");
  const iForeignDealerNet = idx("外資自營商買賣超股數");
  const iTrustNet = idx("投信買賣超股數");
  const iDealerNet = idx("自營商買賣超股數");
  if (iCode === -1) {
    console.warn("  [official] TWSE T86 response shape didn't match expected columns — falling back to FinMind for all 上市 stocks today");
    return new Map();
  }

  const toLots = (shares) => Math.round(shares / 1000);
  const map = new Map();
  for (const row of json.data) {
    const code = String(row[iCode]).trim();
    const foreignShares = (iForeignNet > -1 ? numTW(row[iForeignNet]) : 0) + (iForeignDealerNet > -1 ? numTW(row[iForeignDealerNet]) : 0);
    const trustShares = iTrustNet > -1 ? numTW(row[iTrustNet]) : 0;
    const dealerShares = iDealerNet > -1 ? numTW(row[iDealerNet]) : 0;
    const foreign = toLots(foreignShares);
    const trust = toLots(trustShares);
    const dealer = toLots(dealerShares);
    map.set(code, { foreign, trust, dealer, total: foreign + trust + dealer });
  }
  return map;
}

// Merges one day's official-source row into a previously-cached daily
// series: replaces the row if that date is already present (re-running the
// same day), appends otherwise, then trims to the rolling history window.
// This is how the cache gradually becomes official-sourced day by day while
// preserving whatever history (FinMind-sourced or otherwise) came before.
function mergeDailySeries(previousRows, todayRow, historyDays) {
  const byDate = new Map((previousRows || []).map((r) => [r.date, r]));
  if (todayRow) byDate.set(todayRow.date, todayRow);
  const cutoff = daysAgoISO(historyDays);
  return [...byDate.values()].filter((r) => r.date >= cutoff).sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- technical indicators (computed locally, no paid endpoint needed) ----------

function ema(values, period) {
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

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      if (i === period) {
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  );
  const signalLine = ema(macdLine, signalPeriod);
  const hist = macdLine.map((v, i) => (v != null && signalLine[i] != null ? v - signalLine[i] : null));
  return { macdLine, signalLine, hist };
}

function round2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}

function buildTechnical(priceDaily) {
  const closes = priceDaily.map((r) => r.close);
  const ema5 = ema(closes, 5);
  const ema20 = ema(closes, 20);
  const ema60 = ema(closes, 60);
  const rsi14 = rsi(closes, 14);
  const { macdLine, signalLine, hist } = macd(closes);
  return priceDaily.map((r, i) => ({
    date: r.date,
    ema5: round2(ema5[i]),
    ema20: round2(ema20[i]),
    ema60: round2(ema60[i]),
    rsi14: round2(rsi14[i]),
    macd: round2(macdLine[i]),
    macdSignal: round2(signalLine[i]),
    macdHist: round2(hist[i]),
  }));
}

// ---------- period bar aggregation (monthly / quarterly), from daily price ----------

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
      b.close = r.close; // rows arrive in ascending date order, so last write wins
      b.volume += r.volume;
    }
  }
  return [...buckets.values()];
}
const monthKey = (d) => d.slice(0, 7); // YYYY-MM
const quarterKey = (d) => {
  const [y, m] = d.slice(0, 7).split("-");
  const q = Math.ceil(Number(m) / 3);
  return `${y}-Q${q}`;
};

// ---------- FinMind dataset fetchers ----------

async function fetchStockList() {
  console.log("Fetching TaiwanStockInfo (full 上市/上櫃 company list)...");
  const rows = await callFinMind({ dataset: "TaiwanStockInfo" });
  const byId = new Map();
  for (const r of rows) {
    const prev = byId.get(r.stock_id);
    if (!prev || String(r.date) > String(prev.date)) byId.set(r.stock_id, r);
  }
  const list = [...byId.values()]
    .filter((r) => r.type === "twse" || r.type === "tpex")
    .map((r) => ({
      code: r.stock_id,
      name: r.stock_name,
      market: r.type === "twse" ? "上市" : "上櫃",
      industry: r.industry_category || "",
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
  await fs.writeFile(
    path.join(DATA_DIR, "stock-list.json"),
    JSON.stringify({ updatedAt: new Date().toISOString(), list })
  );
  console.log(`  saved ${list.length} companies -> data/stock-list.json`);
  return list;
}

async function fetchPrice(code) {
  const rows = await callFinMind({
    dataset: "TaiwanStockPrice",
    data_id: code,
    start_date: daysAgoISO(PRICE_HISTORY_DAYS),
    end_date: todayISO(),
  });
  return rows
    .map((r) => ({
      date: r.date,
      open: r.open,
      max: r.max,
      min: r.min,
      close: r.close,
      volume: r.Trading_Volume,
      turnoverMoney: r.Trading_money,
      spread: r.spread,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchValuation(code) {
  const rows = await callFinMind({
    dataset: "TaiwanStockPER",
    data_id: code,
    start_date: daysAgoISO(CHIP_HISTORY_DAYS),
    end_date: todayISO(),
  });
  return rows
    .map((r) => ({ date: r.date, per: r.PER, pbr: r.PBR, dividendYield: r.dividend_yield }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchInstitutionalFinMind(code) {
  const rows = await callFinMind({
    dataset: "TaiwanStockInstitutionalInvestorsBuySellWide",
    data_id: code,
    start_date: daysAgoISO(CHIP_HISTORY_DAYS),
    end_date: todayISO(),
  });
  // FinMind's buy/sell fields here are in 股 (shares), unlike
  // TaiwanStockMarginPurchaseShortSale which is already in 張 (lots).
  // Divide by 1000 so this matches every other "張" figure in the app
  // (confirmed against FinMind's own docs example: 2330's
  // Foreign_Investor_buy of 31,304,729 is only sane as shares).
  const toLots = (n) => Math.round(n / 1000);
  return rows
    .map((r) => {
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
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchMarginFinMind(code) {
  const rows = await callFinMind({
    dataset: "TaiwanStockMarginPurchaseShortSale",
    data_id: code,
    start_date: daysAgoISO(CHIP_HISTORY_DAYS),
    end_date: todayISO(),
  });
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

// Picks the official TWSE snapshot for `code` when available (上市 stocks,
// snapshot fetch succeeded, code present in it), merges it into the
// previously-cached series, and falls back to a full FinMind range fetch
// otherwise — covering 上櫃 stocks, snapshot fetch failures, and codes
// missing from a given day's snapshot (e.g. newly listed, or the market was
// closed).
async function fetchInstitutionalForStock(code, market, officialInst, snapshotDate, previousRows) {
  if (market === "上市" && officialInst && officialInst.has(code) && snapshotDate) {
    const row = officialInst.get(code);
    console.log(`  [official] ${code} 三大法人 <- TWSE T86 (${snapshotDate})`);
    return mergeDailySeries(previousRows, { date: snapshotDate, ...row }, CHIP_HISTORY_DAYS);
  }
  console.log(`  [finmind-fallback] ${code} 三大法人 (market=${market}, in snapshot=${officialInst ? officialInst.has(code) : "n/a"})`);
  return fetchInstitutionalFinMind(code);
}

async function fetchMarginForStock(code, market, officialMargin, snapshotDate, previousRows) {
  if (market === "上市" && officialMargin && officialMargin.has(code) && snapshotDate) {
    const row = officialMargin.get(code);
    console.log(`  [official] ${code} 融資融券 <- TWSE MI_MARGN (${snapshotDate})`);
    return mergeDailySeries(previousRows, { date: snapshotDate, ...row }, CHIP_HISTORY_DAYS);
  }
  console.log(`  [finmind-fallback] ${code} 融資融券 (market=${market}, in snapshot=${officialMargin ? officialMargin.has(code) : "n/a"})`);
  return fetchMarginFinMind(code);
}

async function fetchShareholding(code) {
  const rows = await callFinMind({
    dataset: "TaiwanStockShareholding",
    data_id: code,
    start_date: daysAgoISO(CHIP_HISTORY_DAYS),
    end_date: todayISO(),
  });
  return rows
    .map((r) => ({
      date: r.date,
      foreignSharesRatio: r.ForeignInvestmentSharesRatio,
      foreignRemainRatio: r.ForeignInvestmentRemainRatio,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchLending(code) {
  const rows = await callFinMind({
    dataset: "TaiwanStockSecuritiesLending",
    data_id: code,
    start_date: daysAgoISO(CHIP_HISTORY_DAYS),
    end_date: todayISO(),
  });
  // Raw data is one row per lending contract; aggregate to one row per day.
  const byDate = new Map();
  for (const r of rows) {
    const d = byDate.get(r.date) || { date: r.date, volume: 0, feeSum: 0, feeCount: 0 };
    d.volume += r.volume || 0;
    if (r.fee_rate != null) {
      d.feeSum += r.fee_rate * (r.volume || 0);
      d.feeCount += r.volume || 0;
    }
    byDate.set(r.date, d);
  }
  return [...byDate.values()]
    .map((d) => ({ date: d.date, volume: d.volume, avgFeeRate: d.feeCount ? round2(d.feeSum / d.feeCount) : null }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- main ----------

// Removing a stock from watchlist.json only stops future runs from
// re-fetching it — it doesn't touch the already-written
// data/stocks/{code}.json, which would otherwise sit there forever getting
// staler by the day while still being served by the app as if it were
// current (fetchCached() only checks whether the file exists, it never
// checks watchlist.json membership). Delete any cached file whose code
// isn't in the current watchlist so a removed stock actually stops being
// "cached" instead of quietly going stale.
async function cleanupOrphanedStockFiles(watchlist) {
  const keep = new Set(watchlist);
  let files;
  try {
    files = await fs.readdir(STOCKS_DIR);
  } catch {
    return; // directory doesn't exist yet (first run) — nothing to clean
  }
  const removed = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const code = file.slice(0, -".json".length);
    if (!keep.has(code)) {
      await fs.rm(path.join(STOCKS_DIR, file));
      removed.push(code);
    }
  }
  if (removed.length) {
    console.log(`Removed cached data for stocks no longer in watchlist.json: ${removed.join(", ")}`);
  }
}

// Reads a stock's previously-cached data/stocks/{code}.json, if any, BEFORE
// this run overwrites it — needed so the official-source institutional/
// margin fetch can merge "today" into existing history instead of clobbering
// it. Returns null on first run / missing file (mergeDailySeries handles
// that fine — it just starts a fresh series).
async function loadPreviousStockFile(code) {
  try {
    return JSON.parse(await fs.readFile(path.join(STOCKS_DIR, `${code}.json`), "utf-8"));
  } catch {
    return null;
  }
}

async function fetchStockRest(code, price, { market, previous, officialMargin, officialInst, snapshotDate }) {
  const valuation = await fetchValuation(code);
  await sleep(250);
  const institutional = await fetchInstitutionalForStock(code, market, officialInst, snapshotDate, previous?.institutional);
  await sleep(250);
  const margin = await fetchMarginForStock(code, market, officialMargin, snapshotDate, previous?.margin);
  await sleep(250);
  const shareholding = await fetchShareholding(code);
  await sleep(250);
  const lending = await fetchLending(code);
  await sleep(250);

  const technical = buildTechnical(price);
  const monthly = aggregateBars(price, monthKey);
  const quarterly = aggregateBars(price, quarterKey);

  return {
    code,
    updatedAt: new Date().toISOString(),
    price: { daily: price, monthly, quarterly },
    technical,
    valuation,
    institutional,
    margin,
    shareholding,
    lending,
  };
}

async function main() {
  await fs.mkdir(STOCKS_DIR, { recursive: true });

  let watchlist = [];
  try {
    const raw = JSON.parse(await fs.readFile(path.join(ROOT, "watchlist.json"), "utf-8"));
    // Entries can be plain code strings (manual/original) or {code, name,
    // addedAt} objects (added from the app's "加入常駐清單" button). Support both.
    watchlist = raw.map((item) => (typeof item === "string" ? item : item.code)).filter(Boolean);
  } catch (e) {
    console.error("Could not read watchlist.json:", e.message);
    process.exitCode = 1;
    return;
  }

  let stockList = [];
  try {
    stockList = await fetchStockList();
  } catch (e) {
    console.error("stock-list.json fetch failed (search/autocomplete will be stale):", e.message);
  }
  const marketByCode = new Map(stockList.map((s) => [s.code, s.market]));

  // TWSE's official 三大法人/融資融券 snapshots cover the whole market in one
  // call each, so they're fetched once per run (not once per stock) and
  // reused below. "Once" is primed lazily from the first 上市 watchlist
  // stock's own latest settled price date, so the snapshot's implicit date
  // lines up with the price series being cached alongside it, instead of
  // guessing today's date (pre-market runs are pulling yesterday's settled
  // data, so "today" would be wrong).
  let officialMargin = null;
  let officialInst = null;
  let snapshotDate = null;

  const ok = [];
  const failed = [];
  for (const code of watchlist) {
    console.log(`Fetching full snapshot for ${code}...`);
    try {
      const market = marketByCode.get(code) || null;
      const previous = await loadPreviousStockFile(code);
      const price = await fetchPrice(code);
      await sleep(250);

      if (snapshotDate === null && market === "上市" && price.length) {
        snapshotDate = price[price.length - 1].date;
        console.log(`  priming official TWSE snapshots for ${snapshotDate}...`);
        officialMargin = await fetchTwseMarginSnapshot();
        await sleep(250);
        officialInst = await fetchTwseInstitutionalSnapshot(snapshotDate);
        await sleep(250);
      }

      const payload = await fetchStockRest(code, price, { market, previous, officialMargin, officialInst, snapshotDate });
      await fs.writeFile(path.join(STOCKS_DIR, `${code}.json`), JSON.stringify(payload));
      console.log(
        `  ✓ ${code}: price=${payload.price.daily.length} inst=${payload.institutional.length} ` +
          `margin=${payload.margin.length} lending=${payload.lending.length}`
      );
      ok.push(code);
    } catch (e) {
      console.error(`  ✗ ${code} failed: ${e.message}`);
      failed.push(code);
    }
  }

  console.log("---");
  console.log(`Done. ok=[${ok.join(",")}] failed=[${failed.join(",")}]`);
  if (watchlist.length > 0 && ok.length === 0) {
    process.exitCode = 1;
  }

  await cleanupOrphanedStockFiles(watchlist);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exitCode = 1;
});
