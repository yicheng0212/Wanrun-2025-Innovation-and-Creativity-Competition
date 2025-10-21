const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = new Database(path.join(__dirname, 'db', 'app.db'));
// 啟動時套用資料表結構與預設資料，確保 sqlite 在任何環境都可運作
db.exec(require('fs').readFileSync(path.join(__dirname,'db','schema.sql'),'utf8'));
try {
  db.exec(require('fs').readFileSync(path.join(__dirname,'db','seed.sql'),'utf8'));
} catch(e){
  /* avoid duplicate */
}

function ensureColumn(table, column, alterSql){
  try {
    db.prepare(`SELECT ${column} FROM ${table} LIMIT 1`).get();
  } catch (err) {
    try { db.exec(alterSql); } catch (err2) { /* 已存在或無法新增時忽略 */ }
  }
}

ensureColumn('tx', 'tx_refund_cents', `ALTER TABLE tx ADD COLUMN tx_refund_cents INTEGER DEFAULT 0;`);
ensureColumn('tx_item', 'refunded_qty', `ALTER TABLE tx_item ADD COLUMN refunded_qty INTEGER DEFAULT 0;`);
ensureColumn('sku', 'barcode', `ALTER TABLE sku ADD COLUMN barcode TEXT;`);
ensureColumn('sku', 'image_url', `ALTER TABLE sku ADD COLUMN image_url TEXT;`);

const MIN_REWARD_CENTS = 500;
const MAX_REWARD_CENTS = 1500;
const ACTIVE_STATUSES_FOR_DEPOSIT = `('done','paid','dispensing')`;

