export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return Response.json({ ok: false, msg: 'Method not allowed' }, { status: 405, headers: corsHeaders });
  }

  try {
    const body = await request.json();
    const orderNo = body.order_no;
    if (!orderNo) return Response.json({ ok: false, msg: '缺少订单号' }, { headers: corsHeaders });

    const raw = await env.YUNFAKA_KV.get('state');
    if (!raw) return Response.json({ ok: false, msg: '无数据' }, { headers: corsHeaders });
    const state = JSON.parse(raw);
    const cfg = (state.db && state.db.config) || {};

    const botToken = cfg.tg_bot_token;
    const chatId = cfg.tg_chat_id;
    if (!botToken || !chatId) {
      return Response.json({ ok: false, msg: '未配置 TG Bot Token 或 Chat ID' }, { headers: corsHeaders });
    }

    const order = (state.db.orders || []).find(o => o.order_no === orderNo);
    if (!order) return Response.json({ ok: false, msg: '订单不存在' }, { headers: corsHeaders });

    const amount = (order.amount_due / 100).toFixed(2);
    const payName = order.pay_method === 'alipay' ? '支付宝口令红包' : (order.pay_method === 'usdt' ? 'USDT' : '余额');
    const skuLine = order.sku_name ? `\n规格：${order.sku_name}` : '';
    const rpLine = order.redpacket_code ? `\n红包口令：<code>${order.redpacket_code}</code>` : '';

    const text =
      `🔔 <b>新订单待审核</b>\n\n` +
      `订单号：<code>${order.order_no}</code>\n` +
      `商品：${order.product_name}${skuLine}\n` +
      `数量：${order.quantity}\n` +
      `金额：¥${amount}\n` +
      `支付：${payName}${rpLine}\n` +
      `暗号：${order.secret || '-'}\n` +
      `时间：${order.created_at}\n\n` +
      `👉 请到后台「待审核」页面处理`;

    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });

    const d = await r.json();
    if (!d.ok) return Response.json({ ok: false, msg: d.description || 'TG 发送失败' }, { headers: corsHeaders });

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (e) {
    return Response.json({ ok: false, msg: e.message }, { headers: corsHeaders });
  }
}
