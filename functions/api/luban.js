// functions/api/luban.js · 接码修复版 v4（2026-10-23）
// 修复清单：
//   1. 新增 request_number / common_request action 代理（前端兜底取号，之前返回 400）
//   2. 新增 common_release action 代理（释放号码，之前返回 400）
//   3. 重写号码/请求ID解析器：独立提取 phone 和 requestId（旧逻辑 reqId 依赖 !phone 条件，遍历顺序不对就丢 request_id）
//   4. 处理鲁班多种返回格式：msg 为号码字符串 / data 嵌套 / result 嵌套 / 顶层字段
//   5. 取号成功统一写入 luban_phone + luban_number + luban_request_id + luban_deadline（旧版 usdt-check 内联取号缺字段导致前端显示"正在分配中"和"0分00秒"）
//   6. processOrderLuban 与 HTTP 代理共用同一解析器，行为一致
import { requireAdmin, requireMember, optionsResponse, jsonError, jsonOk, rateLimit } from '../_lib/common.js';

const LUBAN_BASE = 'https://lubansms.com/v2/api/';

async function findOrder(env, orderNo) {
  try {
    const raw = await env.YUNFAKA_KV.get('state');
    if (!raw) return null;
    const state = JSON.parse(raw);
    return (state.db && state.db.orders || []).find(o => String(o.order_no) === String(orderNo)) || null;
  } catch (e) { return null; }
}

function buildUrl(apikey, path, params) {
  const p = new URLSearchParams();
  p.set('apikey', apikey);
  Object.keys(params || {}).forEach(k => {
    const v = params[k];
    if (v !== undefined && v !== null && v !== '') p.set(k, v);
  });
  return LUBAN_BASE + path + '?' + p.toString();
}

// ========== 超级健壮的鲁班取号结果解析器 ==========
// 处理所有可能的返回格式，返回 { phone, requestId, raw }
function extractLubanResult(d) {
  let phone = '', requestId = '';
  if (!d || typeof d !== 'object') return { phone, requestId };

  // 1. 顶层 msg 是纯数字字符串 → 直接当号码（鲁班某些版本直接返回手机号）
  if (typeof d.msg === 'string' && /^\+?[\d\s-]{6,20}$/.test(d.msg.trim())) {
    phone = d.msg.trim().replace(/[\s-]/g, '');
  }
  // 2. 顶层 request_id 字段
  if (d.request_id) requestId = String(d.request_id);

  // 3. 深度遍历所有层级（包括 d.msg / d.data / d.result / 嵌套数组）
  function deepScan(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 5) return;
    if (Array.isArray(obj)) { obj.forEach(x => deepScan(x, depth + 1)); return; }
    for (let k in obj) {
      const val = obj[k];
      const key = String(k).toLowerCase();
      const sVal = String(val == null ? '' : val);

      if (typeof val === 'string' || typeof val === 'number') {
        // —— 提取手机号 ——
        // key 命中 phone/mobile/tel/number，且值是 6~20 位数字（可带 + 空格 -）
        const looksLikePhone = /^\+?[\d\s-]{6,20}$/.test(sVal) && /\d{6,}/.test(sVal);
        if (!phone && (key.includes('phone') || key.includes('mobile') || key.includes('tel') || key.includes('number')) && looksLikePhone) {
          phone = sVal.replace(/[\s-]/g, '');
        }
        // —— 提取 request_id ——
        // 优先：key 包含 request（request_id / requestid）
        if (!requestId && key.includes('request') && sVal.length >= 4) {
          requestId = sVal;
        }
        // 其次：key 严格等于 id 且值较长（>10位，排除 service_id 短数字）
        else if (!requestId && key === 'id' && sVal.length > 10) {
          requestId = sVal;
        }
      } else if (val && typeof val === 'object') {
        deepScan(val, depth + 1);
      }
    }
  }
  deepScan(d, 0);

  // 4. 兜底：如果 msg 是 JSON 字符串，解析后再扫一次
  if ((!phone || !requestId) && typeof d.msg === 'string') {
    try {
      const inner = JSON.parse(d.msg);
      const r = extractLubanResult(inner);
      if (!phone && r.phone) phone = r.phone;
      if (!requestId && r.requestId) requestId = r.requestId;
    } catch (e) {}
  }

  return { phone, requestId };
}

