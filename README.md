# 循環販賣機 ESG Demo

> 展示「自動販賣機 × 循環容器」完整旅程：從會員掃描、挑選飲品、三段式結帳到押金退費與 ESG 儀表板，所有數據全程即時串接。

## 特色亮點

- **全流程腳本**：9 個前端頁面（掃描・購物・結帳・出貨・回收・ESG 儀表板…）呈現真實販賣機端到端體驗。
- **即時 ESG 指標**：後端整合交易、押金、回收資料，每筆操作即刻更新減碳 / 節水數據與「退押率」。
- **SQLite 零部署負擔**：專案啟動即自動載入 `schema.sql`、`seed.sql`，適合 Demo 與 Hackathon 快速上線。
- **API-first 架構**：前端皆透過 REST API 讀寫，方便銜接實體設備或擴充第三方服務。
- **Docker Ready**：提供 Dockerfile 與 Compose 設定，一行指令即可交付到任何雲端或實體機台。

---

## 快速開始

### 1. 直接在本機啟動

```bash
git clone <repo-url>
cd Wanrun-2025-Innovation-and-Creativity-Competition/vm-mini
npm install           # 或 npm ci
node server.js
```

瀏覽器開啟 `http://localhost:3000`。啟動時會自動：

1. 建立 `db/app.db` 並套用 `db/schema.sql`
2. 匯入 `db/seed.sql` 初始資料（若資料庫已存在則跳過）
3. 伺服器綁定 `PORT`（預設 3000，可透過環境變數覆寫）

### 2. 使用 Docker Compose

```bash
cd Wanrun-2025-Innovation-and-Creativity-Competition/vm-mini
docker compose up --build
```

- 預設會將應用程式跑在 `http://localhost:3100`
- Volume `./db:/app/db` 會保留本機 SQLite 檔案，重啟不會遺失資料
- 若要重置資料庫，先停用容器後刪除 `db/app.db*` 再重新啟動即可

---

## 系統架構概覽

```
┌──────────────────────────────────────────┐
│            前端 (Static HTML)            │
│  index.html / shop.html / checkout.html… │
│  ▸ Bootstrap 5 + 自訂樣式 + Chart.js     │
│  ▸ 透過 fetch 呼叫 REST API              │
└──────────────▲───────────────────────────┘
               │
┌──────────────┴───────────────────────────┐
│              Node.js 後端                 │
│  Express + better-sqlite3                 │
│  ▸ REST API：交易、回收、儀表板           │
│  ▸ 啟動時自動套用 schema / seed           │
│  ▸ 即時計算押金、減碳、節水               │
└──────────────▲───────────────────────────┘
               │
┌──────────────┴───────────────────────────┐
│                SQLite                     │
│  tx / tx_item / sku / users / rx …        │
│  ▸ WAL 模式，適用 Demo / PoC              │
│  ▸ Volume 保留資料                        │
└──────────────────────────────────────────┘
```

---

## 前端頁面導覽

| 頁面 | 路徑 | 重點功能 |
| --- | --- | --- |
| 首頁 | `/index.html` | 一頁式介紹流程、亮點與 ESG 展示 |
| 會員掃描 | `/scan.html` | 模擬會員卡掃描，自動跳轉至購物 |
| 訪客購物 | `/shop.html` | 商品搜尋、ESG 指標、購物袋側欄 |
| 三段式結帳 | `/checkout.html` | 金額確認 → 付款 → 發票（含押金資訊） |
| 出貨模擬 | `/dispense.html` | 展示出貨流程與設備狀態燈號 |
| 回收作業 | `/recycle.html` | 三步驟退押流程、條碼 / 收據碼驗證 |
| ESG 儀表板 | `/dashboard.html` | 即時營收 / 押金 / 減碳 / 節水 / 退押率 |
| 感謝頁 | `/thanks.html` | 完成交易後顯示 ESG 成效與亮點 |

---

## API 介面

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| `GET` | `/api/health` | 基本健康檢查 |
| `GET` | `/api/sku` | 取得可販售 SKU（自動附加 ESG 押金演算法） |
| `POST` | `/api/members/resolve` | 解析會員卡號，回傳會員資訊與押金餘額 |
| `POST` | `/api/tx` | 建立交易，回傳金額、押金、ESG 計算結果 |
| `POST` | `/api/payments/:tx_id/confirm` | 模擬付款結果，更新交易狀態 |
| `GET` | `/api/tx/:tx_id` | 取得交易與購買明細（收據 / thanks 頁用） |
| `GET` | `/api/metrics/summary` | 儀表板統計（營收、押金、退押率、7 日趨勢） |
| `POST` | `/api/recycle/precheck` | 回收前預檢：判斷是否可退押、提供 ESG 加分 |
| `POST` | `/api/recycle/confirm` | 確認退押或拒收，更新押金與回收紀錄 |

