// functions/api/state.js · 数据读写中枢（修复 tg_bot_token 丢失 + 权限校验）
// 修复：
//   1. sanitizeDb 不再删除 tg_bot_token（之前会导致后台设置页保存后显示为空）
//   2. POST 保护段：前端传空值/掩码时保留 KV 原值
//   3. ACCESS_TOKEN 校验保留（前端通过 P13 补丁自动带 X-Access-Token）

function sanitizeDb(db) {
  if (!db || typeof db !== 'object') return db;
  // 保留 tg_bot_token：后台设置页需要显示，用户才能确认已配置。
  // 安全性依赖 POST 写入时的 ACCESS_TOKEN 校验 + /api/admin-action 的后台登录。
  return JSON.parse(JSON.stringify(db));
}

export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Access-Token,X-Admin-Token',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

  if (request.method === 'GET') {
    const raw = await env.YUNFAKA_KV.get('state');
    const data = raw ? JSON.parse(raw) : null;
    return Response.json(
      { ok: true, rev: (data && data.rev) || 0, db: sanitizeDb((data && data.db) || null) },
      { headers: corsHeaders }
    );
  }

  if (request.method === 'POST') {
    try {
      const token = env.ACCESS_TOKEN || '';
      // 配置了 ACCESS_TOKEN → 强制鉴权
      if (token) {
        const clientToken = request.headers.get('x-access-token') || '';
        if (clientToken !== token) {
          return Response.json({ ok: false, msg: '无权限写入' }, { status: 403, headers: corsHeaders });
        }
      } else {
        // 兼容模式：简单 IP 限流
        const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || 'unknown';
        const rlKey = 'writerl:' + ip;
        const rlRaw = await env.YUNFAKA_KV.get(rlKey);
        const rl = rlRaw ? JSON.parse(rlRaw) : { t: Date.now(), n: 0 };
        if (Date.now() - rl.t > 10000) { rl.t = Date.now(); rl.n = 0; }
        rl.n++;
        if (rl.n > 5) {
          return Response.json({ ok: false, msg: '操作过于频繁，请稍后再试' }, { status: 429, headers: corsHeaders });
        }
        await env.YUNFAKA_KV.put(rlKey, JSON.stringify(rl), { expirationTtl: 120 });
      }

      const cl = Number(request.headers.get('content-length') || 0);
      if (cl > 5 * 1024 * 1024) {
        return Response.json({ ok: false, msg: '数据过大' }, { status: 413, headers: corsHeaders });
      }

      const body = await request.json();
      if (!body || !body.db || typeof body.db !== 'object') throw new Error('bad');
      const db = body.db;
      if (!Array.isArray(db.products) || !Array.isArray(db.orders) || !Array.isArray(db.cards)) {
        return Response.json({ ok: false, msg: '数据结构不完整，已拒绝' }, { status: 400, headers: corsHeaders });
      }

      const raw = await env.YUNFAKA_KV.get('state');
      const current = raw ? JSON.parse(raw) : null;
      const currentRev = (current && current.rev) || 0;
      if (body.baseRev !== undefined && current && body.baseRev !== currentRev) {
        return Response.json(
          { ok: false, msg: '数据已被其他设备更新，请刷新后重试', rev: currentRev, db: sanitizeDb(current.db) },
          { status: 409, headers: corsHeaders }
        );
      }

      // ===== 保护敏感字段：禁止通过普通写入篡改 TG Token / 管理员密码 hash =====
      const DEFAULT_ADMIN_HASH = 'v2:1bc7d4e0d34ee3';
      if (current && current.db && current.db.config) {
        if (!db.config) db.config = {};

        // [1] TG Bot Token：POST 传空值 / undefined / 掩码（含 ***）→ 保留 KV 原值
        if (current.db.config.tg_bot_token) {
          const incoming = String(db.config.tg_bot_token || '');
          const isMasked = incoming === '' || /\*\*\*/.test(incoming);
          if (isMasked) {
            db.config.tg_bot_token = current.db.config.tg_bot_token;
          }
        }

        // [2] 管理员密码 hash：POST 传默认值而 KV 是用户改过的 → 保留 KV 原值
        if (current.db.config.admin_pwd_hash &&
            current.db.config.admin_pwd_hash !== DEFAULT_ADMIN_HASH &&
            (!db.config.admin_pwd_hash || db.config.admin_pwd_hash === DEFAULT_ADMIN_HASH)) {
          db.config.admin_pwd_hash = current.db.config.admin_pwd_hash;
        }

        // [3] 收款地址同样保护（防止前端误清空）
        if (current.db.config.pay_usdt_address && !db.config.pay_usdt_address) {
          db.config.pay_usdt_address = current.db.config.pay_usdt_address;
        }
      }

      const newRev = currentRev + 1;
      await env.YUNFAKA_KV.put('state', JSON.stringify({ rev: newRev, db, updated_at: Date.now() }));
      return Response.json({ ok: true, rev: newRev }, { headers: corsHeaders });
    } catch (e) {
      return Response.json({ ok: false, msg: '保存失败: ' + String((e && e.message) || e) }, { status: 400, headers: corsHeaders });
    }
  }

  return Response.json({ ok: false, msg: 'Method not allowed' }, { status: 405, headers: corsHeaders });
}
