// functions/api/tg-send.js · Telegram 消息发送代理（安全修复版：仅管理员/会员可调用）
import { requireAdmin, requireMember, optionsResponse, jsonError, jsonOk } from '../_lib/common.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return optionsResponse(request, env);
  if (request.method !== 'POST') return jsonError('Method not allowed', 405, env, request);
  const admin = await requireAdmin(request, env);
  const member = await requireMember(request, env);
  if (!admin && !member) return jsonError('请先登录', 401, env, request);
  try {
    const body = await request.json();
    const text = String(body.text || '').trim().slice(0, 2000);
    if (!text) return jsonError('缺少消息内容', 400, env, request);
    const raw = await env.YUNFAKA_KV.get('state');
    if (!raw) return jsonError('无数据', 404, env, request);
    const state = JSON.parse(raw);
    const cfg = (state.db && state.db.config) || {};
    const botToken = cfg.tg_bot_token || env.TG_BOT_TOKEN || '';
    if (!botToken) return jsonError('未配置 TG Bot Token', 400, env, request);
    let chatId = '';
    if (admin) {
      chatId = body.chat_id || cfg.tg_chat_id || '';
      if (body.type === 'customer' && body.order_no) {
        const order = (state.db.orders || []).find(o => o.order_no === body.order_no);
        if (order && order.customer_tg_id) chatId = order.customer_tg_id;
      }
    } else {
      chatId = cfg.tg_chat_id || '';
    }
    if (!chatId) return jsonError('未指定接收方', 400, env, request);
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }) });
    const d = await r.json();
    if (!d.ok) return jsonError(d.description || 'TG 发送失败', 400, env, request);
    return jsonOk({ ok: true }, env, request);
  } catch (e) { return jsonError('操作失败，请稍后重试', 500, env, request, e); }
}
