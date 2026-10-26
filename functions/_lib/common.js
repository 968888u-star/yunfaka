// functions/_lib/common.js · 共享工具库（安全加固版 + 订单脱敏放行）
// 提供：统一 CORS（白名单）、JSON 响应、错误脱敏、限流、数据脱敏、管理员校验、IP 获取
import { verifyToken } from './auth.js';

// ========== CORS 白名单 ==========
export function getAllowedOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!origin) return ''; // 非浏览器请求，无需 CORS 头
  const allowList = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const host = request.headers.get('Host') || '';
  const selfOrigins = host ? [`https://${host}`] : [];
  const all = [...new Set([...allowList, ...selfOrigins])];
  if (allowList.length === 0) return origin;
  if (all.some(o => origin === o || origin.startsWith(o + '/'))) return origin;
  return ''; // 不匹配则不返回 CORS 头，浏览器拦截
}

export function corsHeaders(request, env, extraMethods) {
  const allowOrigin = getAllowedOrigin(request, env);
  const h = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Methods': extraMethods || 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token, X-Access-Token, X-Sync-Key, X-Backup-Secret, X-Member-Token',
    'Access-Control-Max-Age': '86400',
  };
  if (allowOrigin) {
    h['Access-Control-Allow-Origin'] = allowOrigin;
    h['Vary'] = 'Origin';
  }
  return h;
}

export function optionsResponse(request, env) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

// ========== 统一响应 ==========
export function jsonOk(data, env, request, status) {
  return Response.json(data, { status: status || 200, headers: corsHeaders(request, env) });
}

// 错误脱敏
export function jsonError(msg, status, env, request, rawErr) {
  if (rawErr) console.error('[yunfaka]', rawErr && rawErr.stack ? rawErr.stack : rawErr);
  const safe = (env && env.NODE_ENV === 'development') ? String(msg) : safeMsg(String(msg));
  return Response.json({ ok: false, msg: safe }, { status: status || 400, headers: corsHeaders(request, env) });
}

function safeMsg(m) {
  if (/ENOENT|EISDIR|undefined is not|cannot read|is not defined|at |\/home\/|\/var\/|wrangler|kv namespace/i.test(m)) {
    return '服务器内部错误，请稍后重试';
  }
  return m;
}

// ========== 限流（内存版） ==========
const _rlStore = new Map();
let _rlLastCleanup = Date.now();
export async function rateLimit(kv, key, max, windowMs) {
  const now = Date.now();
  if (now - _rlLastCleanup > 600000) {
    _rlLastCleanup = now;
    try {
      for (const [k, v] of _rlStore) {
        if (now - (v.t || 0) > 7200000) _rlStore.delete(k);
      }
      if (_rlStore.size > 50000) _rlStore.clear();
    } catch (e) {}
  }
  let rec = _rlStore.get(key);
  if (!rec || now - rec.t > windowMs) { rec = { t: now, n: 0 }; }
  rec.n++;
  _rlStore.set(key, rec);
  if (rec.n > max) return { blocked: true, retryAfter: Math.ceil((windowMs - (now - rec.t)) / 1000) };
  return { blocked: false };
}

export function getClientIp(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || 'unknown';
}

