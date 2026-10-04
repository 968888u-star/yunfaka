export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  const url = new URL(request.url);
  const orderNo = url.searchParams.get('order');
  if (!orderNo) return Response.json({ ok: false, msg: '缺少订单号' }, { headers: corsHeaders });

  const raw = await env.YUNFAKA_KV.get('state');
  if (!raw) return Response.json({ ok: false, msg: '无数据' }, { headers: corsHeaders });
  const state = JSON.parse(raw);
  if (!state.db) return Response.json({ ok: false, msg: '无数据' }, { headers: corsHeaders });

  /* ⭐ 先查商品订单，再查会员充值 */
  const order = state.db.orders.find(o => o.order_no === orderNo);
  const recharge = !order ? state.db.recharges.find(r => r.id === orderNo) : null;

  if (!order && !recharge) return Response.json({ ok: false, msg: '订单不存在' }, { headers: corsHeaders });

  const cfg = state.db.config || {};
  const usdtAddress = cfg.pay_usdt_address;
  const rate = Number(cfg.pay_usdt_rate) || 7.2;
  if (!usdtAddress) return Response.json({ ok: false, msg: '未配置 USDT 收款地址' }, { headers: corsHeaders });

  /* 已处理过的直接返回 */
  if (order && order.status !== 'pending') return Response.json({ ok: true, status: order.status }, { headers: corsHeaders });
  if (recharge && recharge.status === 'success') return Response.json({ ok: true, status: 'success' }, { headers: corsHeaders });

  const payMethod = order ? order.pay_method : recharge.method;
  if (payMethod !== 'usdt') return Response.json({ ok: false, msg: '非 USDT 订单' }, { headers: corsHeaders });

  const amountDue = order ? order.amount_due : recharge.amount;
  const expectedUsdt = amountDue / 100 / rate;
  const minAmount = expectedUsdt * 0.99;
  const maxAmount = expectedUsdt * 1.01;
  const createdAt = order ? order.created_at : recharge.created_at;
  const orderTime = new Date(createdAt.replace(' ', 'T')).getTime();

  try {
    const headers = { 'Accept': 'application/json' };
    if (env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = env.TRONGRID_API_KEY;
    const res = await fetch(
      `https://api.trongrid.io/v1/accounts/${usdtAddress}/transactions/trc20?limit=30&only_to=true`,
      { headers }
    );
    if (!res.ok) throw new Error('TronGrid 请求失败 ' + res.status);
    const data = await res.json();
    const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    const nowStr = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

    /* ⭐ 收集已使用的tx（防重复匹配） */
    const usedTxs = new Set();
    (state.db.orders || []).forEach(o => { if (o.pay_tx) usedTxs.add(o.pay_tx); });
    (state.db.recharges || []).forEach(r => { if (r.pay_tx) usedTxs.add(r.pay_tx); });
    for (const tx of (data.data || [])) {
      if (tx.type !== 'Transfer') continue;
      if (!tx.token_info || tx.token_info.address !== USDT_CONTRACT) continue;
      if (tx.to !== usdtAddress) continue;
      if (usedTxs.has(tx.transaction_id)) continue;  /* ⭐ 已被其他订单使用，跳过 */
      const txTime = tx.block_timestamp;
      if (txTime < orderTime - 5 * 60 * 1000) continue;
      if (txTime > orderTime + 24 * 60 * 60 * 1000) continue;
      const amount = Number(tx.value) / Math.pow(10, tx.token_info.decimals || 6);
      if (amount < minAmount || amount > maxAmount) continue;

      /* ⭐ 匹配到账 */
      if (order) {
        /* 商品订单：分配卡并发货 */
        const available = state.db.cards.filter(c => c.product_id === order.product_id && c.status === 'unused');
        if (available.length >= order.quantity) {
          available.slice(0, order.quantity).forEach(c => {
            c.status = 'used'; c.order_no = order.order_no; c.used_at = nowStr(); order.cards.push(c.content);
          });
          order.status = 'delivered'; order.delivered_at = nowStr();
        } else {
          order.status = 'out_of_stock';
        }
        order.pay_tx = tx.transaction_id; order.paid_at = nowStr(); order.paid_amount_usdt = amount;
      } else if (recharge) {
        /* ⭐ 会员充值：加余额 + 赠送 */
        const m = (state.db.members || []).find(x => x.username === recharge.username);
        if (m) {
          m.balance = (m.balance || 0) + recharge.amount;
          const bonusPct = parseFloat(cfg.recharge_bonus_pct || 0);
          if (bonusPct > 0) {
            const bonus = Math.round(recharge.amount * bonusPct / 100);
            if (bonus > 0) { m.balance += bonus; recharge.bonus_amount = bonus; }
          }
        }
        recharge.status = 'success'; recharge.completed_at = nowStr();
        recharge.pay_tx = tx.transaction_id; recharge.paid_amount_usdt = amount;
      }
      state.rev++;
      await env.YUNFAKA_KV.put('state', JSON.stringify(state));
      return Response.json({ ok: true, status: order ? order.status : 'success', auto: true, tx: tx.transaction_id, amount }, { headers: corsHeaders });
    }
    return Response.json({ ok: true, status: 'pending', msg: '暂未检测到匹配的转账' }, { headers: corsHeaders });
  } catch (e) {
    return Response.json({ ok: false, msg: e.message }, { headers: corsHeaders });
  }
}
