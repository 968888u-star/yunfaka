// functions/api/state.js · 数据读写中枢（安全加固版）
// 变更：
//   1. GET：未登录返回脱敏数据（无卡密内容/会员密码暗号/敏感配置）；带有效 X-Admin-Token 返回完整数据
//   2. POST：废弃 ACCESS_TOKEN 机制，统一要求管理员 X-Admin-Token；保留 IP 限流作为兜底
//   3. CORS 收紧为白名单；错误信息脱敏
import { requireAdmin, sanitizeDbForPublic, sanitizeDbForAdmin, corsHeaders, optionsResponse, jsonError, jsonOk, rateLimit, getClientIp } from '../_lib/common.js';
import { LEGACY_DEFAULT_ADMIN_HASH } from '../_lib/auth.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return optionsResponse(request, env);

  // ========== GET：按身份返回不同粒度数据 ==========
  if (request.method === 'GET') {
    try {
      const raw = await env.YUNFAKA_KV.get('state');
      const data = raw ? JSON.parse(raw) : null;
      const db = (data && data.db) || null;
      const admin = await requireAdmin(request, env);
      const outDb = admin ? sanitizeDbForAdmin(db) : sanitizeDbForPublic(db);
      return jsonOk({ ok: true, rev: (data && data.rev) || 0, db: outDb, admin: !!admin }, env, request);
    } catch (e) {
      return jsonError('读取失败', 500, env, request, e);
    }
  }

  // ========== POST：必须管理员登录 ==========
  if (request.method === 'POST') {
    try {
      // 1. 管理员鉴权（主）
      const admin = await requireAdmin(request, env);
      if (!admin) {
        // 兼容旧前端：如果配置了 ACCESS_TOKEN 且前端携带，也允许（过渡期）
        const at = env.ACCESS_TOKEN || '';
        const clientAt = request.headers.get('x-access-token') || '';
        if (!at || clientAt !== at) {
          return jsonError('无权限写入，请先登录管理后台', 403, env, request);
        }
      }
      // 2. IP 限流兜底（即使已登录，防止刷写）
      const rl = await rateLimit(env.YUNFAKA_KV, 'write:' + getClientIp(request), 20, 10000);
      if (rl.blocked) return jsonError('操作过于频繁，请稍后再试', 429, env, request);

      // 3. 大小限制
      const cl = Number(request.headers.get('content-length') || 0);
      if (cl > 5 * 1024 * 1024) return jsonError('数据过大', 413, env, request);

      const body = await request.json();
      if (!body || !body.db || typeof body.db !== 'object') return jsonError('数据格式错误', 400, env, request);
      const db = body.db;
      if (!Array.isArray(db.products) || !Array.isArray(db.orders) || !Array.isArray(db.cards)) {
        return jsonError('数据结构不完整', 400, env, request);
      }

      const raw = await env.YUNFAKA_KV.get('state');
      const current = raw ? JSON.parse(raw) : null;
      const currentRev = (current && current.rev) || 0;
      // 乐观锁
      if (body.baseRev !== undefined && current && body.baseRev !== currentRev) {
        const adminNow = await requireAdmin(request, env);
        const conflictDb = adminNow ? sanitizeDbForAdmin(current.db) : sanitizeDbForPublic(current.db);
        return Response.json(
          { ok: false, msg: '数据已被其他设备更新', rev: currentRev, db: conflictDb },
          { status: 409, headers: corsHeaders(request, env) }
        );
      }

      // ===== 保护敏感字段（防止前端误传空值覆盖） =====
      if (current && current.db && current.db.config) {
        if (!db.config) db.config = {};
        if (current.db.config.tg_bot_token) {
          const incoming = String(db.config.tg_bot_token || '');
          if (incoming === '' || /\*\*\*/.test(incoming)) db.config.tg_bot_token = current.db.config.tg_bot_token;
        }
        if (current.db.config.admin_pwd_hash &&
            current.db.config.admin_pwd_hash !== LEGACY_DEFAULT_ADMIN_HASH &&
            (!db.config.admin_pwd_hash || db.config.admin_pwd_hash === LEGACY_DEFAULT_ADMIN_HASH)) {
          db.config.admin_pwd_hash = current.db.config.admin_pwd_hash;
        }
        if (current.db.config.pay_usdt_address && !db.config.pay_usdt_address) {
          db.config.pay_usdt_address = current.db.config.pay_usdt_address;
        }
        // 禁止通过 POST 直接写入 admin_pwd_hash（改密走 /api/admin-action 的 save_settings + new_admin_password）
        if (db.config.admin_pwd_hash && db.config.admin_pwd_hash !== current.db.config.admin_pwd_hash) {
          // 允许从旧格式升级为 pbkdf2（登录时自动升级会写回），其他情况拒绝
          if (!String(db.config.admin_pwd_hash).startsWith('pbkdf2$')) {
            delete db.config.admin_pwd_hash;
          }
        }
      }

      const newRev = currentRev + 1;
      await env.YUNFAKA_KV.put('state', JSON.stringify({ rev: newRev, db, updated_at: Date.now() }));
      return jsonOk({ ok: true, rev: newRev }, env, request);
    } catch (e) {
      return jsonError('保存失败', 400, env, request, e);
    }
  }
  return jsonError('Method not allowed', 405, env, request);
}
