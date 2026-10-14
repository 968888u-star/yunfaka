// functions/api/humkt-order.js（安全修复版：校验订单已支付，防止未付款就扣店主上游余额）
import { requireAdmin, requireMember, optionsResponse, jsonError, jsonOk } from '../_lib/common.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return optionsResponse(request, env);
  if (request.method !== 'POST') return jsonError('Method not allowed', 405, env, request);
  try {
    const token = env.HUMKT_TOKEN;
    if (!token) return jsonError('未配置 HUMKT_TOKEN', 400, env, request);
    const body = await request.json();
    const orderNo = body.order_no;
    if (!orderNo) return jsonError('缺少订单号', 400, env, request);
    const raw = await env.YUNFAKA_KV.get('state');
    if (!raw) return jsonError('无数据', 404, env, request);
    const state = JSON.parse(raw);
    const order = (state.db.orders || []).find(o => o.order_no === orderNo);
    if (!order) return jsonError('订单不存在', 404, env, request);
    // 必须已支付（非 pending）才能提交上游
    if (order.status === 'pending') return jsonError('订单未支付，无法提交上游', 400, env, request);
    // 会员只能操作自己的订单
    const admin = await requireAdmin(request, env);
    const member = await requireMember(request, env);
    if (!admin && (!member || member.username !== order.username)) return jsonError('只能操作自己的订单', 403, env, request);
    if (order.humkt_trx) return jsonOk({ ok: true, trx: order.humkt_trx, already: true }, env, request);
    const productId = order.humkt_product_id;
    if (!productId) return jsonError('订单缺少 humkt 商品 ID', 400, env, request);
    const params = new URLSearchParams();
    params.set('id', String(productId));
    params.set('qty', String(order.quantity || 1));
    if (order.humkt_account_ids) params.set('account_ids', order.humkt_account_ids);
    const res = await fetch('https://www.humkt.com/api/v1/orders', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
    const data = await res.json();
    if (data.code !== 1) return jsonError(data.message || 'humkt 下单失败', 400, env, request);
    order.humkt_trx = data.data.trx;
    order.humkt_status = data.data.status;
    order.humkt_created_at = new Date().toISOString();
    order.humkt_last_check = 0;
    state.rev = (state.rev || 0) + 1;
    await env.YUNFAKA_KV.put('state', JSON.stringify(state));
    return jsonOk({ ok: true, trx: data.data.trx, status: data.data.status, status_label: data.data.status_label }, env, request);
  } catch (e) { return jsonError('操作失败，请稍后重试', 500, env, request, e); }
}
