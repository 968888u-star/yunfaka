// functions/api/auto-refund.js · 缺货/接码失败订单自动退款（公开接口，仅能退款，安全）
// GET ?order=xxx  →  校验订单状态为 out_of_stock / luban_error / rejected 且有未退余额，自动退回
import { verifyToken, getSecret } from '../_lib/auth.js';

function nowStr() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }

export async function onRequest(context) {
  const { request, env } = context;
  const cors = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const url = new URL(request.url);
  const orderNo = url.searchParams.get('order');
  if (!orderNo) return Response.json({ ok: false, msg: '缺少订单号' }, { headers: cors });

  try {
    const raw = await env.YUNFAKA_KV.get('state');
    if (!raw) return Response.json({ ok: false, msg: '无数据' }, { headers: cors });
    const state = JSON.parse(raw);
    const db = state.db;
    const o = (db.orders || []).find(x => x.order_no === orderNo);
    if (!o) return Response.json({ ok: false, msg: '订单不存在' }, { headers: cors });

    // 仅允许以下可退款状态，且必须使用了余额支付
    const refundable = ['out_of_stock', 'luban_error', 'rejected'];
    if (!refundable.includes(o.status)) {
      return Response.json({ ok: false, msg: '该订单状态不支持自动退款' }, { headers: cors });
    }
    if (!o.balance_used || o.balance_used <= 0) {
      return Response.json({ ok: false, msg: '该订单未使用余额支付，无需退款' }, { headers: cors });
    }
    if (o.refunded_at) {
      return Response.json({ ok: true, msg: '已退款，请勿重复申请', already: true }, { headers: cors });
    }

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

    // 退款成功后 TG 通知店主
    try {
      const cfg = db.config || {};
      if (cfg.tg_bot_token && cfg.tg_chat_id) {
        await fetch(`https://api.telegram.org/bot${cfg.tg_bot_token}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: cfg.tg_chat_id, parse_mode: 'HTML',
            text: `💸 <b>自动退款</b>\n订单号：<code>${orderNo}</code>\n商品：${o.product_name}\n退款：¥${(o.refunded_amount / 100).toFixed(2)}\n原因：${o.status === 'out_of_stock' ? '缺货' : o.status === 'luban_error' ? '接码失败' : '订单驳回'}`,
          }),
        });
      }
    } catch (e) {}

    return Response.json({ ok: true, refunded: o.refunded_amount }, { headers: cors });
  } catch (e) {
    return Response.json({ ok: false, msg: e.message }, { headers: cors });
  }
}
