// functions/api/sms-config.js · 接码页面配置（安全修复版：仅管理员可写）
import { requireAdmin, optionsResponse, jsonError, jsonOk, corsHeaders } from '../_lib/common.js';

export async function onRequest(context) {
  const { request, env } = context;
  const kv = env.YUNFAKA_KV || env.KV || env.YF_KV || env.yunfaka;
  if (!kv) return new Response(JSON.stringify({ error: '未找到 KV 绑定' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  if (request.method === 'OPTIONS') return optionsResponse(request, env);
  if (request.method === 'GET') {
    try { const data = await kv.get('sms_config'); return new Response(data || '{}', { headers: corsHeaders(request, env) }); }
    catch (e) { return jsonError('读取失败', 500, env, request, e); }
  }
  if (request.method === 'POST') {
    const admin = await requireAdmin(request, env);
    if (!admin) return jsonError('请先登录管理后台', 401, env, request);
    try {
      const body = await request.json();
      const newConfig = { sub: String(body.sub || '选择国家和平台，实时接码，全自动发货').slice(0, 200), luban: typeof body.luban === 'boolean' ? body.luban : true };
      await kv.put('sms_config', JSON.stringify(newConfig));
      return jsonOk({ success: true, data: newConfig }, env, request);
    } catch (e) { return jsonError('保存失败', 500, env, request, e); }
  }
  return jsonError('Method Not Allowed', 405, env, request);
}
