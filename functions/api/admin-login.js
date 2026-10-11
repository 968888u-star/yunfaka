// functions/api/admin-login.js · 管理员登录（修复版 v3）
// 关键改动：
//   1. 使用修复后的 auth.js（明文兜底 + PBKDF2）
//   2. 登录成功时 await hashPwd()，确保写入正确的 PBKDF2 而不是 Promise
//   3. 从 admin_config 独立 KV 读密码 hash
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
  if (!secret) {
    return jsonError('服务器未配置 ADMIN_SECRET，请到 Cloudflare 环境变量中添加', 503, env, request);
  }

  try {
    // 登录限流：IP 维度 5 次/15 分钟
    const ip = getClientIp(request);
    const rl = await rateLimit(env.YUNFAKA_KV, 'login:admin:' + ip, 5, 15 * 60 * 1000);
    if (rl.blocked) {
      return jsonError(`尝试次数过多，请 ${rl.retryAfter} 秒后再试`, 429, env, request);
    }

    const body = await request.json();
    const password = body.password || '';
    if (!password) return jsonError('请输入密码', 400, env, request);

    // 从独立 KV 读 hash
    const ac = await readAdminConfig(env);
    const storedHash = (ac && ac.admin_pwd_hash) || LEGACY_DEFAULT_ADMIN_HASH;
    const isDefault = !ac || !ac.admin_pwd_hash || storedHash === LEGACY_DEFAULT_ADMIN_HASH;

    // 校验密码
    const { ok, needUpgrade } = await verifyPwd(password, storedHash);
    if (!ok) return jsonError('密码错误', 401, env, request);

    // 登录成功：写入 / 升级 hash
    if (!ac || needUpgrade || needsHashUpgrade(storedHash)) {
      const newHash = await hashPwd(password); // ⭐ 必须 await
      await writeAdminConfig(env, {
        ...(ac || {}),
        admin_pwd_hash: newHash
      });
    }

    // 签发 token
    const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
    const token = await signToken({ sub: 'admin', exp }, secret);

    return jsonOk({
      ok: true,
      token,
      exp,
      need_change: isDefault
    }, env, request);
  } catch (e) {
    return jsonError('登录失败', 500, env, request, e);
  }
}
