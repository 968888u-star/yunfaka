// functions/api/admin-login.js · 管理员登录（后端校验密码，签发 session token）
// POST { password } -> { ok, token }  （token 有效期 12 小时，后续调 /api/admin-action 携带）
import { signToken, verifyPwd, getSecret } from '../_lib/auth.js';

export async function onRequest(context) {
  const { request, env } = context;
  const cors = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return Response.json({ ok: false, msg: 'Method not allowed' }, { status: 405, headers: cors });

  try {
    const body = await request.json();
    const password = body.password || '';
    if (!password) return Response.json({ ok: false, msg: '请输入密码' }, { headers: cors });

    const raw = await env.YUNFAKA_KV.get('state');
    const state = raw ? JSON.parse(raw) : null;
    // ⭐ fallback：KV 里可能未存 admin_pwd_hash（老用户从未保存过设置），
    // 此时使用默认密码 admin888 的 hash（与前端 DEFAULT_CONFIG 一致）
    const DEFAULT_ADMIN_HASH = 'v2:1bc7d4e0d34ee3'; // hashPwd('admin888')
    const storedHash = state?.db?.config?.admin_pwd_hash || DEFAULT_ADMIN_HASH;
    if (!verifyPwd(password, storedHash)) {
      return Response.json({ ok: false, msg: '密码错误' }, { status: 401, headers: cors });
    }
    // 登录成功：若 KV 里缺失 admin_pwd_hash，补写回去，避免后续被前端覆盖
    if (state && state.db && state.db.config && !state.db.config.admin_pwd_hash) {
      state.db.config.admin_pwd_hash = storedHash;
      state.rev = (state.rev || 0) + 1;
      await env.YUNFAKA_KV.put('state', JSON.stringify(state));
    }

    const exp = Math.floor(Date.now() / 1000) + 12 * 3600; // 12小时
    const token = await signToken({ sub: 'admin', exp }, getSecret(env));
    return Response.json({ ok: true, token, exp }, { headers: cors });
  } catch (e) {
    return Response.json({ ok: false, msg: e.message }, { status: 500, headers: cors });
  }
}