> 所有 JSON 回傳皆為 UTF-8 編碼；金額欄位採「分」為單位，前端以 `App.formatMoney` 格式化。

---

## 資料模型速覽

| 資料表 | 功能 | 重點欄位 |
| --- | --- | --- |
| `sku` | 商品主檔 | `price_cents`, `deposit_cents`, `carbon_saving`, `water_saving` |
| `tx` | 交易主檔 | `total_cents`, `deposit_total_cents`, `status`, `carbon_saving` |
| `tx_item` | 交易明細 | `qty`, `deposit_cents`, `subtotal_cents`, `refunded_qty` |
| `users` | 會員 | `mem_no`, `points`, `deposit_balance_cents` |
| `rx` | 回收紀錄 | `refundable_cents`, `carbon_credit`, `status` |
| `dispense_log` | 出貨記錄 | 模擬硬體出貨嘗試 / 結果 |

- 欄位定義請見 `db/schema.sql`
- `db/seed.sql` 提供範例 SKU、會員、交易歷史，方便 Demo
- 若需重置資料表，可刪除 `db/app.db` 再重新啟動

---

## 開發筆記

- **程式碼結構**
  ```
  vm-mini/
  ├── server.js          # Express 應用程式與 REST API
  ├── public/            # 靜態頁面與前端資產
  │   ├── assets/styles.css
  │   └── assets/app.js  # 共用元件、格式化工具
  ├── db/
  │   ├── schema.sql     # SQLite Schema
  │   └── seed.sql       # 範例資料
  └── docker-compose.yml / Dockerfile
  ```

- **前端工具**
  - Bootstrap 5 + Bootstrap Icons
  - Chart.js (儀表板折線 / 甜甜圈圖)
  - Vanilla JS + `App` 全域工具函式（Toast、金額格式、動畫計數器…）

- **後端實作細節**
  - 使用 `better-sqlite3` 提供同步資料庫操作，易於推演流程
  - 啟動時若資料庫缺欄位會執行 `ALTER TABLE`，確保舊版本也能升級
  - ESG 押金與獎勵金演算法在 `computeIncentiveCents`，依 SKU 減碳量自動調整押金
  - `/api/metrics/summary` 會計算：
    - 今日營收／押金池、減碳、節水
    - 累積資訊與退押率（實退 / 應退）
    - 最近 7 日營收 / 押金 / 退押金 / 減碳走勢

---

## 常見操作與 FAQ

- **如何重建乾淨資料？**  
  刪除 `vm-mini/db/app.db*` 後重新執行 `node server.js` 或 `docker compose up --build` 即可重新套用 schema 與 seed。

- **想新增商品 / 會員？**  
  可直接編輯 `db/seed.sql` 後重建資料庫，或在程式啟動後透過 `better-sqlite3` client / DB Browser 手動插入。

- **如何調整押金計算？**  
  修改 `server.js` 中 `computeIncentiveCents` 邏輯，或在 `sku` 表新增 `deposit_cents` 指定固定押金。

- **要切換埠號 / 環境？**  
  設定 `PORT` 環境變數，例如 `PORT=4000 node server.js` 或在 Docker Compose `environment` 中覆寫。

- **部署建議？**  
  目前採單一 Node.js + SQLite，適合 Demo、PoC、比賽展示。若要擴充為正式環境，可：
  - 改用托管 DB（PostgreSQL、MySQL…）並轉換 SQL
  - 將靜態資源放置 CDN，後端改為 API-only
  - 以 PM2 / systemd 部署 Node.js 服務，或將容器推送至雲端託管

---

## 開發維運建議

- **程式碼格式 / Lint**：專案未綁定特定風格，可依團隊慣例導入 ESLint + Prettier。
- **測試策略**：目前僅提供 Demo 行為，若要上線可補齊：
  - 零售流程整合測試（建立交易→付款→退押）
  - 儀表板資料一致性測試（比對 SQL 聚合結果）
- **監控**：可加入 `morgan` 紀錄 API log、或利用 Docker 健康檢查確保服務在線。

---

## 版權與授權

本專案內容供 Wanrun 2025 Innovation & Creativity Competition Demo 使用。若需延伸開發或商用發布，請先與專案維護者確認授權範圍。

---

## 聯絡

如需技術支援、客製化或整合實體機台，可透過原專案提交者聯繫，或在 Issue 中提出需求。歡迎貢獻改善、擴充更多 ESG 指標或接入第三方系統。 Let's build smarter vending together!