// 預編譯常用查詢，減少每次 API prepare 的成本
const stmtCarbonBounds = db.prepare(`
  SELECT MIN(carbon_saving) AS min_carbon, MAX(carbon_saving) AS max_carbon
  FROM sku WHERE status='active'
`);
const stmtListActiveSku = db.prepare(`
  SELECT id,name,category,barcode,price_cents,deposit_cents,lane_no,stock,status,
         carbon_saving,water_saving,image_url
  FROM sku WHERE status='active' ORDER BY lane_no ASC
`);
const stmtFindUserByMem = db.prepare(`SELECT * FROM users WHERE UPPER(mem_no)=UPPER(?) AND status='active'`);
const stmtFindUserSummary = db.prepare(`SELECT mem_no,name,points,deposit_balance_cents FROM users WHERE id=?`);
const stmtFindSkuById = db.prepare(`SELECT * FROM sku WHERE id=? AND status='active'`);
const stmtFindSkuByBarcode = db.prepare(`SELECT * FROM sku WHERE barcode=? AND status='active'`);
const stmtTxById = db.prepare(`SELECT * FROM tx WHERE id=?`);
const stmtTxItemsByTx = db.prepare(`
  SELECT ti.*, s.name AS sku_name, s.lane_no, s.stock, s.deposit_cents
  FROM tx_item ti JOIN sku s ON s.id=ti.sku_id
  WHERE ti.tx_id=?
`);
const stmtStockBySku = db.prepare(`SELECT stock FROM sku WHERE id=?`);
const stmtUpdateStock = db.prepare(`UPDATE sku SET stock=stock-? WHERE id=? AND stock>=?`);
const stmtUpdateTxStatus = db.prepare(`UPDATE tx SET status=? WHERE id=?`);
const stmtIncreaseDepositBalance = db.prepare(`UPDATE users SET deposit_balance_cents = deposit_balance_cents + ? WHERE id=?`);
const stmtTodayRxCount = db.prepare(`
  SELECT COUNT(*) AS c FROM rx
  WHERE user_id=? AND sku_id=? AND date(created_at,'localtime')=date('now','localtime') AND status='accepted'
`);
const stmtInsertTx = db.prepare(`
  INSERT INTO tx (id,user_id,total_cents,deposit_total_cents,status,carbon_saving,water_saving)
  VALUES (?,?,?,?,?,?,?)
`);
const stmtInsertTxItem = db.prepare(`
  INSERT INTO tx_item (id,tx_id,sku_id,qty,unit_price_cents,deposit_cents,subtotal_cents)
  VALUES (?,?,?,?,?,?,?)
`);
const stmtTxItemsWithName = db.prepare(`
  SELECT ti.*, s.name AS sku_name
  FROM tx_item ti JOIN sku s ON s.id=ti.sku_id
  WHERE ti.tx_id=?
`);
const stmtMarkTxDone = db.prepare(`UPDATE tx SET status='done', tx_refund_cents=0 WHERE id=?`);
const stmtRxReceiptLookup = db.prepare(`
  SELECT ti.*, s.name AS sku_name, s.deposit_cents, s.carbon_saving, s.water_saving
  FROM tx_item ti JOIN sku s ON s.id=ti.sku_id
  WHERE ti.tx_id=? AND ti.sku_id=?
`);
const stmtInsertRx = db.prepare(`
  INSERT INTO rx(id,user_id,source,code,sku_id,refundable_cents,carbon_credit,water_credit,status)
  VALUES(?,?,?,?,?,?,?,?,?)
`);
const stmtUpdateTxItemRefunded = db.prepare(`UPDATE tx_item SET refunded_qty = refunded_qty + 1 WHERE id=?`);
const stmtUserBalance = db.prepare(`SELECT deposit_balance_cents FROM users WHERE id=?`);
const stmtMetricsToday = db.prepare(`
  SELECT
    IFNULL(SUM(CASE WHEN date(created_at, 'localtime')=date('now','localtime') AND status='done' THEN total_cents - IFNULL(tx_refund_cents,0) END),0) AS revenue_today,
    IFNULL(SUM(CASE WHEN date(created_at, 'localtime')=date('now','localtime') AND status IN ${ACTIVE_STATUSES_FOR_DEPOSIT} THEN deposit_total_cents END),0) AS deposit_today,
    IFNULL(SUM(CASE WHEN date(created_at, 'localtime')=date('now','localtime') THEN carbon_saving END),0) AS carbon_today,
    IFNULL(SUM(CASE WHEN date(created_at, 'localtime')=date('now','localtime') THEN water_saving END),0) AS water_today
  FROM tx
`);
const stmtMetricsTotal = db.prepare(`
  SELECT
    IFNULL(SUM(CASE WHEN status='done' THEN total_cents - IFNULL(tx_refund_cents,0) END),0) AS revenue_all,
    IFNULL(SUM(CASE WHEN status IN ${ACTIVE_STATUSES_FOR_DEPOSIT} THEN deposit_total_cents END),0) AS deposit_all,
    IFNULL(SUM(carbon_saving),0) AS carbon_all,
    IFNULL(SUM(water_saving),0) AS water_all
  FROM tx
`);
const stmtMetricsDaily = db.prepare(`
  SELECT date(created_at,'localtime') AS d,
         SUM(total_cents - IFNULL(tx_refund_cents,0)) AS revenue_cents,
         SUM(CASE WHEN status IN ${ACTIVE_STATUSES_FOR_DEPOSIT} THEN deposit_total_cents END) AS deposit_cents,
         SUM(carbon_saving) AS carbon,
         SUM(water_saving) AS water
  FROM tx
  GROUP BY date(created_at,'localtime')
  ORDER BY d DESC
  LIMIT 7
`);
const stmtDepositDue = db.prepare(`
  SELECT
    IFNULL(SUM(CASE WHEN status IN ${ACTIVE_STATUSES_FOR_DEPOSIT} AND date(created_at,'localtime')=date('now','localtime') THEN deposit_total_cents END),0) AS due_today,
    IFNULL(SUM(CASE WHEN status IN ${ACTIVE_STATUSES_FOR_DEPOSIT} THEN deposit_total_cents END),0) AS due_all
  FROM tx
`);
const stmtRefundStats = db.prepare(`
  SELECT
    IFNULL(SUM(CASE WHEN status='accepted' AND date(created_at,'localtime')=date('now','localtime') THEN refundable_cents END),0) AS refunded_today,
    IFNULL(SUM(CASE WHEN status='accepted' THEN refundable_cents END),0) AS refunded_all,
    IFNULL(SUM(CASE WHEN status='accepted' AND date(created_at,'localtime')=date('now','localtime') THEN 1 END),0) AS accepted_today,
    IFNULL(SUM(CASE WHEN status='rejected' AND date(created_at,'localtime')=date('now','localtime') THEN 1 END),0) AS rejected_today,
    IFNULL(SUM(CASE WHEN status='accepted' THEN 1 END),0) AS accepted_all,
    IFNULL(SUM(CASE WHEN status='rejected' THEN 1 END),0) AS rejected_all
  FROM rx
`);
const stmtRefundDaily = db.prepare(`
  SELECT date(created_at,'localtime') AS d,
         SUM(CASE WHEN status='accepted' THEN refundable_cents END) AS refunded_cents,
         SUM(CASE WHEN status='accepted' THEN 1 END) AS accepted_count,
         SUM(CASE WHEN status='rejected' THEN 1 END) AS rejected_count
  FROM rx
  GROUP BY date(created_at,'localtime')
`);

