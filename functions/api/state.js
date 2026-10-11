// functions/api/state.js · 数据读写中枢（前后端分离版）
// 关键改动：
//   1. POST 只允许管理员（删除 ACCESS_TOKEN 后门）
//   2. admin_pwd_hash 从 config 里剥离（读时删除，写时忽略）
//   3. GET 时管理员返回 admin_setup / admin_is_default 状态标记
import {
  requireAdmin, sanitizeDbForPublic, sanitizeDbForAdmin,
  optionsResponse, jsonError, jsonOk, rateLimit, getClientIp
} from '../_lib/common.js';
import { readAdminConfig } from '../_lib/admin-config.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return optionsResponse(request, env);

  /* ========== GET ========== */
  if (request.method === 'GET') {
    try {
      const raw = await env.YUNFAKA_KV.get('state');
      const data = raw ? JSON.parse(raw) : null;
      const db = (data && data.db) || null;
      const admin = await requireAdmin(request, env);

      // 无论何种身份，都从 config 里剥离 admin_pwd_hash
      if (db && db.config) delete db.config.admin_pwd_hash;

      const outDb = admin ? sanitizeDbForAdmin(db) : sanitizeDbForPublic(db);

      // 管理员登录时，附加 admin_config 状态（供前端判断是否默认密码）
      if (admin && outDb) {
        const ac = await readAdminConfig(env);
        outDb.admin_setup = !!(ac && ac.admin_pwd_hash);
        outDb.admin_is_default = !ac || !ac.admin_pwd_hash;
      }

      return jsonOk({
        ok: true,
        rev: (data && data.rev) || 0,
        db: outDb,
        admin: !!admin
      }, env, request);
    } catch (e) {
      return jsonError('读取失败', 500, env, request, e);
    }
  }

  /* ========== POST：只允许管理员 ========== */
  if (request.method === 'POST') {
    try {
      const admin = await requireAdmin(request, env);
      if (!admin) return jsonError('无权限写入，请先登录管理后台', 403, env, request);

      // 写入限流：放宽到 200次/10秒（SMM 批量上架/改价操作频繁，20次太容易误触）
      const rl = await rateLimit(env.YUNFAKA_KV, 'write:' + getClientIp(request), 200, 10000);
      if (rl.blocked) return jsonError('操作过于频繁，请稍后再试', 429, env, request);

      const cl = Number(request.headers.get('content-length') || 0);
      if (cl > 5 * 1024 * 1024) return jsonError('数据过大', 413, env, request);

      const body = await request.json();
      if (!body || !body.db || typeof body.db !== 'object') {
        return jsonError('数据格式错误', 400, env, request);
      }
      const db = body.db;
      if (!Array.isArray(db.products) || !Array.isArray(db.orders) || !Array.isArray(db.cards)) {
        return jsonError('数据结构不完整', 400, env, request);
      }

      const raw = await env.YUNFAKA_KV.get('state');
      const current = raw ? JSON.parse(raw) : null;
      const currentRev = (current && current.rev) || 0;

      // 乐观锁
      if (body.baseRev !== undefined && current && body.baseRev !== currentRev) {
        const conflictDb = sanitizeDbForAdmin(current.db);
        if (conflictDb && conflictDb.config) delete conflictDb.config.admin_pwd_hash;
        return Response.json(
          { ok: false, msg: '数据已被其他设备更新', rev: currentRev, db: conflictDb },
          { status: 409 }
        );
      }

      // 保护敏感字段
      if (current && current.db && current.db.config) {
        if (!db.config) db.config = {};
        // TG Token 空值/掩码值不覆盖
        if (current.db.config.tg_bot_token) {
          const incoming = String(db.config.tg_bot_token || '');
          if (incoming === '' || /\*\*\*/.test(incoming)) {
            db.config.tg_bot_token = current.db.config.tg_bot_token;
          }
        }
        // USDT 地址空值不覆盖
        if (current.db.config.pay_usdt_address && !db.config.pay_usdt_address) {
          db.config.pay_usdt_address = current.db.config.pay_usdt_address;
        }
      }
      // admin_pwd_hash 永远不从 state 写入
      if (db.config) delete db.config.admin_pwd_hash;

      const newRev = currentRev + 1;
      let payload;
      try {
        payload = JSON.stringify({ rev: newRev, db, updated_at: Date.now() });
      } catch (e2) {
        return jsonError('数据序列化失败：' + (e2 && e2.message ? e2.message : String(e2)), 400, env, request, e2);
      }
      if (payload.length > 24 * 1024 * 1024) {
        return jsonError('数据过大（' + Math.round(payload.length / 1024 / 1024) + 'MB），超过 KV 存储限制，请清理卡密/订单', 413, env, request);
      }
      await env.YUNFAKA_KV.put('state', payload);
      return jsonOk({ ok: true, rev: newRev }, env, request);
    } catch (e) {
      // 返回真实错误信息，方便诊断（之前只返回"保存失败"，问题被吞掉）
      const detail = (e && e.message) ? e.message : String(e);
      console.error('[state POST] 保存失败:', detail, e && e.stack);
      return jsonError('保存失败：' + detail, 400, env, request, e);
    }
  }

  return jsonError('Method not allowed', 405, env, request);
}
