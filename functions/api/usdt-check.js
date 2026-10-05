// functions/api/usdt-check.js · USDT(TRC20) 到账检测（竞态修复版）
// 修复：
//   1. 匹配成功前 double-check（重新读 KV 确认 tx 未被占用），防止并发重复匹配
//   2. 匹配后立即写回 KV，缩短竞态窗口
//   3. 查询最近 50 笔（原 30），时间窗口放宽到订单前后 30 分钟~48 小时
export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

  const url = new URL(request.url);
  const orderNo = url.searchParams.get('order');
  if (!orderNo) return Response.json({ ok: false, msg: '缺少订单号' }, { headers: corsHeaders });

  const raw = await env.YUNFAKA_KV.get('state');
  if (!raw) return Response.json({ ok: false, msg: '无数据' }, { headers: corsHeaders });
  let state = JSON.parse(raw);
  if (!state.db) return Response.json({ ok: false, msg: '无数据' }, { headers: corsHeaders });

  const order = state.db.orders.find(o => o.order_no === orderNo);
  const recharge = !order ? state.db.recharges.find(r => r.id === orderNo) : null;
  if (!order && !recharge) return Response.json({ ok: false, msg: '订单不存在' }, { headers: corsHeaders });

  const cfg = state.db.config || {};
  const usdtAddress = cfg.pay_usdt_address;
  const rate = Number(cfg.pay_usdt_rate) || 7.2;
  if (!usdtAddress) return Response.json({ ok: false, msg: '未配置 USDT 收款地址' }, { headers: corsHeaders });

  if (order && order.status !== 'pending') return Response.json({ ok: true, status: order.status }, { headers: corsHeaders });
  if (recharge && recharge.status === 'success') return Response.json({ ok: true, status: 'success' }, { headers: corsHeaders });

  const payMethod = order ? order.pay_method : recharge.method;
  if (payMethod !== 'usdt') return Response.json({ ok: false, msg: '非 USDT 订单' }, { headers: corsHeaders });

  const amountDue = order ? order.amount_due : recharge.amount;
  const expectedUsdt = amountDue / 100 / rate;
  const minAmount = expectedUsdt * 0.98;   // 放宽到 ±2%
  const maxAmount = expectedUsdt * 1.02;
  const createdAt = order ? order.created_at : recharge.created_at;
  const orderTime = new Date(createdAt.replace(' ', 'T')).getTime();
  const nowStr = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

  try {
    const headers = { 'Accept': 'application/json' };
    if (env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = env.TRONGRID_API_KEY;
    const res = await fetch(
      `https://api.trongrid.io/v1/accounts/${usdtAddress}/transactions/trc20?limit=50&only_to=true`,
      { headers }
    );
    if (!res.ok) throw new Error('TronGrid 请求失败 ' + res.status);
    const data = await res.json();
    const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

    const collectUsedTxs = (s) => {
      const set = new Set();
      ((s.db.orders) || []).forEach(o => { if (o.pay_tx) set.add(o.pay_tx); });
      ((s.db.recharges) || []).forEach(r => { if (r.pay_tx) set.add(r.pay_tx); });
      return set;
    };

    for (const tx of (data.data || [])) {
      if (tx.type !== 'Transfer') continue;
      if (!tx.token_info || tx.token_info.address !== USDT_CONTRACT) continue;
      if (tx.to !== usdtAddress) continue;
      const txTime = tx.block_timestamp;
      if (txTime < orderTime - 30 * 60 * 1000) continue;       // 下单前30分钟内的也接受（客户先转后下单）
      if (txTime > orderTime + 48 * 60 * 60 * 1000) continue;  // 48小时窗口
      const amount = Number(tx.value) / Math.pow(10, tx.token_info.decimals || 6);
      if (amount < minAmount || amount > maxAmount) continue;

      // ⭐ double-check：写入前重新读取最新 state，再次确认该 tx 未被其他并发请求占用
      const raw2 = await env.YUNFAKA_KV.get('state');
      const state2 = raw2 ? JSON.parse(raw2) : state;
      const usedTxs = collectUsedTxs(state2);
      if (usedTxs.has(tx.transaction_id)) continue;

      // 在 state2（最新）上操作，避免覆盖他人更新
      const order2 = order ? state2.db.orders.find(o => o.order_no === orderNo) : null;
      const recharge2 = !order2 ? state2.db.recharges.find(r => r.id === orderNo) : null;
      if (!order2 && !recharge2) continue;
      if (order2 && order2.status !== 'pending') {
        return Response.json({ ok: true, status: order2.status }, { headers: corsHeaders });
      }
      if (recharge2 && recharge2.status === 'success') {
        return Response.json({ ok: true, status: 'success' }, { headers: corsHeaders });
      }

      if (order2) {
        order2.pay_tx = tx.transaction_id; order2.paid_at = nowStr(); order2.paid_amount_usdt = amount;
        if (order2.source === 'smm') {
          // ⭐ SMM推广：支付成功后自动提交上游下单
          try {
            const smmKey = env.CHINAYINLIU_API_KEY || '';
            if (smmKey && order2.smm_service_id && order2.smm_link) {
              const sp = new URLSearchParams();
              sp.append('key', smmKey); sp.append('action', 'add');
              sp.append('service', order2.smm_service_id);
              sp.append('link', order2.smm_link);
              sp.append('quantity', order2.quantity || 1);
              const sr = await fetch('https://chinayinliu.com/api/v2', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: sp.toString() });
              const sd = await sr.json();
              if (sd && sd.order) { order2.smm_order_id = String(sd.order); order2.status = 'processing'; order2.submitted_at = nowStr(); }
              else { order2.status = 'pending_review'; order2.auto_submit_error = (sd && (sd.error || sd.msg)) ? String(sd.error||sd.msg).slice(0,100) : '上游下单失败'; }
            } else { order2.status = 'pending_review'; order2.auto_submit_error = '未配置上游API或缺少下单参数'; }
          } catch(e) { order2.status = 'pending_review'; order2.auto_submit_error = String(e.message).slice(0,100); }
        } else if (order2.source === 'luban') {
          // ⭐ Luban接码：支付成功后自动请求号码
          try {
            const lbKey = env.LUBAN_APIKEY || '';
            if (lbKey && order2.luban_type === 'sms' && order2.luban_service_id) {
              const lr = await fetch(`https://lubansms.com/v2/api/getNumber?apikey=${lbKey}&service_id=${encodeURIComponent(order2.luban_service_id)}`);
              const ld = await lr.json();
              if (ld && ld.code === 0 && ld.data) {
                order2.luban_request_id = ld.data.request_id || ld.data.id || '';
                order2.luban_phone = ld.data.phone_number || ld.data.phone || '';
                order2.status = 'processing'; order2.submitted_at = nowStr();
              } else { order2.status = 'pending_review'; order2.auto_submit_error = (ld && ld.msg) ? String(ld.msg).slice(0,100) : '上游取号失败'; }
            } else { order2.status = 'pending_review'; order2.auto_submit_error = '通用接码需人工处理或未配置API'; }
          } catch(e) { order2.status = 'pending_review'; order2.auto_submit_error = String(e.message).slice(0,100); }
        } else {
          // 普通卡密商品：原逻辑
          const available = state2.db.cards.filter(c => c.product_id === order2.product_id && c.status === 'unused');
          if (available.length >= order2.quantity) {
            available.slice(0, order2.quantity).forEach(c => {
              c.status = 'used'; c.order_no = order2.order_no; c.used_at = nowStr(); order2.cards.push(c.content);
            });
            order2.status = 'delivered'; order2.delivered_at = nowStr();
          } else {
            order2.status = 'out_of_stock';
          }
        }
      } else if (recharge2) {
        const m = (state2.db.members || []).find(x => x.username === recharge2.username);
        if (m) {
          m.balance = (m.balance || 0) + recharge2.amount;
          const bonusPct = parseFloat(cfg.recharge_bonus_pct || 0);
          if (bonusPct > 0) {
            const bonus = Math.round(recharge2.amount * bonusPct / 100);
            if (bonus > 0) { m.balance += bonus; recharge2.bonus_amount = bonus; }
          }
        }
        recharge2.status = 'success'; recharge2.completed_at = nowStr();
        recharge2.pay_tx = tx.transaction_id; recharge2.paid_amount_usdt = amount;
      }

      state2.rev = (state2.rev || 0) + 1;
      await env.YUNFAKA_KV.put('state', JSON.stringify(state2));
      return Response.json({ ok: true, status: order2 ? order2.status : 'success', auto: true, tx: tx.transaction_id, amount }, { headers: corsHeaders });
    }

    return Response.json({ ok: true, status: 'pending', msg: '暂未检测到匹配的转账' }, { headers: corsHeaders });
  } catch (e) {
    return Response.json({ ok: false, msg: e.message }, { headers: corsHeaders });
  }
}
