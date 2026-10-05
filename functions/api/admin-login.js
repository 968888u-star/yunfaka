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
    const storedHash = state?.db?.config?.admin_pwd_hash || '';
    // 默认密码 admin888 的 hash（首次部署未改密码时）
    const DEFAULT_HASH = ''; // 空则不允许默认密码登录，强制店主先设置
    if (!verifyPwd(password, storedHash)) {
      return Response.json({ ok: false, msg: '密码错误' }, { status: 401, headers: cors });
    }

    const exp = Math.floor(Date.now() / 1000) + 12 * 3600; // 12小时
    const token = await signToken({ sub: 'admin', exp }, getSecret(env));
    return Response.json({ ok: true, token, exp }, { headers: cors });
  } catch (e) {
    return Response.json({ ok: false, msg: e.message }, { status: 500, headers: cors });
  }
}
