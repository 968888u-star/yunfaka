// functions/api/admin-reset.js · 管理员密码应急重置端点（安全修复版）
// 安全修复：删除硬编码默认密钥，未配置 ADMIN_RESET_KEY 时直接拒绝服务
import { optionsResponse, jsonError, jsonOk } from '../_lib/common.js';
import { ADMIN_CONFIG_KEY } from '../_lib/admin-config.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return optionsResponse(request, env);
  if (request.method !== 'GET') return jsonError('Method not allowed', 405, env, request);
  const expected = env.ADMIN_RESET_KEY || '';
  if (!expected) {
    return jsonError('重置端点未启用（请配置 ADMIN_RESET_KEY 环境变量）', 503, env, request);
  }
  const url = new URL(request.url);
  const key = request.headers.get('x-reset-key') || url.searchParams.get('key') || '';
  if (!key || key !== expected) return jsonError('重置密钥错误', 403, env, request);
  try {
    await env.YUNFAKA_KV.delete(ADMIN_CONFIG_KEY);
    return jsonOk({ ok: true, msg: '管理员密码已重置为默认密码 admin888，请立即登录并修改', default_password: 'admin888' }, env, request);
  } catch (e) { return jsonError('重置失败', 500, env, request, e); }
}
