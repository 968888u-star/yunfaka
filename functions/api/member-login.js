// functions/api/member-login.js · 会员登录/找回密码（安全加固版）
// 变更：
//   1. 暗号改为 PBKDF2 哈希存储验证，兼容旧明文（验证通过自动升级）
//   2. 登录 + 找回密码均加限流（IP+用户名维度）
//   3. 密码 hash 旧格式自动升级为 PBKDF2
//   4. 登录成功签发会员 token（X-Member-Token），用于 auto-refund 等会员接口鉴权
//   5. CORS 收紧、错误脱敏、用户名枚举防护（账号不存在/密码错误返回统一提示）
import { verifyPwd, hashPwd, needsHashUpgrade, verifySecret, hashSecret, signToken, getSecret } from '../_lib/auth.js';
import { corsHeaders, optionsResponse, jsonError, jsonOk, rateLimit, getClientIp } from '../_lib/common.js';

function nowStr() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
const GENERIC_MSG = '账号或密码错误'; // 防用户名枚举

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return optionsResponse(request, env);
  if (request.method !== 'POST') return jsonError('Method not allowed', 405, env, request);

  const secret = getSecret(env);
  try {
    const body = await request.json();
    const username = (body.username || '').trim();
    if (!username) return jsonError('请输入账号', 400, env, request);
    const ip = getClientIp(request);

    const raw = await env.YUNFAKA_KV.get('state');
    if (!raw) return jsonError('无数据', 404, env, request);
    const state = JSON.parse(raw);
    const db = state.db;
    const m = (db.members || []).find(x => x.username === username);

    // ========== 暗号找回密码（加限流） ==========
    if (body.action === 'findpwd' || body.action === 'resetpwd') {
      const rl = await rateLimit(env.YUNFAKA_KV, `findpwd:${ip}:${username}`, 5, 15 * 60 * 1000);
      if (rl.blocked) return jsonError(`尝试次数过多，请 ${rl.retryAfter} 秒后再试`, 429, env, request);
      if (!m) return jsonError('账号不存在或暗号错误', 401, env, request); // 统一提示防枚举
      const { ok: secOk, needUpgrade: secNeedUp } = await verifySecret(body.secret || '', m.secret);
      if (!secOk) return jsonError('账号不存在或暗号错误', 401, env, request);
      if (body.action === 'findpwd') {
        return jsonOk({ ok: true }, env, request);
      }
      // resetpwd
      const np = body.new_password || '';
      if (np.length < 6) return jsonError('密码至少6位', 400, env, request);
      m.password = await hashPwd(np);
      if (secNeedUp) m.secret = await hashSecret(body.secret || '');
      state.rev = (state.rev || 0) + 1;
      await env.YUNFAKA_KV.put('state', JSON.stringify(state));
      return jsonOk({ ok: true }, env, request);
    }

    // ========== 普通登录（加限流） ==========
    const rl = await rateLimit(env.YUNFAKA_KV, `login:${ip}:${username}`, 8, 15 * 60 * 1000);
    if (rl.blocked) return jsonError(`尝试次数过多，请 ${rl.retryAfter} 秒后再试`, 429, env, request);

    if (!m) return jsonError(GENERIC_MSG, 401, env, request);
    const { ok, needUpgrade } = await verifyPwd(body.password || '', m.password);
    if (!ok) return jsonError(GENERIC_MSG, 401, env, request);

    let changed = false;
    if (needUpgrade || needsHashUpgrade(m.password)) {
      m.password = await hashPwd(body.password || '');
      changed = true;
    }
    // 暗号明文自动升级
    if (m.secret && !String(m.secret).startsWith('pbkdf2$')) {
      m.secret = await hashSecret(m.secret);
      changed = true;
    }
    if (changed) {
      state.rev = (state.rev || 0) + 1;
      await env.YUNFAKA_KV.put('state', JSON.stringify(state));
    }

    // 签发会员 token（7 天有效）
    let memberToken = null;
    if (secret) {
      const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
      memberToken = await signToken({ sub: 'member', username: m.username, exp }, secret);
    }

    return jsonOk({
      ok: true,
      member: { username: m.username, balance: m.balance || 0, created_at: m.created_at },
      token: memberToken,
    }, env, request);
  } catch (e) {
    return jsonError('登录失败', 500, env, request, e);
  }
}