// 取号成功后把字段写入订单对象（统一入口，保证字段齐全）
function applyNumberToOrder(order, phone, requestId) {
  order.luban_phone = phone;
  order.luban_number = phone;        // 前端显示用 luban_number，必须同步
  if (requestId) order.luban_request_id = requestId;
  order.status = 'processing';
  order.luban_start_time = Date.now();
  order.luban_deadline = Date.now() + 20 * 60 * 1000;  // 20 分钟倒计时
  order.luban_error = '';
  if (!order.submitted_at) order.submitted_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
}

// 统一取号：根据订单类型调用对应鲁班 API，返回 { phone, requestId } 或抛错
async function fetchNumberFromLuban(env, order) {
  const apikey = env.LUBAN_APIKEY;
  if (!apikey) throw new Error('未配置 LUBAN_APIKEY');
  let actionUrl;
  if (order.luban_type === 'common') {
    if (!order.luban_keyword) throw new Error('缺少关键词(keyword)');
    const p = new URLSearchParams({ apikey });
    if (order.luban_keyword) p.set('keyword', order.luban_keyword);
    if (order.luban_country) p.set('country', order.luban_country);
    if (order.luban_cardtype && order.luban_cardtype !== '全部') p.set('cardType', order.luban_cardtype);
    if (order.luban_filter === '是' || order.luban_filter === '1') p.set('filter', '1');
    actionUrl = LUBAN_BASE + 'getKeywordNumber?' + p.toString();
  } else {
    if (!order.luban_service_id) throw new Error('缺少服务ID(service_id)');
    actionUrl = buildUrl(apikey, 'getNumber', { service_id: String(order.luban_service_id).trim() });
  }
  const res = await fetch(actionUrl);
  const text = await res.text();
  let d;
  try { d = JSON.parse(text); } catch (e) { throw new Error('上游返回非JSON: ' + text.slice(0, 80)); }

  const isSuccess = String(d.code) === '0' || String(d.code) === '200' || d.success === true;
  if (!isSuccess) {
    const errMsg = typeof d.msg === 'string' ? d.msg : JSON.stringify(d.msg || d);
    throw new Error('上游取号失败: ' + errMsg);
  }
  const { phone, requestId } = extractLubanResult(d);
  if (!phone) throw new Error('取号成功但未解析出手机号，上游返回: ' + text.slice(0, 120));
  return { phone, requestId, raw: d };
}

