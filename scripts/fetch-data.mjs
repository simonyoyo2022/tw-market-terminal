// scripts/fetch-data.mjs
//
// Pulls a full daily snapshot per watchlist stock from FinMind's free open
// API (https://finmindtrade.com): price, valuation (PER/PBR), 三大法人買賣超,
// 融資融券, 外資持股, 借券. Monthly/quarterly bars and technical indicators
// (EMA/RSI/MACD) are derived locally from the daily price series, since
// FinMind's month/week K-line endpoints require a paid tier.
//
// NOT INCLUDED: 券商分點買賣超 (broker-branch trading detail). FinMind only
// exposes that via TaiwanStockTradingDailyReport, which is sponsor
// (paid)-tier only. See README.md for details/alternatives.
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
  return rows
    .map((r) => {
      const foreign =
        (r.Foreign_Investor_buy || 0) - (r.Foreign_Investor_sell || 0) +
        (r.Foreign_Dealer_Self_buy || 0) - (r.Foreign_Dealer_Self_sell || 0);
      const trust = (r.Investment_Trust_buy || 0) - (r.Investment_Trust_sell || 0);
      const dealer =
        (r.Dealer_buy || 0) - (r.Dealer_sell || 0) +
        (r.Dealer_self_buy || 0) - (r.Dealer_self_sell || 0) +
        (r.Dealer_Hedging_buy || 0) - (r.Dealer_Hedging_sell || 0);
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

async function fetchStock(code) {
  const price = await fetchPrice(code);
  await sleep(250);
  const valuation = await fetchValuation(code);
  await sleep(250);
  const institutional = await fetchInstitutional(code);
  await sleep(250);
  const margin = await fetchMargin(code);
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

  try {
    await fetchStockList();
  } catch (e) {
    console.error("stock-list.json fetch failed (search/autocomplete will be stale):", e.message);
  }

  const ok = [];
  const failed = [];
  for (const code of watchlist) {
    console.log(`Fetching full snapshot for ${code}...`);
    try {
      const payload = await fetchStock(code);
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
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exitCode = 1;
});
