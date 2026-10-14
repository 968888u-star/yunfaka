// functions/api/tg-notify.js（安全修复版：加限流防骚扰）
import { optionsResponse, jsonError, jsonOk, rateLimit, getClientIp } from '../_lib/common.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return optionsResponse(request, env);
  if (request.method !== 'POST') return jsonError('Method not allowed', 405, env, request);
  const ip = getClientIp(request);
  const rl = await rateLimit(env.YUNFAKA_KV, 'tgnotify:' + ip, 5, 60000);
  if (rl.blocked) return jsonError('通知过于频繁', 429, env, request);
  try {
    const body = await request.json();
    const orderNo = body.order_no;
    if (!orderNo) return jsonError('缺少订单号', 400, env, request);
    const raw = await env.YUNFAKA_KV.get('state');
    if (!raw) return jsonError('无数据', 404, env, request);
    const state = JSON.parse(raw);
    const cfg = (state.db && state.db.config) || {};
    if (!cfg.tg_bot_token || !cfg.tg_chat_id) return jsonError('未配置 TG Bot Token 或 Chat ID', 400, env, request);
    const order = (state.db.orders || []).find(o => o.order_no === orderNo);
    if (!order) return jsonError('订单不存在', 404, env, request);
    const amount = (order.amount_due / 100).toFixed(2);
    const payName = order.pay_method === 'alipay' ? '支付宝口令红包' : (order.pay_method === 'usdt' ? 'USDT' : '余额');
    const skuLine = order.sku_name ? `\n规格：${order.sku_name}` : '';
    const rpLine = order.redpacket_code ? `\n红包口令：<code>${order.redpacket_code}</code>` : '';
    const text = `🔔 <b>新订单待审核</b>\n\n订单号：<code>${order.order_no}</code>\n商品：${order.product_name}${skuLine}\n数量：${order.quantity}\n金额：¥${amount}\n支付：${payName}${rpLine}\n暗号：${order.secret || '-'}\n时间：${order.created_at}\n\n👉 请到后台「待审核」页面处理`;
    const r = await fetch(`https://api.telegram.org/bot${cfg.tg_bot_token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: cfg.tg_chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true }) });
    const d = await r.json();
    if (!d.ok) return jsonError(d.description || 'TG 发送失败', 400, env, request);
    return jsonOk({ ok: true }, env, request);
  } catch (e) { return jsonError('操作失败，请稍后重试', 500, env, request, e); }
}
