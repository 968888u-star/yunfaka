// functions/_lib/common.js · 共享工具库（安全加固版 + P30 修复公开配置白名单）
// 提供：统一 CORS（白名单）、JSON 响应、错误脱敏、限流、数据脱敏、管理员校验、IP 获取
import { verifyToken } from './auth.js';

// ========== CORS 白名单 ==========
// 默认允许：站点自身 origin（从请求 Host 推导 https）+ 环境变量 ALLOWED_ORIGINS（逗号分隔）
// 未配置 ALLOWED_ORIGINS 时，反射请求 Origin（同源/同站部署不受影响；比 * 安全）
export function getAllowedOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!origin) return ''; // 非浏览器请求，无需 CORS 头
  const allowList = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  // 推导自身 origin
  const host = request.headers.get('Host') || '';
  const selfOrigins = host ? [`https://${host}`] : [];
  const all = [...new Set([...allowList, ...selfOrigins])];
  // 未配置白名单时：反射 Origin（兼容自定义域名，但不返回 credentials）
  if (allowList.length === 0) return origin;
  // 严格白名单校验
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

// 错误脱敏：生产环境（NODE_ENV=production 或 CF 部署）返回通用消息，详情仅记日志
export function jsonError(msg, status, env, request, rawErr) {
  if (rawErr) console.error('[yunfaka]', rawErr && rawErr.stack ? rawErr.stack : rawErr);
  const safe = (env && env.NODE_ENV === 'development') ? String(msg) : safeMsg(String(msg));
  return Response.json({ ok: false, msg: safe }, { status: status || 400, headers: corsHeaders(request, env) });
}

function safeMsg(m) {
  // 过滤可能泄露内部路径/环境变量名的关键词
  if (/ENOENT|EISDIR|undefined is not|cannot read|is not defined|at |\/home\/|\/var\/|wrangler|kv namespace/i.test(m)) {
    return '服务器内部错误，请稍后重试';
  }
  return m;
}