function fetchCarbonBounds(){
  const row = stmtCarbonBounds.get();
  return {
    min: row?.min_carbon ?? 0,
    max: row?.max_carbon ?? 0
  };
}

function computeIncentiveCents(carbonSaving, bounds){
  // 根據 SKU 減碳量動態推算押金／獎勵，落在 MIN~MAX 區間內
  const carbon = Number(carbonSaving) || 0;
  const min = bounds?.min ?? 0;
  const max = bounds?.max ?? min;
  if (max <= min) return MIN_REWARD_CENTS;
  const normalized = Math.min(1, Math.max(0, (carbon - min) / (max - min)));
  const reward = MIN_REWARD_CENTS + (MAX_REWARD_CENTS - MIN_REWARD_CENTS) * normalized;
  return Math.round(reward);
}

function enhanceSkuRow(row, bounds){
  const incentive = computeIncentiveCents(row.carbon_saving, bounds);
  const deposit = row.deposit_cents > 0 ? row.deposit_cents : incentive;
  return {
    ...row,
    deposit_cents: deposit,
    reward_cents: incentive
  };
}

app.get('/api/health', (_,res)=>res.json({ok:true}));

// 取得所有可販售的 SKU，提供給前台商品列表使用
app.get('/api/sku', (req,res)=>{
  const bounds = fetchCarbonBounds();
  const rows = stmtListActiveSku.all().map(row=>enhanceSkuRow(row, bounds));
  res.json(rows);
});


// --- 會員：用 mem_no 解析 ---
app.post('/api/members/resolve', (req,res)=>{
  const { mem_no } = req.body || {};
  const normalized = (mem_no ?? '').toString().trim();
  if(!normalized) return res.status(400).json({error:'mem_no required'});
  const user = stmtFindUserByMem.get(normalized);
  if(!user) return res.status(404).json({error:'member not found'});
  res.json({ user_id: user.id, mem_no: user.mem_no, name: user.name || '訪客',
             points: user.points, deposit_balance_cents: user.deposit_balance_cents });
});

// 小工具：抓 SKU
function getSkuMap(ids, bounds){
  const map = new Map();
  ids.forEach(id=>{
    const row = stmtFindSkuById.get(id);
    if(row){
      map.set(id, enhanceSkuRow(row, bounds));
    }
  });
  return map;
}

