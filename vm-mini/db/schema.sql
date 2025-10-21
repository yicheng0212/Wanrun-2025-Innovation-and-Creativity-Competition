PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS sku (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  barcode TEXT,
  price_cents INTEGER NOT NULL,       -- 金額用「分」
  deposit_cents INTEGER NOT NULL,     -- 押金
  lane_no INTEGER,                    -- 料道（可為 NULL）
  stock INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  carbon_saving REAL DEFAULT 0,       -- 每瓶減碳 (kg CO₂e)
  water_saving REAL DEFAULT 0,        -- 每瓶節水 (L)
  image_url TEXT,                     -- 商品示意圖路徑（相對或絕對 URL）
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 之後要用到的交易表，先建起來（空即可）
CREATE TABLE IF NOT EXISTS tx (
  id TEXT PRIMARY KEY,
  user_id TEXT,                       -- 一次性活動可為 NULL
  total_cents INTEGER NOT NULL,
  deposit_total_cents INTEGER NOT NULL,
  status TEXT NOT NULL,               -- created / paid / dispensing / done...
  carbon_saving REAL DEFAULT 0,
  water_saving REAL DEFAULT 0,
  tx_refund_cents INTEGER DEFAULT 0,  -- 部分退款金額（分）
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tx_item (
  id TEXT PRIMARY KEY,
  tx_id TEXT NOT NULL,
  sku_id TEXT NOT NULL,
  qty INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  deposit_cents INTEGER NOT NULL,
  subtotal_cents INTEGER NOT NULL,
  refunded_qty INTEGER DEFAULT 0
);

-- 會員表（一次性比賽版，只有卡號與暱稱）
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  mem_no TEXT UNIQUE NOT NULL,
  name TEXT,
  points INTEGER DEFAULT 0,
  deposit_balance_cents INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 出貨日誌（記錄每一次嘗試）
CREATE TABLE IF NOT EXISTS dispense_log (
  id TEXT PRIMARY KEY,
  tx_id TEXT NOT NULL,
  sku_id TEXT NOT NULL,
  lane_no INTEGER,
  attempt_no INTEGER NOT NULL,
  result TEXT NOT NULL,               -- success | jam | empty | error
  message TEXT,
  ts TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 交易退款金額（部分退款用；單位：分）
-- 若欄位已存在不會重複新增（透過後端開機時的 try/ALTER 保護）



-- 回收主表
CREATE TABLE IF NOT EXISTS rx (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL,              -- 'barcode' | 'receipt'
  code TEXT NOT NULL,                -- 掃到的內容（sku 或 tx|sku|idx）
  sku_id TEXT NOT NULL,
  refundable_cents INTEGER NOT NULL, -- 本次退押金
  carbon_credit REAL DEFAULT 0,      -- 本次加分（可用 sku.carbon_saving 的一部分）
  water_credit REAL DEFAULT 0,
  status TEXT DEFAULT 'accepted',    -- accepted | rejected
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 反重複（收據碼模式用）
CREATE UNIQUE INDEX IF NOT EXISTS idx_rx_unique_receipt
  ON rx(code) WHERE source='receipt';

-- 優化儀表板查詢：針對狀態＋日期組合建立索引
CREATE INDEX IF NOT EXISTS idx_tx_status_created
  ON tx(status, created_at);

CREATE INDEX IF NOT EXISTS idx_rx_status_created
  ON rx(status, created_at);