// ========== HTTP 路由 ==========
export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return optionsResponse(request, env);
  const apikey = env.LUBAN_APIKEY;
  if (!apikey) return jsonError('未配置 LUBAN_APIKEY 环境变量', 400, env, request);

  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  let MARKUP = 1.3, USD_TO_CNY = 7.2;
  try {
    const raw = await env.YUNFAKA_KV.get('state');
    if (raw) { const st = JSON.parse(raw); const cfg = (st.db && st.db.config) || {}; if (cfg.luban_markup) MARKUP = Number(cfg.luban_markup) || 1.3; if (cfg.pay_usdt_rate) USD_TO_CNY = Number(cfg.pay_usdt_rate) || 7.2; }
  } catch (e) {}

  // —— 只读代理：余额 / 国家列表 ——
  if (action === 'balance' || action === 'countries') {
    const pathMap = { balance: 'getBalance', countries: 'countries' };
    try {
      const r = await fetch(buildUrl(apikey, pathMap[action], {}));
      return jsonOk(await r.json(), env, request);
    } catch (e) { return jsonError('上游服务暂不可用', 502, env, request, e); }
  }

  // —— 查短信代理 ——
  if (action === 'get_sms' || action === 'common_get_sms') {
    const orderNo = url.searchParams.get('order_no') || '';
    if (!orderNo) return jsonError('缺少 order_no', 400, env, request);
    const order = await findOrder(env, orderNo);
    if (!order) return jsonError('订单不存在', 404, env, request);
    try {
      let r;
      if (action === 'get_sms') {
        const requestId = url.searchParams.get('request_id') || order.luban_request_id || '';
        if (!requestId) return jsonError('缺少 request_id（取号可能未成功）', 400, env, request);
        r = await fetch(buildUrl(apikey, 'getSms', { request_id: requestId }));
      } else {
        const phone = url.searchParams.get('phone') || order.luban_phone || '';
        const keyword = url.searchParams.get('keyword') || order.luban_keyword || '';
        if (!phone) return jsonError('缺少 phone（取号可能未成功）', 400, env, request);
        r = await fetch(buildUrl(apikey, 'getKeywordSms', { phone, keyword }));
      }
      return jsonOk(await r.json(), env, request);
    } catch (e) { return jsonError('上游服务暂不可用', 502, env, request, e); }
  }

  // —— 服务列表代理（加价） ——
  if (action === 'services' || action === 'client_services') {
    const params = { language: url.searchParams.get('language') || 'zh', page: url.searchParams.get('page') || '1' };
    if (url.searchParams.get('countryName')) params.country = url.searchParams.get('countryName');
    if (url.searchParams.get('service')) params.service = url.searchParams.get('service');
    try {
      const r = await fetch(buildUrl(apikey, 'List', params));
      const text = await r.text();
      let d;
      try { d = JSON.parse(text); } catch (e) { return jsonError('上游返回异常', 502, env, request); }
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
          }
          return item;
        });
      }
      return jsonOk(d, env, request);
    } catch (e) { return jsonError('上游服务暂不可用', 502, env, request, e); }
  }

  // —— 以下 action 都需要订单 + 权限校验 ——
  const orderNo = url.searchParams.get('order_no') || '';
  if (!orderNo) return jsonError('缺少 order_no', 400, env, request);
  const order = await findOrder(env, orderNo);
  if (!order) return jsonError('订单不存在', 404, env, request);

  const isChargeAction = (action === 'request_number' || action === 'common_request');
  if (isChargeAction && order.status === 'pending') return jsonError('订单未支付，无法取号', 400, env, request);

  const admin = await requireAdmin(request, env);
  const member = await requireMember(request, env);
  if (!admin && (!member || member.username !== order.username)) return jsonError('只能操作自己的订单', 403, env, request);

  if (isChargeAction) {
    const rl = await rateLimit(env.YUNFAKA_KV, 'luban:' + orderNo, 3, 60000);
    if (rl.blocked) return jsonError('取号过于频繁，请稍后再试', 429, env, request);
  }

  try {
    // —— 取号代理（前端兜底取号，之前缺失导致 400） ——
    if (action === 'request_number' || action === 'common_request') {
      // 已有号码直接返回
      if (order.luban_phone) {
        return jsonOk({ ok: true, code: 0, data: { phone: order.luban_phone, request_id: order.luban_request_id || '' }, msg: 'already_have' }, env, request);
      }
      const { phone, requestId } = await fetchNumberFromLuban(env, order);
      // 写入 KV
      const raw = await env.YUNFAKA_KV.get('state');
      const st = JSON.parse(raw);
      const o = (st.db.orders || []).find(x => String(x.order_no) === String(orderNo));
      if (o) {
        applyNumberToOrder(o, phone, requestId);
        st.rev = (st.rev || 0) + 1;
        await env.YUNFAKA_KV.put('state', JSON.stringify(st));
      }
      return jsonOk({ ok: true, code: 0, data: { phone, phone_number: phone, request_id: requestId, id: requestId } }, env, request);
    }

    // —— 释放号码 ——
    if (action === 'change_status') {
      const requestId = url.searchParams.get('request_id') || order.luban_request_id || '';
      const status = url.searchParams.get('status') || 'reject';
      if (!requestId) return jsonError('缺少 request_id', 400, env, request);
      const r = await fetch(buildUrl(apikey, 'setStatus', { request_id: requestId, status }));
      const upstream = await r.json();
      // 释放成功后同步订单状态，避免前端刷新后回到 processing
      try {
        const raw3 = await env.YUNFAKA_KV.get('state');
        if (raw3) {
          const st3 = JSON.parse(raw3);
          const o3 = (st3.db.orders || []).find(x => String(x.order_no) === String(orderNo));
          if (o3 && o3.status !== 'delivered') {
            o3.status = 'rejected';
            o3.luban_released = true;
            o3.luban_error = o3.luban_error || '客户主动释放号码';
            st3.rev = (st3.rev || 0) + 1;
            await env.YUNFAKA_KV.put('state', JSON.stringify(st3));
          }
        }
      } catch (e) {}
      return jsonOk(upstream, env, request);
    }
    if (action === 'common_release') {
      const phone = url.searchParams.get('phone') || order.luban_phone || '';
      if (!phone) return jsonError('缺少 phone', 400, env, request);
      let upstream = { ok: true, msg: 'release_attempted' };
      try {
        const r = await fetch(buildUrl(apikey, 'releaseNumber', { phone }));
        upstream = await r.json();
      } catch (e) {}
      // 同步订单状态
      try {
        const raw3 = await env.YUNFAKA_KV.get('state');
        if (raw3) {
          const st3 = JSON.parse(raw3);
          const o3 = (st3.db.orders || []).find(x => String(x.order_no) === String(orderNo));
          if (o3 && o3.status !== 'delivered') {
            o3.status = 'rejected';
            o3.luban_released = true;
            o3.luban_error = o3.luban_error || '客户主动释放号码';
            st3.rev = (st3.rev || 0) + 1;
            await env.YUNFAKA_KV.put('state', JSON.stringify(st3));
          }
        }
      } catch (e) {}
      return jsonOk(upstream, env, request);
    }

    return jsonError('未知 action: ' + String(action).slice(0, 30), 400, env, request);
  } catch (e) {
    // 取号失败：把错误写入订单，前端可显示真实原因
    try {
      const raw2 = await env.YUNFAKA_KV.get('state');
      if (raw2) {
        const st2 = JSON.parse(raw2);
        const o2 = (st2.db.orders || []).find(x => String(x.order_no) === String(orderNo));
        if (o2 && !o2.luban_phone) {
          o2.status = 'luban_error';
          o2.luban_error = String(e.message || '未知异常').slice(0, 200);
          st2.rev = (st2.rev || 0) + 1;
          await env.YUNFAKA_KV.put('state', JSON.stringify(st2));
        }
      }
    } catch (err) {}
    return jsonError(e.message || '取号失败', 400, env, request, e);
  }
}

