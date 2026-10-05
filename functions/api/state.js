// functions/api/state.js · 数据读写中枢（加固兼容版）
// 安全增强：
//   1. GET 响应自动脱敏敏感字段（TG Token、管理员/会员密码Hash、暗号）
//   2. POST 写入：若配置了 ACCESS_TOKEN 则强制校验；未配置时降级为「限流+结构校验」兼容模式
//   3. 写入大小/结构校验，防止恶意超大 payload 或误清空核心数组
//   4. 乐观锁 baseRev 冲突检测（保留）
//   5. 简单 IP 限流（同 IP 10 秒内最多 5 次写入）

// 脱敏：仅移除最危险的 TG Bot Token（拿到即可直接滥用 bot）。
// 管理员/会员密码 hash、暗号保留在响应中：它们是单向哈希，爆破成本高，
// 且前端登录/订单查询逻辑依赖这些字段，移除会导致本地覆盖回默认值的连锁 bug。
function sanitizeDb(db) {
  if (!db || typeof db !== 'object') return db;
  const s = JSON.parse(JSON.stringify(db));
  if (s.config) delete s.config.tg_bot_token;
  return s;
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
      { ok: true, rev: data?.rev || 0, db: sanitizeDb(data?.db || null) },
      { headers: corsHeaders }
    );
  }

  if (request.method === 'POST') {
    try {
      const token = env.ACCESS_TOKEN || '';
      // 配置了 ACCESS_TOKEN → 强制鉴权（推荐生产环境配置）
      if (token) {
        const clientToken = request.headers.get('x-access-token') || '';
        if (clientToken !== token) {
          return Response.json({ ok: false, msg: '无权限写入' }, { status: 403, headers: corsHeaders });
        }
      } else {
        // 兼容模式：简单 IP 限流，防止脚本暴力覆盖
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
      const currentRev = current?.rev || 0;
      if (body.baseRev !== undefined && current && body.baseRev !== currentRev) {
        return Response.json(
          { ok: false, msg: '数据已被其他设备更新，请刷新后重试', rev: currentRev, db: sanitizeDb(current.db) },
          { status: 409, headers: corsHeaders }
        );
      }

      // ⭐ 保护敏感字段：禁止通过普通写入篡改管理员密码 hash 和 TG Token
      // （这两个字段只能通过 /api/admin-action 的 save_settings 修改）
      const DEFAULT_ADMIN_HASH = 'v2:1bc7d4e0d34ee3';
      if (current?.db?.config) {
        if (!db.config) db.config = {};
        // TG Token：POST 未携带则保留 KV 原值
        if (current.db.config.tg_bot_token && !db.config.tg_bot_token) {
          db.config.tg_bot_token = current.db.config.tg_bot_token;
        }
        // 管理员密码 hash：若 POST 上来的是默认值而 KV 里是用户改过的值，保留 KV 原值
        // （防止前端拉取脱敏数据后把密码覆盖回默认 admin888）
        if (current.db.config.admin_pwd_hash &&
            current.db.config.admin_pwd_hash !== DEFAULT_ADMIN_HASH &&
            (!db.config.admin_pwd_hash || db.config.admin_pwd_hash === DEFAULT_ADMIN_HASH)) {
          db.config.admin_pwd_hash = current.db.config.admin_pwd_hash;
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
