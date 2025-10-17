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

const MIN_REWARD_CENTS = 500;
const MAX_REWARD_CENTS = 1500;

function fetchCarbonBounds(){
  const row = db.prepare(`
    SELECT MIN(carbon_saving) AS min_carbon, MAX(carbon_saving) AS max_carbon
    FROM sku WHERE status='active'
  `).get();
  return {
    min: row?.min_carbon ?? 0,
    max: row?.max_carbon ?? 0
  };
}

function computeIncentiveCents(carbonSaving, bounds){
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
  return {
    ...row,
    deposit_cents: incentive,
    reward_cents: incentive
  };
}

app.get('/api/health', (_,res)=>res.json({ok:true}));

// 取得所有可販售的 SKU，提供給前台商品列表使用
app.get('/api/sku', (req,res)=>{
  const bounds = fetchCarbonBounds();
  const rows = db.prepare(`
    SELECT id,name,category,barcode,price_cents,deposit_cents,lane_no,stock,status,
           carbon_saving,water_saving,image_url
    FROM sku WHERE status='active' ORDER BY lane_no ASC
  `).all().map(row=>enhanceSkuRow(row, bounds));
  res.json(rows);
});


// --- 會員：用 mem_no 解析 ---
app.post('/api/members/resolve', (req,res)=>{
  const { mem_no } = req.body || {};
  if(!mem_no) return res.status(400).json({error:'mem_no required'});
  const user = db.prepare(`SELECT * FROM users WHERE mem_no=? AND status='active'`).get(mem_no);
  if(!user) return res.status(404).json({error:'member not found'});
  res.json({ user_id: user.id, mem_no: user.mem_no, name: user.name || '訪客',
             points: user.points, deposit_balance_cents: user.deposit_balance_cents });
});

// 小工具：抓 SKU
function getSkuMap(ids){
  const qs = ids.map(()=>'?').join(',');
  const bounds = fetchCarbonBounds();
  const rows = db.prepare(`SELECT * FROM sku WHERE id IN (${qs})`).all(...ids)
    .map(row=>enhanceSkuRow(row, bounds));
  const map = new Map(rows.map(r=>[r.id,r]));
  return map;
}

