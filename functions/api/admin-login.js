// functions/api/admin-login.js · 管理员登录（安全修复版：恢复登录限流）
import { signToken, verifyPwd, getSecret, hashPwd, needsHashUpgrade, isHashRecognizable, LEGACY_DEFAULT_ADMIN_HASH } from '../_lib/auth.js';
import { readAdminConfig, writeAdminConfig } from '../_lib/admin-config.js';
import { optionsResponse, jsonError, jsonOk, rateLimit, getClientIp } from '../_lib/common.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return optionsResponse(request, env);
  if (request.method !== 'POST') return jsonError('Method not allowed', 405, env, request);
  const secret = getSecret(env);
  if (!secret) return jsonError('服务器未配置 ADMIN_SECRET，请到 Cloudflare 环境变量中添加', 503, env, request);
  try {
    // ⭐ 恢复登录限流：单 IP 10次/5分钟（防暴力破解）
    const ip = getClientIp(request);
    const rl = await rateLimit(env.YUNFAKA_KV, 'adminlogin:' + ip, 10, 300000);
    if (rl.blocked) return jsonError(`尝试次数过多，请 ${rl.retryAfter} 秒后再试`, 429, env, request);

    const body = await request.json();
    const password = body.password || '';
    if (!password) return jsonError('请输入密码', 400, env, request);
    const ac = await readAdminConfig(env);
    let storedHash = (ac && ac.admin_pwd_hash) || LEGACY_DEFAULT_ADMIN_HASH;
    if (ac && ac.admin_pwd_hash && !isHashRecognizable(ac.admin_pwd_hash)) {
      console.warn('[admin-login] 检测到损坏的 admin_pwd_hash，已回退到默认密码');
      storedHash = LEGACY_DEFAULT_ADMIN_HASH;
    }
    const isDefault = !ac || !ac.admin_pwd_hash || storedHash === LEGACY_DEFAULT_ADMIN_HASH;
    const { ok, needUpgrade } = await verifyPwd(password, storedHash);
    if (!ok) return jsonError('密码错误', 401, env, request);
    if (!ac || needUpgrade || needsHashUpgrade(storedHash)) {
      const newHash = await hashPwd(password);
      await writeAdminConfig(env, { ...(ac || {}), admin_pwd_hash: newHash });
    }
    const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
    const token = await signToken({ sub: 'admin', exp }, secret);
    return jsonOk({ ok: true, token, exp, need_change: isDefault }, env, request);
  } catch (e) { return jsonError('登录失败', 500, env, request, e); }
}
