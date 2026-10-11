// functions/api/admin-login.js · 管理员登录（安全加固版）
// 变更：
//   1. 强制要求 ADMIN_SECRET，缺失拒绝服务
//   2. 登录限流：IP 维度 5 次/15 分钟，防止暴力破解
//   3. 默认密码登录成功后返回 need_change=true，前端强制改密
//   4. 旧格式 hash 验证通过后自动升级为 PBKDF2
//   5. CORS 收紧、错误信息脱敏
import { signToken, verifyPwd, getSecret, hashPwd, needsHashUpgrade, LEGACY_DEFAULT_ADMIN_HASH } from '../_lib/auth.js';
import { corsHeaders, optionsResponse, jsonError, jsonOk, rateLimit, getClientIp } from '../_lib/common.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return optionsResponse(request, env);
  if (request.method !== 'POST') return jsonError('Method not allowed', 405, env, request);

  // 强制要求 ADMIN_SECRET
  const secret = getSecret(env);
  if (!secret) return jsonError('服务器未配置 ADMIN_SECRET，已拒绝登录。请在 Pages 环境变量中设置后重试。', 503, env, request);

  try {
    // 登录限流（IP 维度，5 次/15 分钟）
    const ip = getClientIp(request);
    const rl = await rateLimit(env.YUNFAKA_KV, 'login:admin:' + ip, 5, 15 * 60 * 1000);
    if (rl.blocked) return jsonError(`尝试次数过多，请 ${rl.retryAfter} 秒后再试`, 429, env, request);

    const body = await request.json();
    const password = body.password || '';
    if (!password) return jsonError('请输入密码', 400, env, request);

    const raw = await env.YUNFAKA_KV.get('state');
    const state = raw ? JSON.parse(raw) : null;
    const storedHash = state?.db?.config?.admin_pwd_hash || LEGACY_DEFAULT_ADMIN_HASH;
    const isDefault = !state?.db?.config?.admin_pwd_hash || storedHash === LEGACY_DEFAULT_ADMIN_HASH;

    const { ok, needUpgrade } = await verifyPwd(password, storedHash);
    if (!ok) return jsonError('密码错误', 401, env, request);

    // 登录成功：补写/升级 hash
    let changed = false;
    if (state && state.db && state.db.config) {
      if (!state.db.config.admin_pwd_hash) { state.db.config.admin_pwd_hash = storedHash; changed = true; }
      if (needUpgrade || needsHashUpgrade(state.db.config.admin_pwd_hash)) {
        state.db.config.admin_pwd_hash = await hashPwd(password);
        changed = true;
      }
      if (changed) {
        state.rev = (state.rev || 0) + 1;
        await env.YUNFAKA_KV.put('state', JSON.stringify(state));
      }
    }

    const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
    const token = await signToken({ sub: 'admin', exp }, secret);
    return jsonOk({ ok: true, token, exp, need_change: isDefault }, env, request);
  } catch (e) {
    return jsonError('登录失败', 500, env, request, e);
  }
}