// --- 建立交易（created）---
app.post('/api/tx', (req,res)=>{
  const { mem_no, items=[] } = req.body || {};
  if(!Array.isArray(items) || items.length===0) return res.status(400).json({error:'items required'});
  // 解析會員（可為空，支援訪客交易）
  let user = null;
  if(mem_no){
    user = db.prepare(`SELECT * FROM users WHERE mem_no=? AND status='active'`).get(mem_no);
    if(!user) return res.status(404).json({error:'member not found'});
  }
  // 驗證 SKU 與計價，同時計算 ESG 數據
  const ids = [...new Set(items.map(i=>i.sku_id))];
  const skuMap = getSkuMap(ids);
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
  const insertTx = db.prepare(`INSERT INTO tx
    (id,user_id,total_cents,deposit_total_cents,status,carbon_saving,water_saving)
    VALUES (?,?,?,?,?,?,?)`);
  const insertItem = db.prepare(`INSERT INTO tx_item
    (id,tx_id,sku_id,qty,unit_price_cents,deposit_cents,subtotal_cents)
    VALUES (?,?,?,?,?,?,?)`);

  const txn = db.transaction(()=>{
    insertTx.run(txId, user?.id || null, total, depositTotal, 'created', carbon, water);
    pricedItems.forEach(pi=>{
      insertItem.run(uuidv4(), txId, pi.sku_id, pi.qty,
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
  const tx = db.prepare(`SELECT * FROM tx WHERE id=?`).get(tx_id);
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
    db.prepare(`UPDATE tx SET status=? WHERE id=?`).run(newStatus, tx_id);
  }
  res.json({ tx_id, status: newStatus });
});

// --- 查交易（收據頁使用）---
app.get('/api/tx/:tx_id', (req,res)=>{
  const { tx_id } = req.params;
  const tx = db.prepare(`SELECT * FROM tx WHERE id=?`).get(tx_id);
  if(!tx) return res.status(404).json({error:'tx not found'});
  const items = db.prepare(`
    SELECT ti.*, s.name AS sku_name
    FROM tx_item ti JOIN sku s ON s.id=ti.sku_id
    WHERE ti.tx_id=?`).all(tx_id);
  let user=null;
  if(tx.user_id){
    user = db.prepare(`SELECT mem_no,name,points,deposit_balance_cents FROM users WHERE id=?`).get(tx.user_id);
  }
  res.json({ tx, items, user });
});
// --- 啟動時保險，沒有欄位就加 ---
try {
  db.prepare(`SELECT tx_refund_cents FROM tx LIMIT 1`).get();
} catch (e) {
  try { db.exec(`ALTER TABLE tx ADD COLUMN tx_refund_cents INTEGER DEFAULT 0;`); }
  catch (e2) { /* 已存在就忽略 */ }
}

try {
  db.prepare(`SELECT refunded_qty FROM tx_item LIMIT 1`).get();
} catch (e) {
  try { db.exec(`ALTER TABLE tx_item ADD COLUMN refunded_qty INTEGER DEFAULT 0;`); }
  catch (e2) { /* 已存在就忽略 */ }
}

try {
  db.prepare(`SELECT barcode FROM sku LIMIT 1`).get();
} catch (e) {
  try { db.exec(`ALTER TABLE sku ADD COLUMN barcode TEXT;`); }
  catch (e2) { /* 已存在就忽略 */ }
}

try {
  db.prepare(`SELECT image_url FROM sku LIMIT 1`).get();
} catch (e) {
  try { db.exec(`ALTER TABLE sku ADD COLUMN image_url TEXT;`); }
  catch (e2) { /* 已存在就忽略 */ }
}

// 工具：安全扣庫存（避免負數）
function decStock(skuId, qty=1){
  const row = db.prepare(`SELECT stock FROM sku WHERE id=?`).get(skuId);
  if(!row || row.stock < qty) return false;
  const result = db.prepare(`UPDATE sku SET stock=stock-? WHERE id=? AND stock>=?`).run(qty, skuId, qty);
  return result.changes > 0;
}

// 取得一筆交易與品項 + SKU
function getTxFull(txId){
  const tx = db.prepare(`SELECT * FROM tx WHERE id=?`).get(txId);
  if(!tx) return null;
  const items = db.prepare(`
    SELECT ti.*, s.name AS sku_name, s.lane_no, s.stock, s.deposit_cents
    FROM tx_item ti JOIN sku s ON s.id=ti.sku_id
    WHERE ti.tx_id=?`).all(txId);
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
    db.prepare(`UPDATE tx SET status=?, tx_refund_cents=0 WHERE id=?`).run('done', txId);
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
  const today = db.prepare(`
    SELECT
      IFNULL(SUM(CASE WHEN date(created_at, 'localtime')=date('now','localtime') AND status='done' THEN total_cents - IFNULL(tx_refund_cents,0) END),0) AS revenue_today,
      IFNULL(SUM(CASE WHEN date(created_at, 'localtime')=date('now','localtime') AND status IN ('paid','dispensing','done') THEN deposit_total_cents END),0) AS deposit_today,
      IFNULL(SUM(CASE WHEN date(created_at, 'localtime')=date('now','localtime') THEN carbon_saving END),0) AS carbon_today,
      IFNULL(SUM(CASE WHEN date(created_at, 'localtime')=date('now','localtime') THEN water_saving END),0) AS water_today
    FROM tx;
  `).get();

  const total = db.prepare(`
    SELECT
      IFNULL(SUM(CASE WHEN status='done' THEN total_cents - IFNULL(tx_refund_cents,0) END),0) AS revenue_all,
      IFNULL(SUM(deposit_total_cents),0) AS deposit_all,
      IFNULL(SUM(carbon_saving),0) AS carbon_all,
      IFNULL(SUM(water_saving),0) AS water_all
    FROM tx;
  `).get();

  // 最近7天（畫折線圖）
  const daily = db.prepare(`
    SELECT date(created_at,'localtime') AS d,
           SUM(total_cents - IFNULL(tx_refund_cents,0)) AS revenue_cents,
           SUM(deposit_total_cents) AS deposit_cents,
           SUM(carbon_saving) AS carbon,
           SUM(water_saving) AS water
    FROM tx
    GROUP BY date(created_at,'localtime')
    ORDER BY d DESC
    LIMIT 7;
  `).all();

  res.json({ today, total, daily: daily.reverse() });
});


// 取得會員
function findUserByMem(mem){ return db.prepare(`SELECT * FROM users WHERE mem_no=? AND status='active'`).get(mem); }
// 取得 sku
function findSku(id){ return db.prepare(`SELECT * FROM sku WHERE id=? AND status='active'`).get(id); }

// 每日同 SKU 退押金次數（防濫用）

function todayCountByUserSku(user_id, sku_id){
  if(!user_id) return 0;
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM rx
    WHERE user_id=? AND sku_id=? AND date(created_at,'localtime')=date('now','localtime') AND status='accepted'
  `).get(user_id, sku_id);
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
    const item = db.prepare(`SELECT ti.*, s.name AS sku_name, s.deposit_cents, s.carbon_saving, s.water_saving
                             FROM tx_item ti JOIN sku s ON s.id=ti.sku_id
                             WHERE ti.tx_id=? AND ti.sku_id=?`).get(tx_id, sku_id);
    if(!item) return res.status(404).json({error:'receipt not match'});
    if(item.refunded_qty >= item.qty) return res.status(400).json({error:'already fully refunded'});
    sku = item; refundable = item.deposit_cents;
  } else {
    sku = findSku(code) || db.prepare(`SELECT * FROM sku WHERE barcode=? AND status='active'`).get(code);
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
      const item = db.prepare(`SELECT ti.*, s.name AS sku_name, s.deposit_cents, s.carbon_saving, s.water_saving
                               FROM tx_item ti JOIN sku s ON s.id=ti.sku_id
                               WHERE ti.tx_id=? AND ti.sku_id=?`).get(tx_id, sku_id);
      if(!item) throw new Error('receipt not match');
      return {source:'receipt', sku_id: sku_id, sku_name:item.sku_name, refundable:item.deposit_cents, carbon:item.carbon_saving||0, water:item.water_saving||0, tx_item_id:item.id, tx_id};
    }
    const s = findSku(code) || db.prepare(`SELECT * FROM sku WHERE barcode=? AND status='active'`).get(code);
    if(!s) throw new Error('sku not found');
    return {source:'barcode', sku_id: s.id, sku_name:s.name, refundable:s.deposit_cents, carbon:s.carbon_saving||0, water:s.water_saving||0};
  }

  let info;
  try { info = getSkuRef(); } catch(e){ return res.status(400).json({error:e.message}); }
  if(info.refundable<=0) return res.status(400).json({error:'no deposit'});

  if(decision==='reject'){
    const rxId = uuidv4();
    db.prepare(`INSERT INTO rx(id,user_id,source,code,sku_id,refundable_cents,status) VALUES(?,?,?,?,?,?,?)`)
      .run(rxId, user?.id || '__guest__', info.source, code, info.sku_id, 0, 'rejected');
    return res.json({ rx_id: rxId, status:'rejected' });
  }

  const rxId = uuidv4();
  const txn = db.transaction(()=>{
    const rxUserId = user?.id || '__guest__';
    db.prepare(`INSERT INTO rx(id,user_id,source,code,sku_id,refundable_cents,carbon_credit,water_credit,status)
                VALUES(?,?,?,?,?,?,?,?, 'accepted')`)
      .run(rxId, rxUserId, info.source, code, info.sku_id, info.refundable, info.carbon*0.8, info.water*0.8);
    if(user){
      db.prepare(`UPDATE users SET deposit_balance_cents = deposit_balance_cents + ? WHERE id=?`)
        .run(info.refundable, user.id);
    }
    if(info.source==='receipt'){
      db.prepare(`UPDATE tx_item SET refunded_qty = refunded_qty + 1 WHERE id=?`).run(info.tx_item_id);
    }
  });
  try { txn(); } catch(e){ return res.status(500).json({error:e.message}); }

  const balance = user ? db.prepare(`SELECT deposit_balance_cents FROM users WHERE id=?`).get(user.id).deposit_balance_cents : null;
  res.json({
    rx_id: rxId,
    status: 'accepted',
    refunded_cents: info.refundable,
    member_balance_cents: balance,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`VM server on http://localhost:${PORT}`));
