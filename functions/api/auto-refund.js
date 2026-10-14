// functions/api/auto-refund.js · 自动退款（安全修复版：加乐观锁防重复退款）
import { requireAdmin, requireMember, optionsResponse, jsonError, jsonOk, rateLimit } from '../_lib/common.js';
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
  if (rl.blocked) return jsonError('申请过于频繁，请稍后重试', 429, env, request);
  try {
    // ⭐ 乐观锁：读取时记录 rev，写入前重新校验
    const raw = await env.YUNFAKA_KV.get('state');
    if (!raw) return jsonError('无数据', 404, env, request);
    const state = JSON.parse(raw);
    const baseRev = state.rev || 0;
    const db = state.db;
    const o = (db.orders || []).find(x => x.order_no === orderNo);
    if (!o) return jsonError('订单不存在', 404, env, request);
    if (!admin && member && o.username !== member.username) return jsonError('只能申请自己订单的退款', 403, env, request);
    const refundable = ['out_of_stock', 'luban_error', 'rejected'];
    if (!refundable.includes(o.status)) return jsonError('该订单状态不支持自动退款', 400, env, request);
    if (!o.balance_used || o.balance_used <= 0) return jsonError('该订单未使用余额支付，USDT/支付宝部分请联系店主人工退款', 400, env, request);
    if (o.refunded_at) return jsonOk({ ok: true, msg: '已退款，请勿重复申请', already: true }, env, request);

    // ⭐ 写入前重新读 KV，校验 rev 未变 + refunded_at 仍为空
    const raw2 = await env.YUNFAKA_KV.get('state');
    const s2 = raw2 ? JSON.parse(raw2) : state;
    if ((s2.rev || 0) !== baseRev) {
      const o2 = (s2.db.orders || []).find(x => x.order_no === orderNo);
      if (o2 && o2.refunded_at) return jsonOk({ ok: true, msg: '已退款，请勿重复申请', already: true }, env, request);
      return jsonError('数据已被更新，请重试', 409, env, request);
    }
    const o2 = (s2.db.orders || []).find(x => x.order_no === orderNo);
    if (!o2 || o2.refunded_at) return jsonOk({ ok: true, msg: '已退款，请勿重复申请', already: true }, env, request);

    const m = (s2.db.members || []).find(x => x.username === o2.username);
    if (m) { m.balance = (m.balance || 0) + o2.balance_used; }
    o2.refunded_amount = o2.balance_used;
    o2.refunded_at = nowStr();
    o2.refund_auto = true;
    o2.balance_used = 0;
    if (o2.status !== 'rejected') o2.status = 'rejected';
    if (!Array.isArray(s2.db.logs)) s2.db.logs = [];
    s2.db.logs.unshift({ time: nowStr(), action: 'auto_refund', detail: `订单 ${orderNo} 自动退款 ¥${(o2.refunded_amount/100).toFixed(2)}` });
    if (s2.db.logs.length > 500) s2.db.logs.length = 500;
    s2.rev = (s2.rev || 0) + 1;
    await env.YUNFAKA_KV.put('state', JSON.stringify(s2));
    try {
      const cfg = s2.db.config || {};
      if (cfg.tg_bot_token && cfg.tg_chat_id) {
        await fetch(`https://api.telegram.org/bot${cfg.tg_bot_token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: cfg.tg_chat_id, parse_mode: 'HTML', text: `自动退款\n订单号：${orderNo}\n商品：${o2.product_name}\n退款：¥${(o2.refunded_amount/100).toFixed(2)}` }) });
      }
    } catch (e) {}
    return jsonOk({ ok: true, refunded: o2.refunded_amount }, env, request);
  } catch (e) { return jsonError('退款申请失败', 500, env, request, e); }
}
