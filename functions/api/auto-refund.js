// functions/api/auto-refund.js · 缺货/接码失败订单自动退款（安全加固版）
// 变更：
//   1. 必须会员本人（X-Member-Token）或管理员（X-Admin-Token）才能触发退款
//   2. 退款订单必须属于当前会员（管理员除外）
//   3. 加限流、CORS 收紧、错误脱敏
import { requireAdmin, requireMember, corsHeaders, optionsResponse, jsonError, jsonOk, rateLimit } from '../_lib/common.js';

function nowStr() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return optionsResponse(request, env);
  if (request.method !== 'GET') return jsonError('Method not allowed', 405, env, request);

  const admin = await requireAdmin(request, env);
  const member = await requireMember(request, env);
  if (!admin && !member) return jsonError('请先登录后再申请退款', 401, env, request);

  const url = new URL(request.url);
  const orderNo = url.searchParams.get('order');
  if (!orderNo) return jsonError('缺少订单号', 400, env, request);

  const rl = await rateLimit(env.YUNFAKA_KV, 'refund:' + orderNo, 3, 60000);
  if (rl.blocked) return jsonError('申请过于频繁，请稍后再试', 429, env, request);

  try {
    const raw = await env.YUNFAKA_KV.get('state');
    if (!raw) return jsonError('无数据', 404, env, request);
    const state = JSON.parse(raw);
    const db = state.db;
    const o = (db.orders || []).find(x => x.order_no === orderNo);
    if (!o) return jsonError('订单不存在', 404, env, request);

    // 会员只能退自己的订单
    if (!admin && member && o.username !== member.username) {
      return jsonError('只能申请自己订单的退款', 403, env, request);
    }

    const refundable = ['out_of_stock', 'luban_error', 'rejected'];
    if (!refundable.includes(o.status)) return jsonError('该订单状态不支持自动退款', 400, env, request);
    if (!o.balance_used || o.balance_used <= 0) return jsonError('该订单未使用余额支付，无需退款', 400, env, request);
    if (o.refunded_at) return jsonOk({ ok: true, msg: '已退款，请勿重复申请', already: true }, env, request);

    const m = (db.members || []).find(x => x.username === o.username);
    if (m) { m.balance = (m.balance || 0) + o.balance_used; }
    o.refunded_amount = o.balance_used;
    o.refunded_at = nowStr();
    o.refund_auto = true;
    o.balance_used = 0;
    if (o.status !== 'rejected') o.status = 'rejected';
    if (!Array.isArray(db.logs)) db.logs = [];
    db.logs.unshift({ time: nowStr(), action: 'auto_refund', detail: `订单 ${orderNo} 自动退款 ¥${(o.refunded_amount / 100).toFixed(2)}（${o.status}）` });
    if (db.logs.length > 500) db.logs.length = 500;
    state.rev = (state.rev || 0) + 1;
    await env.YUNFAKA_KV.put('state', JSON.stringify(state));

    try {
      const cfg = db.config || {};
      if (cfg.tg_bot_token && cfg.tg_chat_id) {
        await fetch(`https://api.telegram.org/bot${cfg.tg_bot_token}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: cfg.tg_chat_id, parse_mode: 'HTML',
            text: `自动退款\n订单号：${orderNo}\n商品：${o.product_name}\n退款：¥${(o.refunded_amount / 100).toFixed(2)}\n原因：${o.status === 'out_of_stock' ? '缺货' : o.status === 'luban_error' ? '接码失败' : '订单驳回'}`,
          }),
        });
      }
    } catch (e) {}
    return jsonOk({ ok: true, refunded: o.refunded_amount }, env, request);
  } catch (e) {
    return jsonError('退款申请失败', 500, env, request, e);
  }
}
