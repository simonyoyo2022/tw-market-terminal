// scripts/fetch-data.mjs
//
// Pulls a daily snapshot per watchlist stock from FinMind's free open API
// (https://finmindtrade.com): price, valuation (PER/PBR), 三大法人買賣超,
// 融資融券, 外資持股, 借券. Monthly/quarterly bars and technical indicators
// (EMA/RSI/MACD/KD) are derived locally from the daily price series, since
// FinMind's month/week K-line endpoints require a paid tier.
//
// Runs in two scoped passes so each dataset gets fetched close to when TWSE/
// TPEx actually finalize it, instead of waiting for the next morning:
//   node scripts/fetch-data.mjs --scope=afternoon   (price/technical/三大法人, ~17:30)
//   node scripts/fetch-data.mjs --scope=evening      (融資融券/借券, ~21:30)
//   node scripts/fetch-data.mjs                      (everything — scope defaults to "all", for local/manual runs)
// A scoped run merges into the existing data/stocks/{code}.json rather than
// overwriting it, so the evening pass doesn't wipe out what the afternoon
// pass fetched (see loadExistingStockFile()/fetchStock()).
//
// NOT INCLUDED: 券商分點買賣超 (broker-branch trading detail) — FinMind only
// exposes that via TaiwanStockTradingDailyReport, which is sponsor
// (paid)-tier only. Also NOT INCLUDED: 內外盤 (bid/ask aggressor split) —
// that needs tick-level order-book data, which isn't in FinMind's free tier
// or any other source wired into this app. See README.md for details.
//
// INCLUDED since 2026-07: 融券借券賣出餘額 (SBL short-sale balance) via the
// free official endpoints (TWSE TWT93U / TPEx OpenAPI tpex_margin_sbl).
// Single-day market-wide snapshots accumulated into per-stock history on the
// evening pass — see the SBL section below for the schema/unit defenses.

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

