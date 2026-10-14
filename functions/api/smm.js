// functions/api/smm.js · chinayinliu SMM 代理（安全修复版）
// 安全修复：add/cancel/refill 等扣费/操作类请求必须绑定已支付订单，防止盗刷店主上游余额
import { requireAdmin, requireMember, optionsResponse, jsonError, jsonOk, rateLimit, getClientIp } from '../_lib/common.js';

function json(obj, env, request) {
  return new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': (request.headers.get('Origin') || '*') } });
}

async function findOrder(env, orderNo) {
  try {
    const raw = await env.YUNFAKA_KV.get('state');
    if (!raw) return null;
    const state = JSON.parse(raw);
    return (state.db && state.db.orders || []).find(o => String(o.order_no) === String(orderNo)) || null;
  } catch (e) { return null; }
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return optionsResponse(request, env);
  const API_KEY = env.CHINAYINLIU_API_KEY;
  if (!API_KEY) return json({ ok: false, msg: '后端未配置 CHINAYINLIU_API_KEY' }, env, request);
  const ENDPOINT = 'https://chinayinliu.com/api/v2';

  let body = {};
  try { body = await request.json(); } catch (e) { body = Object.fromEntries(new URL(request.url).searchParams); }
  const action = body.action || '';

  // 只读操作公开
  if (action === 'services' || action === 'balance' || action === 'status') {
    const params = new URLSearchParams();
    params.append('key', API_KEY);
    params.append('action', action);
    if (action === 'status') { if (body.orders) params.append('orders', body.orders); else params.append('order', body.order || ''); }
    try {
      const r = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch (e) { return json({ ok: false, msg: '上游返回非JSON' }, env, request); }
      return json({ ok: true, data }, env, request);
    } catch (e) { return json({ ok: false, msg: '操作失败' }, env, request); }
  }

  // 写操作（add/cancel/refill）必须绑定已支付订单
  const orderNo = body.order_no || '';
  if (!orderNo) return json({ ok: false, msg: '缺少 order_no，SMM 提交必须绑定订单' }, env, request);
  const order = await findOrder(env, orderNo);
  if (!order) return json({ ok: false, msg: '订单不存在' }, env, request);
  if (order.status === 'pending') return json({ ok: false, msg: '订单未支付，无法提交上游' }, env, request);

  // 会员只能操作自己的订单；管理员无限制
  const admin = await requireAdmin(request, env);
  const member = await requireMember(request, env);
  if (!admin && (!member || member.username !== order.username)) {
    return json({ ok: false, msg: '只能操作自己的订单' }, env, request);
  }

  // 限流：单订单写操作 5次/分钟
  const rl = await rateLimit(env.YUNFAKA_KV, 'smmwrite:' + orderNo, 5, 60000);
  if (rl.blocked) return json({ ok: false, msg: '操作过于频繁' }, env, request);

  const params = new URLSearchParams();
  params.append('key', API_KEY);
  if (action === 'add') {
    params.append('action', 'add');
    params.append('service', body.service || order.smm_service_id || '');
    params.append('link', body.link || order.smm_link || '');
    params.append('quantity', body.quantity || order.quantity || '');
    if (body.runs) params.append('runs', body.runs);
    if (body.interval) params.append('interval', body.interval);
  } else if (action === 'refill') {
    params.append('action', 'refill');
    params.append('order', body.order || '');
  } else if (action === 'cancel') {
    params.append('action', 'cancel');
    params.append('orders', body.orders || body.order || '');
  } else {
    return json({ ok: false, msg: 'unknown action' }, env, request);
  }

  try {
    const r = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch (e) { return json({ ok: false, msg: '上游返回非JSON' }, env, request); }
    return json({ ok: true, data }, env, request);
  } catch (e) { return json({ ok: false, msg: '操作失败，请稍后重试' }, env, request); }
}
