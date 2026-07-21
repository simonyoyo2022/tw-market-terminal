// 借券空單回補哨兵 — GitHub Actions 推播版
//
// 讀取 evening 抓取後已寫入的 data/stocks/{code}.json，對每檔跑
// detectSblCovering（與 app.js 同一套邏輯），觸發就透過 Telegram Bot API
// 推播。設計為「只在狀態『轉為觸發』時通知一次」，用一個小狀態檔
// data/sentinel-state.json 記住上次是否已通知，避免每天重複洗版。
//
// 需要的環境變數（走 GitHub Secrets，不進 repo 程式碼）：
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
// 兩者任一缺失 → 靜默跳過（讓沒設定的人 workflow 不會失敗）。
//
// 刻意獨立於 fetch-data.mjs：抓取失敗不該影響通知、通知失敗不該影響抓取。

import fs from "node:fs/promises";
import path from "node:path";

const STOCKS_DIR = path.join(process.cwd(), "data", "stocks");
const STATE_FILE = path.join(process.cwd(), "data", "sentinel-state.json");
const WATCHLIST = path.join(process.cwd(), "watchlist.json");

// ---- 與 app.js detectSblCovering 同義的偵測邏輯（張為單位，餘額差推導）----
// active   = 借券賣出餘額連續 >=minStreak 日下降（有還券資料時再要求還券放大）
// watching = 僅最近一日下降
function detectSblCovering(sblRows, unitOk, minStreak = 2) {
  const blank = { active: false, watching: false, days: 0, declineTotal: 0, returnsRising: false, lastReturned: null };
  if (!unitOk || !sblRows || sblRows.length < 2) return blank;
  let streak = 0, declineTotal = 0;
  for (let i = sblRows.length - 1; i >= 1; i--) {
    const cur = sblRows[i].balance, prev = sblRows[i - 1].balance;
    if (cur != null && prev != null && cur < prev) { streak++; declineTotal += prev - cur; }
    else break;
  }
  if (streak === 0) return blank;
  const seg = sblRows.slice(-1 - streak);
  const returnsVals = seg.map((r) => r.returned).filter((v) => v != null);
  const lastReturned = sblRows[sblRows.length - 1].returned;
  const returnsRising = returnsVals.length >= 2 && returnsVals[returnsVals.length - 1] > returnsVals[0];
  const hasReturns = returnsVals.length >= 2;
  const active = streak >= minStreak && (hasReturns ? returnsRising : true);
  return { active, watching: !active && streak >= 1, days: streak, declineTotal, returnsRising, lastReturned };
}

async function readJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, "utf-8")); } catch { return fallback; }
}

async function sendTelegram(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram API ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log("Telegram secrets 未設定，跳過哨兵推播。");
    return;
  }

  const watchlist = await readJson(WATCHLIST, []);
  const codes = Array.isArray(watchlist) ? watchlist : (watchlist.codes || []);
  const prevState = await readJson(STATE_FILE, {}); // { "8069": {active:true,notifiedAt:"..."} }
  const newState = { ...prevState };
  let stateChanged = false;

  for (const code of codes) {
    const payload = await readJson(path.join(STOCKS_DIR, `${code}.json`), null);
    if (!payload) continue;
    const sblRows = (payload.sbl || []).filter((r) => r.balance != null);
    const cover = detectSblCovering(sblRows, !!payload.sblUnitDivisor);

    const wasActive = !!prevState[code]?.active;
    // 只在「由未觸發 → 觸發」的邊緣推播一次（避免每日重複）。
    if (cover.active && !wasActive) {
      const last = sblRows[sblRows.length - 1];
      const priceRow = payload.price?.daily?.slice(-1)[0];
      const px = priceRow ? `${priceRow.close} 元（${priceRow.date}）` : "";
      const text =
        `🟢 <b>借券空單回補訊號觸發</b>  ${code}\n` +
        `借券賣出餘額連續 ${cover.days} 日下降` +
        (cover.returnsRising ? `、還券量放大（最近一日還券 ${Math.abs(cover.lastReturned).toLocaleString()} 張）` : "") +
        `\n累計回補 ${Math.abs(cover.declineTotal).toLocaleString()} 張，最新餘額 ${Math.abs(last.balance).toLocaleString()} 張` +
        (px ? `\n股價 ${px}` : "") +
        `\n\n這是加碼時機哨兵。務必再對照：站穩參考價數日、投信買力是否延續，三者同向再決定。` +
        `本訊號只描述數據，不構成投資建議。`;
      try {
        await sendTelegram(token, chatId, text);
        console.log(`✓ ${code} 哨兵推播已送出`);
      } catch (e) {
        console.error(`✗ ${code} Telegram 推播失敗: ${e.message}`);
        continue; // 推播失敗就不更新狀態，下次再試
      }
    }
    if ((newState[code]?.active || false) !== cover.active) stateChanged = true;
    newState[code] = { active: cover.active, watching: cover.watching, days: cover.days,
                       updatedAt: new Date().toISOString() };
  }

  if (stateChanged || Object.keys(prevState).length !== Object.keys(newState).length) {
    await fs.writeFile(STATE_FILE, JSON.stringify(newState, null, 2));
    console.log("哨兵狀態已更新 data/sentinel-state.json");
  } else {
    console.log("哨兵狀態無變化。");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
