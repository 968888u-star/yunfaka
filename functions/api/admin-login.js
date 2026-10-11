// functions/api/admin-login.js · 管理员登录（独立 KV 版）
// 关键改动：admin_pwd_hash 从 state.db.config 改到 admin_config 独立 KV
import {
  signToken, verifyPwd, getSecret, hashPwd,
  needsHashUpgrade, LEGACY_DEFAULT_ADMIN_HASH
} from '../_lib/auth.js';
import { readAdminConfig, writeAdminConfig } from '../_lib/admin-config.js';
import { optionsResponse, jsonError, jsonOk, rateLimit, getClientIp } from '../_lib/common.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return optionsResponse(request, env);
  if (request.method !== 'POST') return jsonError('Method not allowed', 405, env, request);

  const secret = getSecret(env);

  try {
    const ip = getClientIp(request);
    const rl = await rateLimit(env.YUNFAKA_KV, 'login:admin:' + ip, 5, 15 * 60 * 1000);
    if (rl.blocked) return jsonError(`尝试次数过多，请 ${rl.retryAfter} 秒后再试`, 429, env, request);

    const body = await request.json();
    const password = body.password || '';
    if (!password) return jsonError('请输入密码', 400, env, request);

    const ac = await readAdminConfig(env);
    const storedHash = (ac && ac.admin_pwd_hash) || LEGACY_DEFAULT_ADMIN_HASH;
    const isDefault = !ac || !ac.admin_pwd_hash || storedHash === LEGACY_DEFAULT_ADMIN_HASH;

    const { ok, needUpgrade } = verifyPwd(password, storedHash);
    if (!ok) return jsonError('密码错误', 401, env, request);

    // 登录成功：写入或升级 hash（只写独立 KV）
    if (!ac || needUpgrade || needsHashUpgrade(storedHash)) {
      await writeAdminConfig(env, {
        ...(ac || {}),
        admin_pwd_hash: hashPwd(password)
      });
    }

    const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
    const token = await signToken({ sub: 'admin', exp }, secret);
    return jsonOk({ ok: true, token, exp, need_change: isDefault }, env, request);
  } catch (e) {
    return jsonError('登录失败', 500, env, request, e);
  }
}