// --- 建立交易（created）---
app.post('/api/tx', (req,res)=>{
  const { mem_no, items=[] } = req.body || {};
  if(!Array.isArray(items) || items.length===0) return res.status(400).json({error:'items required'});
  // 解析會員（可為空，支援訪客交易）
  let user = null;
  if(mem_no){
    const normalizedMem = mem_no.toString().trim();
    user = normalizedMem ? stmtFindUserByMem.get(normalizedMem) : null;
    if(!user) return res.status(404).json({error:'member not found'});
  }
  // 驗證 SKU 與計價，同時計算 ESG 數據
  const ids = [...new Set(items.map(i=>i.sku_id))];
  const bounds = fetchCarbonBounds();
  const skuMap = getSkuMap(ids, bounds);
  let total = 0, depositTotal = 0, carbon = 0, water = 0;
  let pricedItems;
  try {
    pricedItems = items.map(it=>{
      const sku = skuMap.get(it.sku_id);
      if(!sku) throw new Error(`sku not found: ${it.sku_id}`);
      const qty = Math.max(1, parseInt(it.qty||1,10));
      const subtotal = (sku.price_cents + sku.deposit_cents) * qty;
      total += subtotal;
      depositTotal += sku.deposit_cents * qty;
      carbon += (sku.carbon_saving||0) * qty;
      water  += (sku.water_saving||0) * qty;
      return {
        sku_id: sku.id, qty,
        unit_price_cents: sku.price_cents,
        deposit_cents: sku.deposit_cents,
        subtotal_cents: subtotal
      };
    });
  } catch(err){
    return res.status(400).json({ error: err.message });
  }

  const txId = uuidv4();
  const txn = db.transaction(()=>{
    stmtInsertTx.run(txId, user?.id || null, total, depositTotal, 'created', carbon, water);
    pricedItems.forEach(pi=>{
      stmtInsertTxItem.run(uuidv4(), txId, pi.sku_id, pi.qty,
        pi.unit_price_cents, pi.deposit_cents, pi.subtotal_cents);
    });
  });
  try { txn(); } catch(e){ return res.status(500).json({error:e.message}); }

  res.json({
    tx_id: txId,
    status: 'created',
    total_cents: total,
    deposit_total_cents: depositTotal,
    carbon_saving: +carbon.toFixed(3),
    water_saving: +water.toFixed(1)
  });
});

// --- 付款確認（success / fail / timeout）---
app.post('/api/payments/:tx_id/confirm', (req,res)=>{
  const { tx_id } = req.params;
  const { status } = req.body || {};
  const tx = stmtTxById.get(tx_id);
  if(!tx) return res.status(404).json({error:'tx not found'});
  if(tx.status!=='created') return res.status(400).json({error:`invalid status ${tx.status}`});
  if(!['success','fail','timeout'].includes(status)) return res.status(400).json({error:'status invalid'});

  let newStatus;
  if(status === 'success'){
    const result = completeTx(tx_id);
    if(!result.ok){
      return res.status(400).json({ error: result.error || 'complete tx failed' });
    }
    newStatus = 'done';
  } else {
    newStatus = 'canceled';
    stmtUpdateTxStatus.run(newStatus, tx_id);
  }
  res.json({ tx_id, status: newStatus });
});

// --- 查交易（收據頁使用）---
app.get('/api/tx/:tx_id', (req,res)=>{
  const { tx_id } = req.params;
  const tx = stmtTxById.get(tx_id);
  if(!tx) return res.status(404).json({error:'tx not found'});
  const items = stmtTxItemsWithName.all(tx_id);
  const user = tx.user_id ? stmtFindUserSummary.get(tx.user_id) : null;
  res.json({ tx, items, user });
});

// 工具：安全扣庫存（避免負數）
function decStock(skuId, qty=1){
  const row = stmtStockBySku.get(skuId);
  if(!row || row.stock < qty) return false;
  const result = stmtUpdateStock.run(qty, skuId, qty);
  return result.changes > 0;
}

// 取得一筆交易與品項 + SKU
function getTxFull(txId){
  const tx = stmtTxById.get(txId);
  if(!tx) return null;
  const items = stmtTxItemsByTx.all(txId);
  return { tx, items };
}

