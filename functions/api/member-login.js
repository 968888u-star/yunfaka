// functions/api/member-login.js · 会员登录（后端校验密码，返回会员公开信息）
// POST { username, password } -> { ok, member:{username,balance,...} }
// 同时支持暗号找回密码：POST { action:'findpwd', username, secret } -> { ok }
// 重置密码：POST { action:'resetpwd', username, secret, new_password } -> { ok }
import { verifyPwd, hashPwd, needsHashUpgrade } from '../_lib/auth.js';

function nowStr() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }

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
    const raw = await env.YUNFAKA_KV.get('state');
    if (!raw) return Response.json({ ok: false, msg: '无数据' }, { headers: cors });
    const state = JSON.parse(raw);
    const db = state.db;
    const username = (body.username || '').trim();
    const m = (db.members || []).find(x => x.username === username);

    // 暗号找回密码：验证暗号
    if (body.action === 'findpwd') {
      if (!m) return Response.json({ ok: false, msg: '账号不存在' }, { headers: cors });
      if (m.secret !== (body.secret || '').trim()) return Response.json({ ok: false, msg: '暗号错误' }, { status: 401, headers: cors });
      return Response.json({ ok: true }, { headers: cors });
    }

    // 重置密码（需先通过暗号验证）
    if (body.action === 'resetpwd') {
      if (!m) return Response.json({ ok: false, msg: '账号不存在' }, { headers: cors });
      if (m.secret !== (body.secret || '').trim()) return Response.json({ ok: false, msg: '暗号错误' }, { status: 401, headers: cors });
      const np = body.new_password || '';
      if (np.length < 6) return Response.json({ ok: false, msg: '密码至少6位' }, { headers: cors });
      m.password = hashPwd(np);
      state.rev = (state.rev || 0) + 1;
      await env.YUNFAKA_KV.put('state', JSON.stringify(state));
      return Response.json({ ok: true }, { headers: cors });
    }

    // 普通登录
    if (!m) return Response.json({ ok: false, msg: '账号不存在' }, { status: 401, headers: cors });
    if (!verifyPwd(body.password || '', m.password)) {
      return Response.json({ ok: false, msg: '密码错误' }, { status: 401, headers: cors });
    }
    // 旧格式哈希自动升级到 v2 标准格式（下次登录走标准分支）
    if (needsHashUpgrade(m.password)) {
      m.password = hashPwd(body.password || '');
      state.rev = (state.rev || 0) + 1;
      await env.YUNFAKA_KV.put('state', JSON.stringify(state));
    }
    // 返回脱敏后的会员信息（不含密码/暗号）
    return Response.json({
      ok: true,
      member: { username: m.username, balance: m.balance || 0, created_at: m.created_at },
    }, { headers: cors });
  } catch (e) {
    return Response.json({ ok: false, msg: e.message }, { status: 500, headers: cors });
  }
}
