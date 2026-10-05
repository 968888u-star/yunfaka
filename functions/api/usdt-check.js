// functions/api/usdt-check.js · USDT(TRC20) 到账检测 · 最终修复版
export async function onRequest(context) {
  const { request, env } = context;
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const url = new URL(request.url);
  const orderNo = url.searchParams.get('order');
  if (!orderNo) return Response.json({ ok:false, msg:'缺少订单号' }, { headers: cors });

  const raw = await env.YUNFAKA_KV.get('state');
  if (!raw) return Response.json({ ok:false, msg:'无数据' }, { headers: cors });
  const state = JSON.parse(raw);
  if (!state.db) return Response.json({ ok:false, msg:'无数据' }, { headers: cors });

  const order = state.db.orders.find(o => o.order_no === orderNo);
  const recharge = !order ? state.db.recharges.find(r => r.id === orderNo) : null;
  if (!order && !recharge) return Response.json({ ok:false, msg:'订单不存在' }, { headers: cors });

  /* 已终态直接返回 */
  if (order && order.status !== 'pending')
    return Response.json({ ok:true, status: order.status }, { headers: cors });
  if (recharge && recharge.status === 'success')
    return Response.json({ ok:true, status: 'success' }, { headers: cors });

  const cfg = state.db.config || {};
  const usdtAddress = cfg.pay_usdt_address;
  if (!usdtAddress) return Response.json({ ok:false, msg:'未配置收款地址' }, { headers: cors });

  const payMethod = order ? order.pay_method : recharge.method;
  if (payMethod !== 'usdt') return Response.json({ ok:false, msg:'非 USDT 订单' }, { headers: cors });

  /* ⭐ B5：余额已抵扣完的订单无需 USDT 检测 */
  const amountDue = order ? (order.amount_due || 0) : (recharge.amount || 0);
  if (amountDue <= 0) return Response.json({ ok:true, status:'pending', msg:'无需支付' }, { headers: cors });

  /* ⭐ B1：优先使用订单快照汇率 */
  const rate = Number(order && order.usdt_rate)
            || Number(recharge && recharge.usdt_rate)
            || Number(cfg.pay_usdt_rate)
            || 7.2;
  const expectedUsdt = amountDue / 100 / rate;
  const minAmount = expectedUsdt * 0.98;
  const maxAmount = expectedUsdt * 1.02;

  /* ⭐ B3：容错解析 created_at，失败则用 (现在 - 48h) 兜底 */
  function parseTime(s){
    if (!s) return NaN;
    s = String(s);
    // 尝试三种：带 Z、不带 Z、原样
    let t = Date.parse(s.replace(' ', 'T') + 'Z');
    if (isNaN(t)) t = Date.parse(s.replace(' ', 'T'));
    if (isNaN(t)) t = Date.parse(s);
    return t;
  }
  let orderTime = parseTime(order ? order.created_at : recharge.created_at);
  if (isNaN(orderTime)) orderTime = Date.now() - 48 * 3600 * 1000;

  const nowStr = () => new Date().toISOString().slice(0,19).replace('T',' ');

  try {
    const headers = { 'Accept': 'application/json' };
    if (env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = env.TRONGRID_API_KEY;

    const res = await fetch(
      `https://api.trongrid.io/v1/accounts/${usdtAddress}/transactions/trc20?limit=50&only_to=true`,
      { headers }
    );
    if (!res.ok) throw new Error('TronGrid ' + res.status);
    const data = await res.json();
    const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

    const collectUsed = (s) => {
      const set = new Set();
      (s.db.orders || []).forEach(o => o.pay_tx && set.add(o.pay_tx));
      (s.db.recharges || []).forEach(r => r.pay_tx && set.add(r.pay_tx));
      return set;
    };

    for (const tx of (data.data || [])) {
      if (tx.type !== 'Transfer') continue;
      if (!tx.token_info || tx.token_info.address !== USDT) continue;
      if (tx.to !== usdtAddress) continue;
      const txTime = tx.block_timestamp;
      if (txTime < orderTime - 30 * 60 * 1000) continue;       // 下单前 30 分钟
      if (txTime > orderTime + 48 * 3600 * 1000) continue;     // 下单后 48 小时
      const amount = Number(tx.value) / Math.pow(10, tx.token_info.decimals || 6);
      if (amount < minAmount || amount > maxAmount) continue;

      /* double-check：重新读 KV */
      const raw2 = await env.YUNFAKA_KV.get('state');
      const s2 = raw2 ? JSON.parse(raw2) : state;
      if (collectUsed(s2).has(tx.transaction_id)) continue;

      const o2 = order ? s2.db.orders.find(o => o.order_no === orderNo) : null;
      const r2 = !o2 ? s2.db.recharges.find(r => r.id === orderNo) : null;
      if (!o2 && !r2) continue;
      if (o2 && o2.status !== 'pending')
        return Response.json({ ok:true, status:o2.status, auto:true }, { headers: cors });
      if (r2 && r2.status === 'success')
        return Response.json({ ok:true, status:'success', auto:true }, { headers: cors });

      /* ========== 执行自动交付 ========== */
      if (o2) {
        /* ⭐ B4：防御 cards 未初始化 */
        if (!Array.isArray(o2.cards)) o2.cards = [];
        o2.pay_tx = tx.transaction_id;
        o2.paid_at = nowStr();
        o2.paid_amount_usdt = amount;

        if (o2.source === 'smm') {
          try {
            const key = env.CHINAYINLIU_API_KEY || '';
            if (key && o2.smm_service_id && o2.smm_link) {
              const sp = new URLSearchParams();
              sp.append('key', key); sp.append('action', 'add');
              sp.append('service', o2.smm_service_id);
              sp.append('link', o2.smm_link);
              sp.append('quantity', o2.quantity || 1);
              const sr = await fetch('https://chinayinliu.com/api/v2', {
                method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
                body: sp.toString()
              });
              const sd = await sr.json();
              if (sd && sd.order) {
                o2.smm_order_id = String(sd.order);
                o2.status = 'processing';
                o2.submitted_at = nowStr();
              } else {
                o2.status = 'pending_review';
                o2.auto_submit_error = String((sd && (sd.error||sd.msg))||'上游下单失败').slice(0,100);
              }
            } else {
              o2.status = 'pending_review';
              o2.auto_submit_error = '未配置上游API或缺少参数';
            }
          } catch(e){
            o2.status = 'pending_review';
            o2.auto_submit_error = String(e.message).slice(0,100);
          }
        } else if (o2.source === 'luban') {
          try {
            const lbKey = env.LUBAN_APIKEY || '';
            if (lbKey && o2.luban_type === 'sms' && o2.luban_service_id) {
              const lr = await fetch(`https://lubansms.com/v2/api/getNumber?apikey=${lbKey}&service_id=${encodeURIComponent(o2.luban_service_id)}`);
              const ld = await lr.json();
              if (ld && ld.code === 0 && ld.data) {
                o2.luban_request_id = ld.data.request_id || ld.data.id || '';
                o2.luban_phone = ld.data.phone_number || ld.data.phone || '';
                o2.status = 'processing';
                o2.submitted_at = nowStr();
              } else {
                o2.status = 'pending_review';
                o2.auto_submit_error = String((ld && ld.msg)||'上游取号失败').slice(0,100);
              }
            } else {
              o2.status = 'pending_review';
              o2.auto_submit_error = '通用接码需人工处理或未配置API';
            }
          } catch(e){
            o2.status = 'pending_review';
            o2.auto_submit_error = String(e.message).slice(0,100);
          }
        } else {
          /* 卡密商品：扣卡 */
          const avail = s2.db.cards.filter(c =>
            c.product_id === o2.product_id &&
            c.status === 'unused' &&
            String(c.sku_id||0) === String(o2.sku_id||0)
          );
          if (avail.length >= o2.quantity) {
            avail.slice(0, o2.quantity).forEach(c => {
              c.status = 'used'; c.order_no = o2.order_no;
              c.used_at = nowStr(); o2.cards.push(c.content);
            });
            o2.status = 'delivered'; o2.delivered_at = nowStr();
          } else if (avail.length === 0) {
            /* 无卡密商品（虚拟直发） */
            o2.status = 'delivered'; o2.delivered_at = nowStr();
            o2.cards = ['虚拟商品·自动发货（无需卡密）'];
          } else {
            o2.status = 'out_of_stock';
          }
        }
      } else if (r2) {
        const m = (s2.db.members || []).find(x => x.username === r2.username);
        if (m) {
          m.balance = (m.balance || 0) + r2.amount;
          const bp = parseFloat(cfg.recharge_bonus_pct || 0);
          if (bp > 0) {
            const b = Math.round(r2.amount * bp / 100);
            if (b > 0) { m.balance += b; r2.bonus_amount = b; }
          }
        }
        r2.status = 'success';
        r2.completed_at = nowStr();
        r2.pay_tx = tx.transaction_id;
        r2.paid_amount_usdt = amount;
      }

      s2.rev = (s2.rev || 0) + 1;
      await env.YUNFAKA_KV.put('state', JSON.stringify(s2));

      /* ⭐ B7：异步通知店主（不阻塞响应） */
      const cfgTg = cfg;
      if (cfgTg.tg_bot_token && cfgTg.tg_chat_id) {
        const tag = o2 ? '✅ USDT 到账·自动发货' : '💰 USDT 到账·充值';
        const detail = o2
          ? `\n订单：${o2.order_no}\n商品：${o2.product_name}\n状态：${o2.status}${o2.auto_submit_error?'\n⚠️ '+o2.auto_submit_error:''}`
          : `\n充值：${r2.id}\n会员：${r2.username}\n金额：¥${(r2.amount/100).toFixed(2)}`;
        context.waitUntil(
          fetch(`https://api.telegram.org/bot${cfgTg.tg_bot_token}/sendMessage`, {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({
              chat_id: cfgTg.tg_chat_id,
              text: `${tag}\n${detail}\nUSDT：${amount}\ntx：${tx.transaction_id}`,
              parse_mode: 'HTML'
            })
          }).catch(()=>{})
        );
      }

      return Response.json({
        ok: true,
        status: o2 ? o2.status : 'success',
        auto: true,
        tx: tx.transaction_id,
        amount
      }, { headers: cors });
    }

    return Response.json({ ok:true, status:'pending', msg:'暂未检测到匹配转账' }, { headers: cors });
  } catch(e) {
    return Response.json({ ok:false, msg: e.message }, { headers: cors });
  }
}
