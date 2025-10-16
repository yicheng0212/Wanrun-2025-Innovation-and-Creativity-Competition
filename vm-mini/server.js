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

app.get('/api/health', (_,res)=>res.json({ok:true}));

// 取得所有可販售的 SKU，提供給前台商品列表使用
app.get('/api/sku', (req,res)=>{
  const rows = db.prepare(`
    SELECT id,name,category,barcode,price_cents,deposit_cents,lane_no,stock,status,
           carbon_saving,water_saving
    FROM sku WHERE status='active' ORDER BY lane_no ASC
  `).all();
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
  const rows = db.prepare(`SELECT * FROM sku WHERE id IN (${qs})`).all(...ids);
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

  let newStatus = status==='success' ? 'paid' : 'canceled';
  db.prepare(`UPDATE tx SET status=? WHERE id=?`).run(newStatus, tx_id);
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

// 工具：安全扣庫存（避免負數）
function decStock(skuId, qty=1){
  const row = db.prepare(`SELECT stock FROM sku WHERE id=?`).get(skuId);
  if(!row || row.stock<=0) return false;
  db.prepare(`UPDATE sku SET stock=stock-? WHERE id=? AND stock>=?`).run(qty, skuId, qty);
  return true;
}

// 出貨嘗試（回傳 {ok, reason}）
function attemptDispense(sku){
  // 規則：第一次 80% 成功，若失敗 50% jam / 50% empty；可再試 2 次
  const r = Math.random();
  if (sku.stock <= 0) return { ok:false, reason:'empty' };
  if (r < 0.8) {
    // 扣庫存
    if (decStock(sku.id, 1)){
      sku.stock = Math.max(0, (sku.stock||0) - 1); // 同步快取資料
      return { ok:true };
    }
    return { ok:false, reason:'empty' };
  }
  return { ok:false, reason: (Math.random()<0.5?'jam':'empty') };
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

// --- 逐品項出貨 + 部分退款 ---（一次針對某筆交易觸發出貨模擬）
app.post('/api/dispense/:tx_id', (req,res)=>{
  const { tx_id } = req.params;
  const bundle = getTxFull(tx_id);
  if(!bundle) return res.status(404).json({error:'tx not found'});
  const { tx, items } = bundle;

  if (tx.status !== 'paid') {
    return res.status(400).json({error:`tx status must be 'paid', got ${tx.status}`});
  }

  const logInsert = db.prepare(`INSERT INTO dispense_log
    (id,tx_id,sku_id,lane_no,attempt_no,result,message)
    VALUES (?,?,?,?,?,?,?)`);

  const skuRows = db.prepare(`SELECT * FROM sku WHERE id IN (${items.map(()=>'?').join(',')})`).all(...items.map(i=>i.sku_id));
  const skuMap = new Map(skuRows.map(s=>[s.id,s]));

  let refundCents = 0;
  const resultPerItem = [];

  const txn = db.transaction(()=>{
    // 設為 dispensing
    db.prepare(`UPDATE tx SET status='dispensing' WHERE id=?`).run(tx_id);

    for (const it of items){
      let successCount = 0, failCount = 0;
      const unitTotal = it.unit_price_cents + it.deposit_cents;

      for (let q=0; q<it.qty; q++){
        let ok = false, finalReason = 'error';
        for (let attempt=1; attempt<=3; attempt++){
          const sku = skuMap.get(it.sku_id);
          const r = attemptDispense(sku); // 內含扣庫存動作
          logInsert.run(uuidv4(), tx_id, it.sku_id, sku.lane_no, attempt, r.ok?'success':r.reason, null);
          if (r.ok){
            ok = true; successCount++; break;
          } else {
            finalReason = r.reason;
          }
        }
        if (!ok){ failCount++; refundCents += unitTotal; }
      }
      resultPerItem.push({
        sku_id: it.sku_id,
        name: it.sku_name,
        success: successCount,
        failed: failCount,
        refund_each_cents: unitTotal
      });
    }

    // 更新交易狀態與退款金額
    const newStatus = (refundCents>0) ? 'done' : 'done';
    db.prepare(`UPDATE tx SET status=?, tx_refund_cents=? WHERE id=?`)
      .run(newStatus, refundCents, tx_id);
  });

  try { txn(); } catch(e){ return res.status(500).json({error:e.message}); }

  res.json({
    tx_id,
    status: refundCents>0 ? 'done' : 'done',
    refund_cents: refundCents,
    items: resultPerItem
  });
});

// 讀取出貨日誌（提供給前端顯示進度）
app.get('/api/dispense/:tx_id', (req,res)=>{
  const rows = db.prepare(`SELECT * FROM dispense_log WHERE tx_id=? ORDER BY ts ASC, attempt_no ASC`).all(req.params.tx_id);
  const tx = db.prepare(`SELECT id,status,total_cents,deposit_total_cents,tx_refund_cents FROM tx WHERE id=?`).get(req.params.tx_id);
  res.json({ tx, logs: rows });
});


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
  return db.prepare(`
    SELECT COUNT(*) AS c FROM rx
    WHERE user_id=? AND sku_id=? AND date(created_at,'localtime')=date('now','localtime') AND status='accepted'
  `).get(user_id, sku_id).c || 0;
}

app.post('/api/recycle/precheck', (req,res)=>{
  const { mem_no, code } = req.body || {};
  if(!mem_no || !code) return res.status(400).json({error:'mem_no & code required'});
  const user = findUserByMem(mem_no);
  if(!user) return res.status(404).json({error:'member not found'});

  let sku=null, source='barcode', refundable=0, warn=null;

  if(code.includes('|')) {
    // 收據碼: tx|sku|idx
    source='receipt';
    const [tx_id, sku_id] = code.split('|');
    const item = db.prepare(`SELECT ti.*, s.name AS sku_name, s.deposit_cents, s.carbon_saving, s.water_saving
                             FROM tx_item ti JOIN sku s ON s.id=ti.sku_id
                             WHERE ti.tx_id=? AND ti.sku_id=?`).get(tx_id, sku_id);
    if(!item) return res.status(404).json({error:'receipt not match'});
    if(item.refunded_qty >= item.qty) return res.status(400).json({error:'already fully refunded'});
    sku = item; refundable = item.deposit_cents;
  } else {
    // 產品條碼或 SKU ID
    sku = findSku(code);
    if(!sku) return res.status(404).json({error:'sku not found'});
    refundable = sku.deposit_cents;
  }

  if(refundable<=0) return res.status(400).json({error:'this item has no deposit'});

  const daily = todayCountByUserSku(user.id, sku.sku_id || sku.id);
  const LIMIT = 5;
  if(daily >= LIMIT) warn = `今日同品已達上限 ${LIMIT} 件，可能被拒收`;

  res.json({
    ok:true,
    source,
    sku_id: sku.sku_id || sku.id,
    sku_name: sku.sku_name || sku.name,
    refundable_cents: refundable,
    carbon_credit: +( (sku.carbon_saving||0) * 0.8 ).toFixed(3), // 回收給 80% ESG 加分
    water_credit: +( (sku.water_saving||0) * 0.8 ).toFixed(1),
    warn
  });
});

app.post('/api/recycle/confirm', (req,res)=>{
  const { mem_no, code, decision='accept' } = req.body || {};
  if(!mem_no || !code) return res.status(400).json({error:'mem_no & code required'});
  const user = findUserByMem(mem_no);
  if(!user) return res.status(404).json({error:'member not found'});

  // 先做 precheck 邏輯，取得 sku 與 refundable
  function getSkuRef(){
    if(code.includes('|')){
      const [tx_id, sku_id] = code.split('|');
      const item = db.prepare(`SELECT ti.*, s.name AS sku_name, s.deposit_cents, s.carbon_saving, s.water_saving
                               FROM tx_item ti JOIN sku s ON s.id=ti.sku_id
                               WHERE ti.tx_id=? AND ti.sku_id=?`).get(tx_id, sku_id);
      if(!item) throw new Error('receipt not match');
      return {source:'receipt', sku_id: sku_id, sku_name:item.sku_name, refundable:item.deposit_cents, carbon:item.carbon_saving||0, water:item.water_saving||0, tx_item_id:item.id, tx_id};
    } else {
      const s = findSku(code);
      if(!s) throw new Error('sku not found');
      return {source:'barcode', sku_id: s.id, sku_name:s.name, refundable:s.deposit_cents, carbon:s.carbon_saving||0, water:s.water_saving||0};
    }
  }

  let info;
  try { info = getSkuRef(); } catch(e){ return res.status(400).json({error:e.message}); }
  if(info.refundable<=0) return res.status(400).json({error:'no deposit'});

  if(decision==='reject'){
    // 記一筆拒收（可選）
    const rxId = require('uuid').v4();
    db.prepare(`INSERT INTO rx(id,user_id,source,code,sku_id,refundable_cents,status) VALUES(?,?,?,?,?,?,?)`)
      .run(rxId, user.id, info.source, code, info.sku_id, 0, 'rejected');
    return res.json({ rx_id: rxId, status:'rejected' });
  }

  // 受理：寫 rx、加錢到會員押金餘額、收據碼模式下遞增 refunded_qty
  const rxId = require('uuid').v4();
  const txn = db.transaction(()=>{
    db.prepare(`INSERT INTO rx(id,user_id,source,code,sku_id,refundable_cents,carbon_credit,water_credit,status)
                VALUES(?,?,?,?,?,?,?,?, 'accepted')`)
      .run(rxId, user.id, info.source, code, info.sku_id, info.refundable, info.carbon*0.8, info.water*0.8);
    db.prepare(`UPDATE users SET deposit_balance_cents = deposit_balance_cents + ? WHERE id=?`)
      .run(info.refundable, user.id);
    if(info.source==='receipt'){
      db.prepare(`UPDATE tx_item SET refunded_qty = refunded_qty + 1 WHERE id=?`).run(info.tx_item_id);
    }
  });
  try { txn(); } catch(e){ return res.status(500).json({error:e.message}); }

  res.json({
    rx_id: rxId,
    status: 'accepted',
    refunded_cents: info.refundable,
    member_balance_cents: (db.prepare(`SELECT deposit_balance_cents FROM users WHERE id=?`).get(user.id).deposit_balance_cents),
  });
});





const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`VM server on http://localhost:${PORT}`));
