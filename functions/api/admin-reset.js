// functions/api/admin-reset.js · 管理员密码应急重置端点
// 用途：当 KV 中 admin_pwd_hash 损坏（历史 bug 写入 [object Promise]）导致无法登录时，
//       访问此端点清除 admin_config，恢复默认密码 admin888。
// 用法：GET /api/admin-reset?key=<重置密钥>
// 密钥：优先取环境变量 ADMIN_RESET_KEY，未设置则用内置默认值 yunfaka-reset-2026
import { optionsResponse, jsonError, jsonOk } from '../_lib/common.js';
import { ADMIN_CONFIG_KEY } from '../_lib/admin-config.js';

const DEFAULT_RESET_KEY = 'yunfaka-reset-2026';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return optionsResponse(request, env);
  if (request.method !== 'GET') return jsonError('Method not allowed', 405, env, request);

  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';
  const expected = env.ADMIN_RESET_KEY || DEFAULT_RESET_KEY;

  if (!key || key !== expected) {
    return jsonError('重置密钥错误', 403, env, request);
  }

  try {
    // 清除独立 KV 中的 admin_config（含损坏的 admin_pwd_hash）
    await env.YUNFAKA_KV.delete(ADMIN_CONFIG_KEY);
    return jsonOk({
      ok: true,
      msg: '管理员密码已重置为默认密码 admin888，请立即登录并在设置中修改密码',
      default_password: 'admin888'
    }, env, request);
  } catch (e) {
    return jsonError('重置失败', 500, env, request, e);
  }
}