function completeTx(txId){
  const bundle = getTxFull(txId);
  if(!bundle) return { ok:false, error:'tx not found' };
  const { tx, items } = bundle;
  if(tx.status !== 'created' && tx.status !== 'paid'){
    return { ok:false, error:`invalid status ${tx.status}` };
  }
  const txn = db.transaction(()=>{
    for(const item of items){
      if(!decStock(item.sku_id, item.qty)){
        throw new Error(`stock insufficient: ${item.sku_id}`);
      }
    }
    stmtMarkTxDone.run(txId);
  });
  try {
    txn();
    return { ok:true };
  } catch (err){
    const message = String(err.message || '');
    const friendly = message.includes('stock insufficient')
      ? '庫存不足，請返回商品頁重新確認'
      : message;
    return { ok:false, error: friendly };
  }
}

// --- 儀表板數據：即時計算今日成效、累積與最近 7 天走勢 ---
app.get('/api/metrics/summary', (req,res)=>{
  const today = stmtMetricsToday.get();
  const total = stmtMetricsTotal.get();
  const dailyRaw = stmtMetricsDaily.all();
  const depositDue = stmtDepositDue.get();
  const refundStats = stmtRefundStats.get();
  const dailyRefundRows = stmtRefundDaily.all();

  const refundByDate = new Map(dailyRefundRows.map(row=>[row.d, row]));
  const dailyWithRefunds = dailyRaw.reverse().map(row=>{
    const refundRow = refundByDate.get(row.d) || {};
    const depositCents = row.deposit_cents || 0;
    const refundedCents = refundRow.refunded_cents || 0;
    return {
      ...row,
      refunded_cents: refundedCents,
      refund_rate: depositCents ? refundedCents / depositCents : 0,
      accepted_count: refundRow.accepted_count || 0,
      rejected_count: refundRow.rejected_count || 0
    };
  });

  const depositTodayDue = depositDue.due_today || 0;
  const depositTotalDue = depositDue.due_all || 0;
  const depositRefundedToday = refundStats.refunded_today || 0;
  const depositRefundedAll = refundStats.refunded_all || 0;

  const todayDepositPending = Math.max(0, depositTodayDue - depositRefundedToday);
  const totalDepositPending = Math.max(0, depositTotalDue - depositRefundedAll);

  const todayDepositRate = depositTodayDue ? depositRefundedToday / depositTodayDue : 0;
  const totalDepositRate = depositTotalDue ? depositRefundedAll / depositTotalDue : 0;

  const extendedToday = {
    ...today,
    deposit_refunded: depositRefundedToday,
    deposit_pending: todayDepositPending,
    deposit_refund_rate: todayDepositRate,
    recycle_accepted: refundStats.accepted_today || 0,
    recycle_rejected: refundStats.rejected_today || 0
  };

  const extendedTotal = {
    ...total,
    deposit_refunded: depositRefundedAll,
    deposit_pending: totalDepositPending,
    deposit_refund_rate: totalDepositRate,
    recycle_accepted: refundStats.accepted_all || 0,
    recycle_rejected: refundStats.rejected_all || 0
  };

  res.json({
    today: extendedToday,
    total: extendedTotal,
    daily: dailyWithRefunds
  });
});


// 取得會員與 SKU 共用查詢
function findUserByMem(mem){
  if(!mem) return null;
  const normalized = mem.toString().trim();
  if(!normalized) return null;
  return stmtFindUserByMem.get(normalized);
}
function findSku(id){ return stmtFindSkuById.get(id); }
function findSkuByBarcode(code){ return stmtFindSkuByBarcode.get(code); }

// 每日同 SKU 退押金次數（防濫用）
function todayCountByUserSku(user_id, sku_id){
  if(!user_id) return 0;
  const row = stmtTodayRxCount.get(user_id, sku_id);
  return row?.c || 0;
}