// Taiwan-convention KD (slow stochastic, 2/3-1/3 RSV smoothing, seeded at 50/50)
// — this is what "KD" means to a Taiwan retail trader, distinct from the
// SMA-smoothed %K/%D more common in US textbooks.
function kd(priceDaily, period = 9) {
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
  const { k: kdK, d: kdD } = kd(priceDaily, 9);
  return priceDaily.map((r, i) => ({
    date: r.date,
    ema5: round2(ema5[i]),
    ema20: round2(ema20[i]),
    ema60: round2(ema60[i]),
    rsi14: round2(rsi14[i]),
    macd: round2(macdLine[i]),
    macdSignal: round2(signalLine[i]),
    macdHist: round2(hist[i]),
    kdK: round2(kdK[i]),
    kdD: round2(kdD[i]),
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

async function fetchInstitutional(code) {
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

async function fetchMargin(code) {
  const rows = await callFinMind({
    dataset: "TaiwanStockMarginPurchaseShortSale",
    data_id: code,
    start_date: daysAgoISO(CHIP_HISTORY_DAYS),
    end_date: todayISO(),
  });
  // 增減用「今日餘額 − 昨日餘額」，流量欄位僅作缺欄位時的備援；
  // 與 app.js normalizeMarginRows 保持同一套推導（避免餘額 vs 淨增減對不上帳）。
  const diffOr = (today, yesterday, fallback) =>
    today != null && yesterday != null ? today - yesterday : fallback;
  return rows
    .map((r) => ({
      date: r.date,
      marginBalance: r.MarginPurchaseTodayBalance,
      marginChange: diffOr(
        r.MarginPurchaseTodayBalance,
        r.MarginPurchaseYesterdayBalance,
        (r.MarginPurchaseBuy || 0) - (r.MarginPurchaseSell || 0) - (r.MarginPurchaseCashRepayment || 0)
      ),
      shortBalance: r.ShortSaleTodayBalance,
      shortChange: diffOr(
        r.ShortSaleTodayBalance,
        r.ShortSaleYesterdayBalance,
        (r.ShortSaleSell || 0) - (r.ShortSaleBuy || 0) - (r.ShortSaleCashRepayment || 0)
      ),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
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

// ---------- 融券借券賣出餘額 (SBL short-sale balance, official snapshots) ----------
//
// FinMind's lending dataset only has 借券「成交量」(borrow transactions), not
// 借券賣出「餘額」(shares borrowed AND sold, still outstanding) — the number
// that actually measures live short exposure via SBL. Both exchanges publish
// it for free, but only as a single-day market-wide snapshot (no history, no
// per-stock query), so this follows the accumulate-official-snapshots
// pattern: fetch once per evening run, merge into each stock's cached JSON
// keyed by date, trim to the CHIP_HISTORY_DAYS window.
//
// Two things could NOT be verified up front (both endpoints block bots):
//   1. Exact column/field names → fuzzy lookup with a full schema dump to the
//      Actions log on mismatch, and the stock is skipped rather than guessed.
//   2. Units (股 vs 張) → self-calibrating: each snapshot row also carries the
//      融券今日餘額 column, which FinMind already gives us in 張. Comparing
//      the two for the same stock+date tells us the divisor (1 or 1000).
//      Rows store RAW values and are re-normalized with the current best
//      divisor on every run, so even a wrong first-run assumption heals
//      itself once calibration succeeds. Until then unitVerified=false is
//      surfaced in the app so the numbers aren't silently trusted.

const TWSE_TWT93U_URL = "https://www.twse.com.tw/exchangeReport/TWT93U";
const TPEX_MARGIN_SBL_URL = "https://www.tpex.org.tw/openapi/v1/tpex_margin_sbl";

// "1,622" / " 1622 " / 1622 → 1622; anything non-numeric → null
function parseNumLoose(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

// Accepts "2026-07-14", "20260714" (TWSE), or ROC "1150714" (TPEx) → ISO
function anyDateToISO(s) {
  const t = String(s || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  if (/^\d{8}$/.test(t)) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
  if (/^\d{7}$/.test(t)) return `${+t.slice(0, 3) + 1911}-${t.slice(3, 5)}-${t.slice(5, 7)}`;
  return null;
}

async function fetchOfficialJson(url, label, { retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    } catch (err) {
      if (attempt === retries) {
        console.warn(`  ${label} fetch failed (SBL data for this market will be carried over): ${err.message}`);
        return null;
      }
      await sleep(1500 * (attempt + 1));
    }
  }
  return null;
}

// TWSE TWT93U: {stat, date:"YYYYMMDD", fields:[...], data:[[...]]}
// Official report columns — 融券 group: 前日餘額/賣出/買進/現券/今日餘額/限額;
// 借券賣出 group: 前日餘額/當日賣出/當日還券/當日調整/當日餘額/次一營業日可借券賣出限額.
// 「今日餘額」(融券) vs「當日餘額」(借券賣出) is what disambiguates the two
// balance columns. If that assumption breaks, the full fields array lands in
// the log and the snapshot is skipped — never guessed.
async function fetchTwseSblSnapshot() {
  const url = new URL(TWSE_TWT93U_URL);
  url.searchParams.set("response", "json");
  url.searchParams.set("date", todayISO().replace(/-/g, ""));
  const json = await fetchOfficialJson(url, "TWSE TWT93U");
  if (!json || !Array.isArray(json.fields) || !Array.isArray(json.data)) {
    if (json) console.warn(`  TWSE TWT93U: unexpected shape, keys=${Object.keys(json).join(",")} stat=${json.stat || ""}`);
    return null;
  }
  const f = json.fields.map((x) => String(x).trim());
  const idxCode = f.findIndex((x) => x.includes("代號"));
  const idxSblBal = f.findIndex((x) => x.includes("當日餘額"));
  const idxSblSell = f.findIndex((x) => x.includes("當日賣出"));
  const idxSblRet = f.findIndex((x) => x.includes("當日還券"));
  const idxRefShort = f.findIndex((x) => x.includes("今日餘額")); // 融券 group → unit calibration reference
  if (idxCode < 0 || idxSblBal < 0) {
    console.warn(`  TWSE TWT93U: column lookup failed — actual fields: ${JSON.stringify(f)}`);
    return null;
  }
  const date = anyDateToISO(json.date) || todayISO();
  const map = new Map();
  for (const row of json.data) {
    const code = String(row[idxCode] ?? "").trim();
    if (!code) continue;
    map.set(code, {
      date,
      balanceRaw: parseNumLoose(row[idxSblBal]),
      sellRaw: idxSblSell >= 0 ? parseNumLoose(row[idxSblSell]) : null,
      returnedRaw: idxSblRet >= 0 ? parseNumLoose(row[idxSblRet]) : null,
      refShortBalanceRaw: idxRefShort >= 0 ? parseNumLoose(row[idxRefShort]) : null,
    });
  }
  console.log(`  TWSE TWT93U snapshot: ${map.size} stocks (${date})`);
  return map;
}

// TPEx OpenAPI tpex_margin_sbl: JSON array of objects, latest day only.
// Field names unverified → discover by pattern, dump sample keys on failure.
function pickKey(keys, mustMatch, mustNotMatch = []) {
  return keys.find(
    (k) => mustMatch.every((re) => re.test(k)) && !mustNotMatch.some((re) => re.test(k))
  ) || null;
}
async function fetchTpexSblSnapshot() {
  const json = await fetchOfficialJson(TPEX_MARGIN_SBL_URL, "TPEx margin_sbl");
  if (!json || !Array.isArray(json) || !json.length) {
    if (json) console.warn(`  TPEx margin_sbl: unexpected shape (not a non-empty array)`);
    return null;
  }
  const keys = Object.keys(json[0]);
  const kCode = pickKey(keys, [/code|stock/i], [/name/i]) || pickKey(keys, [/證券代號|股票代號/]);
  const kDate = pickKey(keys, [/date|日期/i]);
  // 借券賣出餘額: something like SBL...Balance / SbLShortSales...Balance, not the previous-day one
  const kSblBal = pickKey(keys, [/sbl/i, /balance/i], [/previous|yesterday|前日/i])
    || pickKey(keys, [/借券賣出/, /餘額/], [/前日/]);
  const kSblSell = pickKey(keys, [/sbl/i, /sell|sale/i], [/balance|previous|前日/i])
    || pickKey(keys, [/借券賣出/, /當日賣出/]);
  // 融券今日餘額 (unit calibration reference): margin-short balance, explicitly NOT an SBL key
  const kRefShort = pickKey(keys, [/short/i, /balance/i], [/sbl|previous|yesterday|前日/i])
    || pickKey(keys, [/融券/, /餘額/], [/前日|借券/]);
  if (!kCode || !kSblBal) {
    console.warn(`  TPEx margin_sbl: key discovery failed — sample keys: ${JSON.stringify(keys)}`);
    return null;
  }
  const map = new Map();
  for (const r of json) {
    const code = String(r[kCode] ?? "").trim();
    if (!code) continue;
    map.set(code, {
      date: (kDate && anyDateToISO(r[kDate])) || todayISO(),
      balanceRaw: parseNumLoose(r[kSblBal]),
      sellRaw: kSblSell ? parseNumLoose(r[kSblSell]) : null,
      returnedRaw: null,
      refShortBalanceRaw: kRefShort ? parseNumLoose(r[kRefShort]) : null,
    });
  }
  console.log(`  TPEx margin_sbl snapshot: ${map.size} stocks (keys: code=${kCode}, bal=${kSblBal})`);
  return map;
}

// Accumulate one official snapshot row into the cached per-stock series.
// Same-day overwrite is safe; entries older than the chip window are trimmed.
function mergeSblSeries(existingRows, newRow) {
  const byDate = new Map((existingRows || []).map((r) => [r.date, r]));
  if (newRow) byDate.set(newRow.date, newRow);
  const cutoff = daysAgoISO(CHIP_HISTORY_DAYS);
  return [...byDate.values()]
    .filter((r) => r.date >= cutoff)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Unit self-calibration: compare the snapshot's 融券餘額 against FinMind's
// (known to be 張) for the same stock+date. Ratio ~1000 → raw is in 股.
// Returns 1, 1000, or null (couldn't calibrate this run, e.g. 融券餘額=0).
function calibrateSblDivisor(snapRow, marginRows) {
  if (!snapRow || snapRow.refShortBalanceRaw == null || snapRow.refShortBalanceRaw <= 0) return null;
  const sameDay = (marginRows || []).find((m) => m.date === snapRow.date);
  if (!sameDay || !(sameDay.shortBalance > 0)) return null;
  const ratio = snapRow.refShortBalanceRaw / sameDay.shortBalance;
  return Math.abs(ratio - 1000) < Math.abs(ratio - 1) ? 1000 : 1;
}

// Rows store raw values; normalized 張 figures are recomputed from raw with
// the current best divisor on EVERY run, so a wrong first-run assumption
// (divisor unknown → 1) self-heals once calibration succeeds.
function normalizeSblRows(rows, divisor) {
  const div = divisor || 1;
  return rows.map((r) => ({
    ...r,
    balance: r.balanceRaw != null ? Math.round(r.balanceRaw / div) : null,
    sell: r.sellRaw != null ? Math.round(r.sellRaw / div) : null,
    returned: r.returnedRaw != null ? Math.round(r.returnedRaw / div) : null,
  }));
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

async function loadExistingStockFile(code) {
  try {
    const raw = await fs.readFile(path.join(STOCKS_DIR, `${code}.json`), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null; // no cache yet, or unreadable — treat as first run
  }
}

// scope controls which FinMind datasets get (re-)fetched this run:
//   "afternoon" — price/technical/valuation/institutional/shareholding
//                 (TWSE/TPEx typically finalize these well before evening)
//   "evening"   — margin (融資融券) + lending (借券), which tend to post later
//   "all"       — everything (used for local/manual runs, and the default so
//                 `node scripts/fetch-data.mjs` with no args still works)
// Whichever half ISN'T being fetched this run is carried over from the
// existing cached file so a scoped run never wipes out the other half's data.
async function fetchStock(code, scope, existing, sblSnapshots, marketCalib) {
  const doAfternoon = scope === "afternoon" || scope === "all";
  const doEvening = scope === "evening" || scope === "all";

  let price = existing?.price?.daily || [];
  let valuation = existing?.valuation || [];
  let institutional = existing?.institutional || [];
  let shareholding = existing?.shareholding || [];
  let margin = existing?.margin || [];
  let lending = existing?.lending || [];
  let sbl = existing?.sbl || [];
  let sblUnitDivisor = existing?.sblUnitDivisor || null;
  let sblMarket = existing?.sblMarket || null;

  if (doAfternoon) {
    price = await fetchPrice(code);
    await sleep(250);
    valuation = await fetchValuation(code);
    await sleep(250);
    institutional = await fetchInstitutional(code);
    await sleep(250);
    shareholding = await fetchShareholding(code);
    await sleep(250);
  }
  if (doEvening) {
    margin = await fetchMargin(code);
    await sleep(250);
    lending = await fetchLending(code);
    await sleep(250);
    // 融券借券賣出餘額: a stock appears in exactly one exchange's snapshot,
    // so probe both maps instead of depending on a code→market lookup.
    let snapRow = null;
    if (sblSnapshots?.twse?.has(code)) { snapRow = sblSnapshots.twse.get(code); sblMarket = "twse"; }
    else if (sblSnapshots?.tpex?.has(code)) { snapRow = sblSnapshots.tpex.get(code); sblMarket = "tpex"; }
    if (snapRow) {
      const div = calibrateSblDivisor(snapRow, margin);
      if (div != null) {
        sblUnitDivisor = div; // sticky across runs once known
        // Same official report → same units for every stock on that market;
        // publish so stocks that can't self-calibrate (融券=0) inherit it.
        if (marketCalib && sblMarket) marketCalib[sblMarket] = div;
      }
      sbl = mergeSblSeries(sbl, snapRow);
    }
    // Inherit the market-level divisor if self-calibration was impossible.
    if (sblUnitDivisor == null && sblMarket && marketCalib?.[sblMarket] != null) {
      sblUnitDivisor = marketCalib[sblMarket];
    }
    sbl = normalizeSblRows(sbl, sblUnitDivisor);
  }

  const technical = buildTechnical(price);
  const monthly = aggregateBars(price, monthKey);
  const quarterly = aggregateBars(price, quarterKey);
  const now = new Date().toISOString();

  return {
    code,
    updatedAt: now,
    lastAfternoonFetchAt: doAfternoon ? now : existing?.lastAfternoonFetchAt || null,
    lastEveningFetchAt: doEvening ? now : existing?.lastEveningFetchAt || null,
    price: { daily: price, monthly, quarterly },
    technical,
    valuation,
    institutional,
    margin,
    shareholding,
    lending,
    sbl,
    sblUnitDivisor,
    sblMarket,
  };
}

async function main() {
  await fs.mkdir(STOCKS_DIR, { recursive: true });

  const scopeArg = process.argv.find((a) => a.startsWith("--scope="));
  const scope = scopeArg ? scopeArg.split("=")[1] : "all";
  if (!["afternoon", "evening", "all"].includes(scope)) {
    console.error(`Unknown --scope=${scope}; expected afternoon, evening, or all.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Scope: ${scope}`);

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

  if (scope === "afternoon" || scope === "all") {
    try {
      await fetchStockList();
    } catch (e) {
      console.error("stock-list.json fetch failed (search/autocomplete will be stale):", e.message);
    }
  }

  // 融券借券賣出餘額 snapshots: market-wide, fetched ONCE per run (not per
  // stock). A failed fetch logs and leaves that market's map null — per-stock
  // merge then simply carries over the existing cached series.
  let sblSnapshots = null;
  if (scope === "evening" || scope === "all") {
    console.log("Fetching 融券借券賣出餘額 official snapshots...");
    sblSnapshots = {
      twse: await fetchTwseSblSnapshot(),
      tpex: await fetchTpexSblSnapshot(),
    };
  }

  const ok = [];
  const failed = [];
  // Market-level unit divisors discovered during this run (see fetchStock).
  const marketCalib = { twse: null, tpex: null };
  for (const code of watchlist) {
    console.log(`Fetching ${scope} snapshot for ${code}...`);
    try {
      const existing = await loadExistingStockFile(code);
      const payload = await fetchStock(code, scope, existing, sblSnapshots, marketCalib);
      await fs.writeFile(path.join(STOCKS_DIR, `${code}.json`), JSON.stringify(payload));
      console.log(
        `  ✓ ${code}: price=${payload.price.daily.length} inst=${payload.institutional.length} ` +
          `margin=${payload.margin.length} lending=${payload.lending.length} sbl=${payload.sbl.length}` +
          `${payload.sbl.length && !payload.sblUnitDivisor ? " (SBL unit UNVERIFIED — cross-check first values against the official page)" : ""}`
      );
      ok.push(code);
    } catch (e) {
      console.error(`  ✗ ${code} failed: ${e.message}`);
      failed.push(code);
    }
  }

  // Repair pass: a stock processed BEFORE its market's divisor was discovered
  // (loop-order dependent) is still sitting unverified. The divisor is sticky
  // and per-market, so retrofit it now rather than waiting for a future run
  // to happen in a luckier order.
  for (const code of ok) {
    const payload = await loadExistingStockFile(code);
    if (!payload || payload.sblUnitDivisor != null || !payload.sbl?.length) continue;
    const div = payload.sblMarket ? marketCalib[payload.sblMarket] : null;
    if (div == null) continue;
    payload.sblUnitDivisor = div;
    payload.sbl = normalizeSblRows(payload.sbl, div);
    await fs.writeFile(path.join(STOCKS_DIR, `${code}.json`), JSON.stringify(payload));
    console.log(`  ↻ ${code}: SBL unit retrofitted from market-level calibration (÷${div})`);
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
