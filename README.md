# 法人籌碼 — 股價／籌碼／法人／借券 PWA

查詢台股個股**股價、技術面（EMA／RSI／MACD）、籌碼（融資融券／外資持股）、
三大法人買賣超、借券**的個人 PWA。資料來源為 [FinMind](https://finmindtrade.com)
開放資料（源自證交所／櫃買中心公開資訊），每個交易日**盤前一小時**（台北時間
08:00）由 GitHub Actions 自動抓取前一交易日收盤後的完整資料。

## 涵蓋範圍 vs. 沒做到的部分

| 你要的項目 | 對應資料 | 狀態 |
| --- | --- | --- |
| 股價 / 行情 | 日 K（開高低收量）、PER/PBR/殖利率 | ✅ 免費 |
| 季線 / 月線 | 由日線在抓取時自動彙整（FinMind 月K/週K為付費層，改用日線自算） | ✅ 免費 |
| 技術面 | EMA5/20/60、RSI14、MACD，抓取時算好存進資料 | ✅ 免費 |
| 籌碼 | 融資融券餘額增減、外資持股比例 | ✅ 免費 |
| 法人動態 | 外資／投信／自營商買賣超 | ✅ 免費 |
| 借券 | 每日借券成交量、平均費率 | ✅ 免費 |
| **券商（分點）買賣超** | FinMind 僅透過 `TaiwanStockTradingDailyReport` 提供，**該資料集限付費 sponsor 會員**才能用 | ❌ **未包含** |

**券商分點買賣超這項，免費方案做不到**，這點要老實跟你說。如果你之後真的
需要，選項有：
1. 到 [finmindtrade.com](https://finmindtrade.com) 付費升級 sponsor 方案
   （價格請自行到官網確認，我沒有即時報價資訊）。
2. 我可以再研究其他免費來源（例如證交所/櫃買中心官方頁面），但那類資料
   結構複雜、量體大（每天上千檔 × 上百券商分點），要另外評估可行性。
目前的版本先把其他七項做完整，這項留白，之後想做我們再另外討論。

## 架構

```
watchlist.json          常駐追蹤的股票代號（預設 ["8069"] 元太科技）
scripts/fetch-data.mjs  抓資料＋算技術指標＋彙整月/季線的 Node.js 腳本
.github/workflows/      每日盤前排程執行上面的腳本，把結果 commit 回 repo
data/                   抓下來的資料（stock-list.json + stocks/{代號}.json）
index.html / app.js / style.css   前端 PWA（股價／籌碼／法人／借券 分頁）
```

前端是純靜態網頁，沒有建置流程，GitHub Pages 開啟後就能直接用。

`data/stocks/{代號}.json` 內容結構：

```json
{
  "code": "8069",
  "updatedAt": "...",
  "price": { "daily": [...], "monthly": [...], "quarterly": [...] },
  "technical": [{ "date": "...", "ema5": ..., "ema20": ..., "ema60": ..., "rsi14": ..., "macd": ..., "macdSignal": ..., "macdHist": ... }],
  "valuation": [{ "date": "...", "per": ..., "pbr": ..., "dividendYield": ... }],
  "institutional": [{ "date": "...", "foreign": ..., "trust": ..., "dealer": ..., "total": ... }],
  "margin": [{ "date": "...", "marginBalance": ..., "marginChange": ..., "shortBalance": ..., "shortChange": ... }],
  "shareholding": [{ "date": "...", "foreignSharesRatio": ... }],
  "lending": [{ "date": "...", "volume": ..., "avgFeeRate": ... }]
}
```

## 設定步驟

1. **建立 GitHub repo**，把這個資料夾所有檔案上傳進去。
2. **啟用 GitHub Pages**：repo → Settings → Pages → Source 選
   `Deploy from a branch` → Branch 選 `main` / `(root)` → Save。
3. **（建議）填入 repo 網址**：打開 `config.js`，把 `repoUrl` 填成你的 repo
   網址，用於「查無快取資料」時的提示訊息。
4. **（建議）申請 FinMind 免費 token**：到 finmindtrade.com 免費註冊拿
   token，到 repo → Settings → Secrets and variables → Actions → New
   repository secret，新增 `FINMIND_TOKEN`。每檔股票現在要抓 6 個資料集，
   有 token 額度是 600 次/小時，沒有是 300 次/小時，追蹤股票一多建議還是
   設一下。
5. **手動跑一次**：repo → Actions → `Update market data (pre-market)` →
   Run workflow。跑完後 `data/` 底下會出現完整資料。之後每個交易日台北
   時間 08:00 自動再跑一次。
6. **iPhone 安裝**：Safari 開啟 Pages 網址 → 分享 → 「加入主畫面」。

## 新增追蹤股票

編輯 `watchlist.json`：

```json
["8069", "2330", "2454"]
```

存檔、commit、push，下次排程（或手動觸發 Actions）該股票的六類資料就會
一起抓齊。

## 查任一檔（不在 watchlist 的股票）

App 會嘗試直接從瀏覽器即時呼叫 FinMind 查「股價」與「法人動態」兩項
（技術面／籌碼／借券即時模式下不含，因為要另外算/另外抓，即時查詢只做
最基本兩項以求快）。這需要 FinMind 允許瀏覽器跨網域請求，無法 100% 保證
成功。

查到即時資料後，畫面上會多一個「＋ 加入常駐清單」按鈕，點下去有兩種結果：

- **有設定 GitHub token**：直接幫你把代號寫進 GitHub 上的 `watchlist.json`
  （呼叫 GitHub API），下次排程跑完就有完整六項資料。
- **沒有 token**：把更新後的完整清單複製到剪貼簿，並給你 `watchlist.json`
  的編輯頁連結，你手動貼上、Commit 即可。

### 設定 token（只需做一次，非必要）

1. GitHub 右上角頭像 → **Settings** → 左側最下面 **Developer settings**
2. **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
3. Repository access 選 **Only select repositories**，選你這個 repo
4. Permissions → **Repository permissions** → **Contents** 設為 **Read and write**，其他都不用動
5. 產生後複製 token，貼進 App 裡「＋ 加入常駐清單」跳出的欄位

這個 token **只會存在你這支手機瀏覽器的 localStorage 裡**，不會傳到我或
任何第三方；但它終究是一組有寫入權限的憑證，存在瀏覽器裡代表任何能碰到
這支手機的人理論上都碰得到它。如果不放心，略過這步驟，全程用複製貼上
一樣能用，只是要多兩三下手動操作。

## 注意事項

- 資料僅供參考，不構成投資建議；FinMind 授權為教育、非商業用途。
- 技術指標（EMA/RSI/MACD）是用約 400 天日線資料算出來的，早期幾筆因為
  沒有足夠回看天數，數值會不準，但近期（近 60 天內）都已經收斂穩定。
- 我沒辦法在自己的環境裡直接連線測試 FinMind API（沙盒網路白名單限制），
  程式是照著 FinMind 官方文件的欄位格式寫的；如果第一次 Actions 執行有
  任何錯誤，把 Actions 的執行紀錄（log）貼給我，我可以馬上幫你抓問題。
