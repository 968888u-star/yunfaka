// functions/api/usdt-check.js · USDT(TRC20) 到账检测（安全加固版）
// 变更：
//   1. 写入前增加 rev 乐观锁校验（防止并发超发）
//   2. 支持唯一金额尾数精确匹配（订单带 expected_usdt_exact 字段时优先精确匹配）
//   3. CORS 收紧、错误脱敏、调用限流
//   4. 金额匹配窗口从 ±2% 收窄到 ±1%（配合唯一尾数更安全）
import { corsHeaders, optionsResponse, jsonError, jsonOk, rateLimit, getClientIp } from '../_lib/common.js';
import { processOrderLuban } from './luban.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return optionsResponse(request, env);
  if (request.method !== 'GET') return jsonError('Method not allowed', 405, env, request);

  const url = new URL(request.url);
  const orderNo = url.searchParams.get('order');
  if (!orderNo) return jsonError('缺少订单号', 400, env, request);

  // 限流：单订单 10 秒内最多查 3 次，防刷 TronGrid
  const rl = await rateLimit(env.YUNFAKA_KV, 'usdt:' + orderNo, 3, 10000);
  if (rl.blocked) return jsonError('查询过于频繁，请稍后再试', 429, env, request);

  try {
    let needLubanFetch = false;
    const raw = await env.YUNFAKA_KV.get('state');
    if (!raw) return jsonError('无数据', 404, env, request);
    const state = JSON.parse(raw);
    if (!state.db) return jsonError('无数据', 404, env, request);
    const baseRev = state.rev || 0;
    const order = state.db.orders.find(o => o.order_no === orderNo);
    const recharge = !order ? (state.db.recharges || []).find(r => r.id === orderNo) : null;
    if (!order && !recharge) return jsonError('订单不存在', 404, env, request);

    if (order && order.status !== 'pending') return jsonOk({ ok: true, status: order.status }, env, request);
    if (recharge && recharge.status === 'success') return jsonOk({ ok: true, status: 'success' }, env, request);

    const cfg = state.db.config || {};
    const usdtAddress = cfg.pay_usdt_address;
    if (!usdtAddress) return jsonError('未配置收款地址', 400, env, request);
    const payMethod = order ? order.pay_method : recharge.method;
    if (payMethod !== 'usdt') return jsonError('非 USDT 订单', 400, env, request);

    const amountDue = order ? (order.amount_due || 0) : (recharge.amount || 0);
    if (amountDue <= 0) return jsonOk({ ok: true, status: 'pending', msg: '无需支付' }, env, request);

    const rate = Number(order && order.usdt_rate) || Number(recharge && recharge.usdt_rate) || Number(cfg.pay_usdt_rate) || 7.2;
    const expectedUsdt = amountDue / 100 / rate;
    // 唯一金额尾数：如果订单记录了精确应付金额，优先精确匹配（容忍 0.000001 USDT 精度误差）
    const exactExpected = order ? Number(order.expected_usdt_exact) : Number(recharge.expected_usdt_exact);
    const useExact = exactExpected && exactExpected > 0;
    const minAmount = useExact ? exactExpected - 0.000001 : expectedUsdt * 0.99;
    const maxAmount = useExact ? exactExpected + 0.000001 : expectedUsdt * 1.01;

    function parseTime(s) {
      if (!s) return NaN;
      s = String(s);
      let t = Date.parse(s.replace(' ', 'T') + 'Z');
      if (isNaN(t)) t = Date.parse(s.replace(' ', 'T'));
      if (isNaN(t)) t = Date.parse(s);
      return t;
    }
    let orderTime = parseTime(order ? order.created_at : recharge.created_at);
    if (isNaN(orderTime)) orderTime = Date.now() - 48 * 3600 * 1000;
    const nowStr = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

    const headers = { 'Accept': 'application/json' };
    if (env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = env.TRONGRID_API_KEY;
    const res = await fetch(
      `https://api.trongrid.io/v1/accounts/${usdtAddress}/transactions/trc20?limit=50&only_to=true`,
      { headers }
    );
    if (!res.ok) return jsonError('支付网络查询失败，请稍后重试', 502, env, request);
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
      if (txTime < orderTime - 30 * 60 * 1000) continue;
      if (txTime > orderTime + 48 * 3600 * 1000) continue;
      const amount = Number(tx.value) / Math.pow(10, tx.token_info.decimals || 6);
      if (amount < minAmount || amount > maxAmount) continue;

      // double-check + rev 乐观锁
      const raw2 = await env.YUNFAKA_KV.get('state');
      const s2 = raw2 ? JSON.parse(raw2) : state;
      if ((s2.rev || 0) !== baseRev) {
        // 数据已被其他请求更新，重新校验状态
        const o2c = order ? s2.db.orders.find(o => o.order_no === orderNo) : null;
        const r2c = !o2c ? (s2.db.recharges || []).find(r => r.id === orderNo) : null;
        if (o2c && o2c.status !== 'pending') return jsonOk({ ok: true, status: o2c.status, auto: true }, env, request);
        if (r2c && r2c.status === 'success') return jsonOk({ ok: true, status: 'success', auto: true }, env, request);
      }
      if (collectUsed(s2).has(tx.transaction_id)) continue;
      const o2 = order ? s2.db.orders.find(o => o.order_no === orderNo) : null;
      const r2 = !o2 ? (s2.db.recharges || []).find(r => r.id === orderNo) : null;
      if (!o2 && !r2) continue;
      if (o2 && o2.status !== 'pending') return jsonOk({ ok: true, status: o2.status, auto: true }, env, request);
      if (r2 && r2.status === 'success') return jsonOk({ ok: true, status: 'success', auto: true }, env, request);

      if (o2) {
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
              sp.append('service', o2.smm_service_id); sp.append('link', o2.smm_link);
              sp.append('quantity', o2.quantity || 1);
              const sr = await fetch('https://chinayinliu.com/api/v2', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: sp.toString() });
              const sd = await sr.json();
              if (sd && sd.order) { o2.smm_order_id = String(sd.order); o2.status = 'processing'; o2.submitted_at = nowStr(); }
              else { o2.status = 'pending_review'; o2.auto_submit_error = String((sd && (sd.error || sd.msg)) || '上游下单失败').slice(0, 100); }
            } else { o2.status = 'pending_review'; o2.auto_submit_error = '未配置上游API或缺少参数'; }
          } catch (e) { o2.status = 'pending_review'; o2.auto_submit_error = '上游下单异常'; }
        } else if (o2.source === 'luban') {
          // 统一交给 processOrderLuban 异步取号（在 KV 写回后通过 waitUntil 触发，避免并发覆盖）
          // 旧版内联取号只设 luban_phone 缺 luban_number/luban_deadline，导致前端显示"正在分配中"和"0分00秒"
          o2.status = 'processing';
          o2.submitted_at = nowStr();
          needLubanFetch = true;
        } else {
          const avail = s2.db.cards.filter(c => c.product_id === o2.product_id && c.status === 'unused' && String(c.sku_id || 0) === String(o2.sku_id || 0));
          if (avail.length >= o2.quantity) {
            avail.slice(0, o2.quantity).forEach(c => { c.status = 'used'; c.order_no = o2.order_no; c.used_at = nowStr(); o2.cards.push(c.content); });
            o2.status = 'delivered'; o2.delivered_at = nowStr();
          } else if (avail.length === 0) {
            o2.status = 'delivered'; o2.delivered_at = nowStr(); o2.cards = ['虚拟商品·自动发货（无需卡密）'];
          } else {
            o2.status = 'out_of_stock';
          }
        }
      } else if (r2) {
        const m = (s2.db.members || []).find(x => x.username === r2.username);
        if (m) {
          m.balance = (m.balance || 0) + r2.amount;
          const bp = parseFloat(cfg.recharge_bonus_pct || 0);
          if (bp > 0) { const b = Math.round(r2.amount * bp / 100); if (b > 0) { m.balance += b; r2.bonus_amount = b; } }
        }
        r2.status = 'success'; r2.completed_at = nowStr(); r2.pay_tx = tx.transaction_id; r2.paid_amount_usdt = amount;
      }
      s2.rev = (s2.rev || 0) + 1;
      await env.YUNFAKA_KV.put('state', JSON.stringify(s2));

      // 接码订单：KV 写回后异步触发取号（processOrderLuban 内部读最新 KV，字段齐全）
      if (needLubanFetch) {
        context.waitUntil((async () => {
          try { await processOrderLuban(env, orderNo); } catch (e) { console.error('[usdt-check] luban取号异常:', e && e.message); }
        })());
      }

      const cfgTg = cfg;
      if (cfgTg.tg_bot_token && cfgTg.tg_chat_id) {
        const tag = o2 ? 'USDT 到账·自动发货' : 'USDT 到账·充值';
        const detail = o2
          ? `\n订单：${o2.order_no}\n商品：${o2.product_name}\n状态：${o2.status}${o2.auto_submit_error ? '\n注意：' + o2.auto_submit_error : ''}`
          : `\n充值：${r2.id}\n会员：${r2.username}\n金额：¥${(r2.amount / 100).toFixed(2)}`;
        context.waitUntil(
          fetch(`https://api.telegram.org/bot${cfgTg.tg_bot_token}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: cfgTg.tg_chat_id, text: `${tag}${detail}\nUSDT：${amount}\ntx：${tx.transaction_id}`, parse_mode: 'HTML' })
          }).catch(() => {})
        );
      }
      return jsonOk({ ok: true, status: o2 ? o2.status : 'success', auto: true, tx: tx.transaction_id, amount }, env, request);
    }
    return jsonOk({ ok: true, status: 'pending', msg: '暂未检测到匹配转账' }, env, request);
  } catch (e) {
    return jsonError('支付检测异常，请稍后重试', 500, env, request, e);
  }
}
