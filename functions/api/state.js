// functions/api/state.js · 数据读写中枢（修复 tg_bot_token 丢失）
function sanitizeDb(db) {
  if (!db || typeof db !== 'object') return db;
  // 保留所有字段（包括 tg_bot_token），后台设置页需要显示
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
      if (token) {
        const clientToken = request.headers.get('x-access-token') || '';
        if (clientToken !== token) {
          return Response.json({ ok: false, msg: '无权限写入' }, { status: 403, headers: corsHeaders });
        }
      } else {
        const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || 'unknown';
        const rlKey = 'writerl:' + ip;
        const rlRaw = await env.YUNFAKA_KV.get(rlKey);
        const rl = rlRaw ? JSON.parse(rlRaw) : { t: Date.now(), n: 0 };
        if (Date.now() - rl.t > 10000) { rl.t = Date.now(); rl.n = 0; }
        rl.n++;
        if (rl.n > 5) {
          return Response.json({ ok: false, msg: '操作过于频繁' }, { status: 429, headers: corsHeaders });
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
        return Response.json({ ok: false, msg: '数据结构不完整' }, { status: 400, headers: corsHeaders });
      }

      const raw = await env.YUNFAKA_KV.get('state');
      const current = raw ? JSON.parse(raw) : null;
      const currentRev = (current && current.rev) || 0;

      // 乐观锁：baseRev 不匹配则返回 409（前端会自动重试）
      if (body.baseRev !== undefined && current && body.baseRev !== currentRev) {
        return Response.json(
          { ok: false, msg: '数据已被其他设备更新', rev: currentRev, db: sanitizeDb(current.db) },
          { status: 409, headers: corsHeaders }
        );
      }

      // ===== 保护敏感字段 =====
      const DEFAULT_ADMIN_HASH = 'v2:1bc7d4e0d34ee3';
      if (current && current.db && current.db.config) {
        if (!db.config) db.config = {};

        // TG Token：POST 传空或掩码 → 保留 KV 原值
        if (current.db.config.tg_bot_token) {
          const incoming = String(db.config.tg_bot_token || '');
          if (incoming === '' || /\*\*\*/.test(incoming)) {
            db.config.tg_bot_token = current.db.config.tg_bot_token;
          }
        }

        // 管理员密码：POST 传默认值 → 保留 KV 原值
        if (current.db.config.admin_pwd_hash &&
            current.db.config.admin_pwd_hash !== DEFAULT_ADMIN_HASH &&
            (!db.config.admin_pwd_hash || db.config.admin_pwd_hash === DEFAULT_ADMIN_HASH)) {
          db.config.admin_pwd_hash = current.db.config.admin_pwd_hash;
        }

        // USDT 地址：POST 传空 → 保留 KV 原值
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
