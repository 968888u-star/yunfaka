// functions/api/admin-login.js · 管理员登录（修复版 v3）
// 关键改动：
//   1. 使用修复后的 auth.js（明文兜底 + PBKDF2）
//   2. 登录成功时 await hashPwd()，确保写入正确的 PBKDF2 而不是 Promise
//   3. 从 admin_config 独立 KV 读密码 hash
import {
  signToken, verifyPwd, getSecret, hashPwd,
  needsHashUpgrade, isHashRecognizable, LEGACY_DEFAULT_ADMIN_HASH
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
    // 登录限流已取消（用户要求）：不再限制密码尝试次数
    const ip = getClientIp(request);

    const body = await request.json();
    const password = body.password || '';
    if (!password) return jsonError('请输入密码', 400, env, request);

    // 从独立 KV 读 hash
    const ac = await readAdminConfig(env);
    let storedHash = (ac && ac.admin_pwd_hash) || LEGACY_DEFAULT_ADMIN_HASH;
    // ⭐ 损坏 hash 兜底：历史 bug 把 "[object Promise]" 写进了 KV，导致任何密码都失败
    // 检测到不可识别的 hash 时，回退到默认密码 admin888，登录成功后自动覆盖为正确 PBKDF2
    if (ac && ac.admin_pwd_hash && !isHashRecognizable(ac.admin_pwd_hash)) {
      console.warn('[admin-login] 检测到损坏的 admin_pwd_hash，已回退到默认密码:', String(ac.admin_pwd_hash).slice(0, 40));
      storedHash = LEGACY_DEFAULT_ADMIN_HASH;
    }
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