// ======== 内部静默取号（USDT到账 / 管理员审核后由 waitUntil 调用） ========
export async function processOrderLuban(env, orderNo) {
  try {
    const raw = await env.YUNFAKA_KV.get('state');
    if (!raw) return { ok: false, msg: 'DB_EMPTY' };
    const state = JSON.parse(raw);
    const order = (state.db.orders || []).find(o => String(o.order_no) === String(orderNo));
    if (!order || order.source !== 'luban') return { ok: false, msg: 'INVALID_ORDER' };
    if (order.luban_phone) return { ok: true, msg: 'ALREADY_HAVE_NUMBER' };

    const { phone, requestId } = await fetchNumberFromLuban(env, order);
    applyNumberToOrder(order, phone, requestId);

    state.rev = (state.rev || 0) + 1;
    await env.YUNFAKA_KV.put('state', JSON.stringify(state));
    return { ok: true, status: order.status, phone };
  } catch (e) {
    console.error(`[Luban取号异常] 订单:${orderNo}, 原因:`, e.message);
    try {
      const raw2 = await env.YUNFAKA_KV.get('state');
      if (raw2) {
        const st2 = JSON.parse(raw2);
        const o2 = (st2.db.orders || []).find(x => String(x.order_no) === String(orderNo));
        if (o2 && !o2.luban_phone) {
          o2.status = 'luban_error';
          o2.luban_error = String(e.message || '未知异常').slice(0, 200);
          st2.rev = (st2.rev || 0) + 1;
          await env.YUNFAKA_KV.put('state', JSON.stringify(st2));
        }
      }
    } catch (err) {}
    return { ok: false, msg: e.message };
  }
}
