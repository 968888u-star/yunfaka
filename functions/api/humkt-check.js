import { optionsResponse, jsonError, jsonOk, rateLimit, getClientIp } from '../_lib/common.js';
export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return optionsResponse(request, env);
  const rl = await rateLimit(env.YUNFAKA_KV, 'humktchk:' + getClientIp(request), 20, 60000);
  if (rl.blocked) return jsonError('请求过于频繁', 429, env, request);
  const url = new URL(request.url);
  const orderNo = url.searchParams.get('order');
  if (!orderNo) return jsonError('缺少订单号', 400, env, request);
  try {
    const token = env.HUMKT_TOKEN;
    if (!token) return jsonError('未配置 HUMKT_TOKEN', 400, env, request);
    const raw = await env.YUNFAKA_KV.get('state');
    if (!raw) return jsonError('无数据', 404, env, request);
    const state = JSON.parse(raw);
    const order = (state.db.orders || []).find(o => o.order_no === orderNo);
    if (!order) return jsonError('订单不存在', 404, env, request);
    if (!order.humkt_trx) return jsonError('该订单未在 humkt 下过单', 400, env, request);
    const now = Date.now();
    if (order.humkt_last_check && now - order.humkt_last_check < 15000 && order.humkt_status !== 'shipped') return jsonOk({ ok: true, status: order.humkt_status || 'processing', cached: true }, env, request);
    if (order.humkt_status === 'shipped' || order.humkt_status === 'refunded') return jsonOk({ ok: true, status: order.humkt_status, items: order.humkt_items || [], cached: true }, env, request);
    const res = await fetch('https://www.humkt.com/api/v1/orders/' + encodeURIComponent(order.humkt_trx), { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' } });
    const data = await res.json();
    order.humkt_last_check = now;
    if (data.code !== 1) { await env.YUNFAKA_KV.put('state', JSON.stringify(state)); return jsonError(data.message || 'humkt 查询失败', 400, env, request); }
    const d = data.data;
    order.humkt_status = d.status; order.humkt_status_label = d.status_label;
    if (d.status === 'shipped' && d.items && d.items.length) {
      order.humkt_items = d.items; order.cards = d.items.slice(0, order.quantity);
      order.status = 'delivered'; order.delivered_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
    } else if (d.status === 'partial') { order.cards = d.items || []; order.status = 'partial'; }
    else if (d.status === 'refunded') { order.status = 'rejected'; order.humkt_refunded = true; }
    state.rev = (state.rev || 0) + 1;
    await env.YUNFAKA_KV.put('state', JSON.stringify(state));
    return jsonOk({ ok: true, status: d.status, status_label: d.status_label, items: d.items || [], delivered: d.delivered, refunded_qty: d.refunded_qty }, env, request);
  } catch (e) { return jsonError('操作失败，请稍后重试', 500, env, request, e); }
}
