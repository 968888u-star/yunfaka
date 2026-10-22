// functions/api/luban.js · LubanSms API 代理（终极后端取号版）
import { requireAdmin, requireMember, optionsResponse, jsonError, jsonOk, rateLimit } from '../_lib/common.js';

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
  const apikey = env.LUBAN_APIKEY;
  if (!apikey) return jsonError('未配置 LUBAN_APIKEY 环境变量', 400, env, request);
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const BASE = 'https://lubansms.com/v2/api/';

  let MARKUP = 1.3, USD_TO_CNY = 7.2;
  try {
    const raw = await env.YUNFAKA_KV.get('state');
    if (raw) { const st = JSON.parse(raw); const cfg = (st.db && st.db.config) || {}; if (cfg.luban_markup) MARKUP = Number(cfg.luban_markup) || 1.3; if (cfg.pay_usdt_rate) USD_TO_CNY = Number(cfg.pay_usdt_rate) || 7.2; }
  } catch (e) {}

  function buildUrl(path, params) {
    const p = new URLSearchParams();
    p.set('apikey', apikey);
    Object.keys(params || {}).forEach(k => { const v = params[k]; if (v !== undefined && v !== null && v !== '') p.set(k, v); });
    return BASE + path + '?' + p.toString();
  }

  // ========== 只读操作（公开） ==========
  if (action === 'balance' || action === 'countries') {
    const pathMap = { balance: 'getBalance', countries: 'countries' };
    try {
      const r = await fetch(buildUrl(pathMap[action], {}));
      const text = await r.text();
      let d; try { d = JSON.parse(text); } catch (e) { return jsonError('上游返回异常', 502, env, request); }
      return jsonOk(d, env, request);
    } catch (e) { return jsonError('上游服务暂不可用', 502, env, request, e); }
  }

  if (action === 'get_sms' || action === 'common_get_sms') {
    const orderNo = url.searchParams.get('order_no') || '';
    if (!orderNo) return jsonError('缺少 order_no', 400, env, request);
    const order = await findOrder(env, orderNo);
    if (!order) return jsonError('订单不存在', 404, env, request);
    if (action === 'get_sms') {
      const requestId = url.searchParams.get('request_id') || order.luban_request_id || '';
      if (!requestId) return jsonError('缺少 request_id', 400, env, request);
      const r = await fetch(buildUrl('getSms', { request_id: requestId }));
      return jsonOk(await r.json(), env, request);
    } else {
      const phone = url.searchParams.get('phone') || order.luban_phone || '';
      const keyword = url.searchParams.get('keyword') || order.luban_keyword || '';
      if (!phone) return jsonError('缺少 phone', 400, env, request);
      const r = await fetch(buildUrl('getKeywordSms', { phone, keyword }));
      return jsonOk(await r.json(), env, request);
    }
  }

  if (action === 'services' || action === 'client_services') {
    const params = { language: url.searchParams.get('language') || 'zh', page: url.searchParams.get('page') || '1' };
    if (url.searchParams.get('countryName')) params.country = url.searchParams.get('countryName');
    if (url.searchParams.get('service')) params.service = url.searchParams.get('service');
    try {
      const r = await fetch(buildUrl('List', params));
      const text = await r.text();
      let d;
      try { d = JSON.parse(text); } catch (e) { return jsonError('上游返回异常（' + text.slice(0, 80).replace(/[<>&"']/g, '') + '）', 502, env, request); }
      if (d.code === 0 && Array.isArray(d.msg)) {
        d.msg = d.msg.map(item => {
          if (!item || typeof item !== 'object' || item.cost === undefined) return item;
          const originUsd = parseFloat(item.cost) || 0;
          if (action === 'services') {
            item.cost = Math.round(originUsd * MARKUP * 100) / 100;
            delete item.origin_cost;
          } else {
            item.price_cny = Math.round(originUsd * MARKUP * USD_TO_CNY * 100);
            delete item.cost;
            delete item.origin_cost;
          }
          return item;
        });
      }
      return jsonOk(d, env, request);
    } catch (e) { return jsonError('上游服务暂不可用，请稍后重试', 502, env, request, e); }
  }

  // ========== 写操作（必须绑定订单） ==========
  const orderNo = url.searchParams.get('order_no') || '';
  if (!orderNo) return jsonError('缺少 order_no，接码操作必须绑定订单', 400, env, request);
  const order = await findOrder(env, orderNo);
  if (!order) return jsonError('订单不存在', 404, env, request);

  const isChargeAction = (action === 'request_number' || action === 'common_request');
  if (isChargeAction && order.status === 'pending') return jsonError('订单未支付，无法取号', 400, env, request);

  const admin = await requireAdmin(request, env);
  const member = await requireMember(request, env);
  if (!admin && (!member || member.username !== order.username)) return jsonError('只能操作自己的订单', 403, env, request);

  if (isChargeAction) {
    const rl = await rateLimit(env.YUNFAKA_KV, 'luban:' + orderNo, 3, 60000);
    if (rl.blocked) return jsonError('取号过于频繁，请稍后重试', 429, env, request);
  }

  try {
    if (action === 'request_number') {
      const serviceId = url.searchParams.get('service_id') || order.luban_service_id || '';
      if (!serviceId) return jsonError('缺少 service_id', 400, env, request);
      const r = await fetch(buildUrl('getNumber', { service_id: serviceId }));
      return jsonOk(await r.json(), env, request);
    }
    if (action === 'change_status') {
      const requestId = url.searchParams.get('request_id');
      const status = url.searchParams.get('status') || 'reject';
      if (!requestId) return jsonError('缺少 request_id', 400, env, request);
      const r = await fetch(buildUrl('setStatus', { request_id: requestId, status }));
      return jsonOk(await r.json(), env, request);
    }
    if (action === 'reactivate') {
      const requestId = url.searchParams.get('request_id');
      if (!requestId) return jsonError('缺少 request_id', 400, env, request);
      const r = await fetch(buildUrl('getAgainNmber', { request_id: requestId }));
      return jsonOk(await r.json(), env, request);
    }
    if (action === 'common_request') {
      const params = {};
      if (url.searchParams.get('phone')) params.phone = url.searchParams.get('phone');
      if (url.searchParams.get('cardType') && url.searchParams.get('cardType') !== '全部') params.cardType = url.searchParams.get('cardType');
      if (url.searchParams.get('filter')) params.filter = url.searchParams.get('filter');
      if (url.searchParams.get('country')) params.country = url.searchParams.get('country');
      const r = await fetch(buildUrl('getKeywordNumber', params));
      return jsonOk(await r.json(), env, request);
    }
    if (action === 'common_release') {
      const phone = url.searchParams.get('phone');
      if (!phone) return jsonError('缺少 phone', 400, env, request);
      const r = await fetch(buildUrl('delKeywordNumber', { phone }));
      return jsonOk(await r.json(), env, request);
    }
    return jsonError('未知 action: ' + action, 400, env, request);
  } catch (e) { return jsonError('操作失败，请稍后重试', 500, env, request, e); }
}

// ======== 供内部调用的后台静默取号逻辑 ========
export async function processOrderLuban(env, orderNo) {
  try {
    const raw = await env.YUNFAKA_KV.get('state');
    if (!raw) return { ok: false, msg: 'DB_EMPTY' };
    const state = JSON.parse(raw);
    const order = (state.db.orders || []).find(o => String(o.order_no) === String(orderNo));
    
    if (!order || order.source !== 'luban') return { ok: false, msg: 'INVALID_ORDER' };
    if (order.luban_phone || order.luban_request_id) return { ok: true, msg: 'ALREADY_HAVE_NUMBER' };
    
    const apikey = env.LUBAN_APIKEY;
    if (!apikey) return { ok: false, msg: 'NO_API_KEY' };
    const BASE = 'https://lubansms.com/v2/api/';

    let actionUrl = '';
    if (order.luban_type === 'common') {
      const p = new URLSearchParams({ apikey, country: order.luban_country || '', phone: order.luban_phone || '', cardType: order.luban_cardtype || '', filter: order.luban_filter || '' });
      if (order.luban_keyword) p.set('keyword', order.luban_keyword);
      actionUrl = BASE + 'getKeywordNumber?' + p.toString();
    } else {
      const p = new URLSearchParams({ apikey, service_id: order.luban_service_id });
      actionUrl = BASE + 'getNumber?' + p.toString();
    }

    const res = await fetch(actionUrl);
    const d = await res.json();
    
    if (d.code === 0 && d.msg) {
      if (order.luban_type === 'common') {
        order.luban_phone = d.msg.phone || d.msg.phone_number || '';
        order.luban_number = order.luban_phone;
      } else {
        order.luban_request_id = d.msg.request_id || d.msg.id || '';
        order.luban_phone = d.msg.phone_number || d.msg.phone || '';
        order.luban_number = order.luban_phone;
      }
      order.status = 'processing';
      order.luban_start_time = Date.now();
    } else {
      order.status = 'luban_error';
      order.luban_error = d.msg || '取号失败，上游余额不足或服务不可用';
    }
    
    state.rev = (state.rev || 0) + 1;
    await env.YUNFAKA_KV.put('state', JSON.stringify(state));
    return { ok: true, status: order.status };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}