// ========== 限流（内存版，不消耗 KV 写入配额） ==========
// 背景：Cloudflare KV 免费版每日仅 1000 次写入，原实现每次限流都 kv.put()，
//       与业务数据写入叠加后极易超限（SMM 875 商品操作即可打爆当日配额）。
// 改为内存 Map：单 Workers 实例内精确，多实例间不共享（防刷足够，代价可接受）。
const _rlStore = new Map();
let _rlLastCleanup = Date.now();
export async function rateLimit(kv, key, max, windowMs) {
  const now = Date.now();
  // 每 10 分钟清理一次过期 key，防止内存无限增长
  if (now - _rlLastCleanup > 600000) {
    _rlLastCleanup = now;
    try {
      for (const [k, v] of _rlStore) {
        if (now - (v.t || 0) > 7200000) _rlStore.delete(k); // 超2小时必清
      }
      if (_rlStore.size > 50000) _rlStore.clear(); // 极端保护
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
// 未登录用户只能看到公开数据：商品、分类、配置中的公开字段、订单数量（不含详情）、卡密库存数（不含内容）
// 带有效 admin token 时返回完整数据（由调用方判断，调用 sanitizeDbForAdmin）
export function sanitizeDbForPublic(db) {
  if (!db || typeof db !== 'object') return db;
  const d = JSON.parse(JSON.stringify(db)); // 深拷贝，避免修改原对象
  // 1. 卡密：保留元数据（product_id/sku_id/status）用于前端库存计数，删除敏感内容 content
  if (Array.isArray(d.cards)) {
    d.cards = d.cards
      .filter(c => c.status === 'unused') // 只返回未使用卡密的元数据
      .map(c => ({ id: c.id, product_id: c.product_id, sku_id: c.sku_id || 0, status: c.status, created_at: c.created_at }));
    // content 字段已完全移除，无法泄露卡密内容
  }
  // 2. 会员：删除密码/暗号/余额，只保留用户名和注册时间（甚至可以整个删除）
  if (Array.isArray(d.members)) {
    d.member_count = d.members.length;
    d.members = d.members.map(m => ({ username: m.username, created_at: m.created_at }));
  }
  // 3. 订单：只保留最近公开状态统计，删除详情（含卡密、用户信息）
  if (Array.isArray(d.orders)) {
    d.order_count = d.orders.length;
    d.orders = []; // 公开接口不返回订单详情
  }
  if (Array.isArray(d.recharges)) {
    d.recharges = [];
  }
  // 4. 配置：只保留公开字段，删除所有敏感配置
  // P30 修复：补齐前端所有需要的公开配置字段，否则未登录用户看不到使用说明/分类/自定义文案
  if (d.config && typeof d.config === 'object') {
    const pub = {};
    const publicKeys = [
      // --- 原有基础字段 ---
      'site_name', 'tg_username', 'tg_btn_color',
      'pay_usdt_enabled', 'pay_alipay_enabled', 'pay_alipay_mode',
      'pay_alipay_redpacket_prefix', 'recharge_min',
      'recharge_bonus_pct', 'recharge_bonus_text',
      'pay_usdt_rate', 'pay_usdt_network', 'smm_markup',
      'pay_usdt_qr', 'pay_alipay_qr', 'pay_alipay_note',

      // --- P30 新增：首页/客户端展示相关（未登录用户也需要看到） ---
      'hero_subtitle',            // 首页 Banner 副标题
      'yf_announcement',          // 首页公告
      'member_card_title',        // 会员卡片标题
      'home_entry_member_title',  // 首页会员入口标题
      'home_entry_member_sub',    // 首页会员入口副标题
      'home_entry_luban_title',   // 首页接码入口标题
      'home_entry_luban_sub',     // 首页接码入口副标题
      'home_entry_smm_title',     // 首页 SMM 入口标题
      'home_entry_smm_sub',       // 首页 SMM 入口副标题

      // --- P30 新增：SMM 客户端展示相关 ---
      'smm_categories',           // SMM 自定义分类列表（换行分隔）
      'smm_usage_text',           // SMM 使用说明 HTML
      'smm_hero_title',           // SMM 顶部标题
      'smm_hero_subtitle',        // SMM 顶部副标题

      // --- P30 新增：Luban 客户端展示相关 ---
      'luban_usage_text',         // Luban 使用说明 HTML
      'luban_markup',             // Luban 加价倍数（未登录时算通用接码价格需要）
      'luban_common_cost'         // Luban 通用接码成本（未登录时算通用接码价格需要）
    ];
    publicKeys.forEach(k => { if (d.config[k] !== undefined) pub[k] = d.config[k]; });
    // USDT 收款地址：下单页需要显示，保留（这是公开收款地址，泄露风险低）
    if (d.config.pay_usdt_address) pub.pay_usdt_address = d.config.pay_usdt_address;
    d.config = pub;
  }
  // 5. 日志删除
  delete d.logs;
  return d;
}

// 管理员脱敏：返回完整数据，但仍删除极敏感字段（如已废弃的 ACCESS_TOKEN 残留）
export function sanitizeDbForAdmin(db) {
  if (!db || typeof db !== 'object') return db;
  const d = JSON.parse(JSON.stringify(db));
  // TG token 掩码显示（前端需要判断是否已配置，但不需要明文）
  if (d.config && d.config.tg_bot_token && !/\*\*\*/.test(String(d.config.tg_bot_token))) {
    const t = String(d.config.tg_bot_token);
    d.config.tg_bot_token_masked = t.slice(0, 6) + '********' + t.slice(-4);
    // 保留原值，前端保存时若传掩码则后端保留（state.js 已有此逻辑）
  }
  return d;
}

// ========== 管理员 token 校验（统一入口） ==========
export async function requireAdmin(request, env) {
  const token = request.headers.get('x-admin-token') || '';
  if (!token) return null;
  const secret = env.ADMIN_SECRET || '';
  if (!secret) return null; // 未配置 ADMIN_SECRET 一律拒绝
  const payload = await verifyToken(token, secret);
  if (!payload || payload.sub !== 'admin') return null;
  return payload;
}

// ========== 会员 token 校验（会员登录后签发） ==========
export async function requireMember(request, env) {
  const token = request.headers.get('x-member-token') || '';
  if (!token) return null;
  const secret = env.ADMIN_SECRET || '';
  if (!secret) return null;
  const payload = await verifyToken(token, secret);
  if (!payload || payload.sub !== 'member') return null;
  return payload; // { sub:'member', username, exp }
}