// ========== 数据脱敏（GET /api/state 公开返回用） ==========
export function sanitizeDbForPublic(db) {
  if (!db || typeof db !== 'object') return db;
  const d = JSON.parse(JSON.stringify(db)); // 深拷贝
  
  // 1. 卡密：只返回未使用卡密的元数据
  if (Array.isArray(d.cards)) {
    d.cards = d.cards
      .filter(c => c.status === 'unused')
      .map(c => ({ id: c.id, product_id: c.product_id, sku_id: c.sku_id || 0, status: c.status, created_at: c.created_at }));
  }
  
  // 2. 会员：删除密码/暗号/余额，只保留用户名
  if (Array.isArray(d.members)) {
    d.member_count = d.members.length;
    d.members = d.members.map(m => ({ username: m.username, created_at: m.created_at }));
  }

  // 3. 订单：为了支持前端查询、轮询和单号比对，必须放行脱敏后的订单
  if (Array.isArray(d.orders)) {
    d.order_count = d.orders.length;
    d.orders = d.orders.map(o => {
      return {
        order_no: o.order_no,
        product_name: o.product_name,
        sku_name: o.sku_name || '',
        quantity: o.quantity,
        amount: o.amount,
        balance_used: o.balance_used || 0,
        amount_due: o.amount_due || 0,
        secret: o.secret, // 必须返回，否则前端无法用单号+暗号验证身份
        status: o.status,
        pay_method: o.pay_method,
        created_at: o.created_at,
        delivered_at: o.delivered_at || '',
        source: o.source || 'local',
        redpacket_code: o.redpacket_code || '',
        usdt_rate: o.usdt_rate,
        expected_usdt_exact: o.expected_usdt_exact,
        
        // 接码相关
        luban_type: o.luban_type,
        luban_phone: o.luban_phone,
        luban_request_id: o.luban_request_id,
        luban_code: o.luban_code,
        luban_sms: o.luban_sms,
        luban_country: o.luban_country,
        luban_keyword: o.luban_keyword,
        
        // SMM 相关
        smm_link: o.smm_link,
        smm_order_id: o.smm_order_id,
        smm_state: o.smm_state,
        
        // 卡密展示
        cards: o.cards && o.cards.length ? o.cards : []
      };
    });
  }

  // 4. 充值记录放行
  if (Array.isArray(d.recharges)) {
    d.recharges = d.recharges.map(r => ({
      id: r.id,
      username: r.username,
      amount: r.amount,
      method: r.method,
      status: r.status,
      created_at: r.created_at,
      completed_at: r.completed_at || '',
      usdt_rate: r.usdt_rate,
      expected_usdt_exact: r.expected_usdt_exact,
      redpacket_code: r.redpacket_code || '',
      bonus_amount: r.bonus_amount || 0
    }));
  }

  // 5. 配置：只保留公开字段
  if (d.config && typeof d.config === 'object') {
    const pub = {};
    const publicKeys = [
      'site_name', 'tg_username', 'tg_btn_color',
      'pay_usdt_enabled', 'pay_alipay_enabled', 'pay_alipay_mode',
      'pay_alipay_redpacket_prefix', 'recharge_min',
      'recharge_bonus_pct', 'recharge_bonus_text',
      'pay_usdt_rate', 'pay_usdt_network', 'smm_markup',
      'pay_usdt_qr', 'pay_alipay_qr', 'pay_alipay_note',
      'hero_subtitle', 'yf_announcement', 'member_card_title',
      'home_entry_member_title', 'home_entry_member_sub',
      'home_entry_luban_title', 'home_entry_luban_sub',
      'home_entry_smm_title', 'home_entry_smm_sub',
      'smm_categories', 'smm_usage_text', 'smm_hero_title', 'smm_hero_subtitle',
      'luban_usage_text', 'luban_markup', 'luban_common_cost',
      'smm_auto_sync', 'smm_sync_interval_hours', 'smm_last_sync', 'smm_cost_currency',
      'luban_auto_sync', 'luban_sync_interval_hours', 'luban_last_sync'
    ];
    publicKeys.forEach(k => { if (d.config[k] !== undefined) pub[k] = d.config[k]; });
    if (d.config.pay_usdt_address) pub.pay_usdt_address = d.config.pay_usdt_address;
    d.config = pub;
  }
  
  // 6. 日志删除
  delete d.logs;
  return d;
}

// 管理员脱敏
export function sanitizeDbForAdmin(db) {
  if (!db || typeof db !== 'object') return db;
  const d = JSON.parse(JSON.stringify(db));
  if (d.config && d.config.tg_bot_token && !/\*\*\*/.test(String(d.config.tg_bot_token))) {
    const t = String(d.config.tg_bot_token);
    d.config.tg_bot_token_masked = t.slice(0, 6) + '********' + t.slice(-4);
  }
  return d;
}

// ========== 鉴权 ==========
export async function requireAdmin(request, env) {
  const token = request.headers.get('x-admin-token') || '';
  if (!token) return null;
  const secret = env.ADMIN_SECRET || '';
  if (!secret) return null;
  const payload = await verifyToken(token, secret);
  if (!payload || payload.sub !== 'admin') return null;
  return payload;
}

export async function requireMember(request, env) {
  const token = request.headers.get('x-member-token') || '';
  if (!token) return null;
  const secret = env.ADMIN_SECRET || '';
  if (!secret) return null;
  const payload = await verifyToken(token, secret);
  if (!payload || payload.sub !== 'member') return null;
  return payload;
}