app.post('/api/recycle/precheck', (req,res)=>{
  const { mem_no, code } = req.body || {};
  if(!code) return res.status(400).json({error:'code required'});
  let user = null;
  if(mem_no){
    user = findUserByMem(mem_no);
    if(!user) return res.status(404).json({error:'member not found'});
  }

  let sku=null, source='barcode', refundable=0, warn=null;

  if(code.includes('|')) {
    source='receipt';
    const [tx_id, sku_id] = code.split('|');
    const item = stmtRxReceiptLookup.get(tx_id, sku_id);
    if(!item) return res.status(404).json({error:'receipt not match'});
    if(item.refunded_qty >= item.qty) return res.status(400).json({error:'already fully refunded'});
    sku = item; refundable = item.deposit_cents;
  } else {
    sku = findSku(code) || findSkuByBarcode(code);
    if(!sku) return res.status(404).json({error:'sku not found'});
    refundable = sku.deposit_cents;
  }

  if(refundable<=0) return res.status(400).json({error:'this item has no deposit'});

  const daily = todayCountByUserSku(user?.id, sku.sku_id || sku.id);
  const LIMIT = 5;
  if(user && daily >= LIMIT) warn = `今日同品已達上限 ${LIMIT} 件，可能被拒收`;

  res.json({
    ok:true,
    source,
    sku_id: sku.sku_id || sku.id,
    sku_name: sku.sku_name || sku.name,
    refundable_cents: refundable,
    carbon_credit: +( (sku.carbon_saving||0) * 0.8 ).toFixed(3),
    water_credit: +( (sku.water_saving||0) * 0.8 ).toFixed(1),
    warn,
    mode: user ? 'member' : 'guest'
  });
});


app.post('/api/recycle/confirm', (req,res)=>{
  const { mem_no, code, decision='accept' } = req.body || {};
  if(!code) return res.status(400).json({error:'code required'});
  let user = null;
  if(mem_no){
    user = findUserByMem(mem_no);
    if(!user) return res.status(404).json({error:'member not found'});
  }

  function getSkuRef(){
    if(code.includes('|')){
      const [tx_id, sku_id] = code.split('|');
      const item = stmtRxReceiptLookup.get(tx_id, sku_id);
      if(!item) throw new Error('receipt not match');
      return {source:'receipt', sku_id: sku_id, sku_name:item.sku_name, refundable:item.deposit_cents, carbon:item.carbon_saving||0, water:item.water_saving||0, tx_item_id:item.id, tx_id};
    }
    const s = findSku(code) || findSkuByBarcode(code);
    if(!s) throw new Error('sku not found');
    return {source:'barcode', sku_id: s.id, sku_name:s.name, refundable:s.deposit_cents, carbon:s.carbon_saving||0, water:s.water_saving||0};
  }

  let info;
  try { info = getSkuRef(); } catch(e){ return res.status(400).json({error:e.message}); }
  if(info.refundable<=0) return res.status(400).json({error:'no deposit'});

  if(decision==='reject'){
    const rxId = uuidv4();
    stmtInsertRx.run(rxId, user?.id || '__guest__', info.source, code, info.sku_id, 0, 0, 0, 'rejected');
    return res.json({ rx_id: rxId, status:'rejected' });
  }

  const rxId = uuidv4();
  const txn = db.transaction(()=>{
    const rxUserId = user?.id || '__guest__';
    stmtInsertRx.run(rxId, rxUserId, info.source, code, info.sku_id, info.refundable, info.carbon*0.8, info.water*0.8, 'accepted');
    if(user){
      stmtIncreaseDepositBalance.run(info.refundable, user.id);
    }
    if(info.source==='receipt'){
      stmtUpdateTxItemRefunded.run(info.tx_item_id);
    }
  });
  try { txn(); } catch(e){ return res.status(500).json({error:e.message}); }

  const balance = user ? stmtUserBalance.get(user.id).deposit_balance_cents : null;
  res.json({
    rx_id: rxId,
    status: 'accepted',
    refunded_cents: info.refundable,
    member_balance_cents: balance,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`VM server on http://localhost:${PORT}`));
