// functions/api/tg-send.js · Telegram 消息发送代理（后端持有 Token，前端不再暴露）
// POST { text, chat_id?, order_no?, type? }
//   - 不指定 chat_id 时使用 db.config.tg_chat_id（店主）
//   - type=customer 且带 order_no 时，发送给订单绑定的客户 TG
export async function onRequest(context) {
  const { request, env } = context;
  const cors = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return Response.json({ ok: false, msg: 'Method not allowed' }, { status: 405, headers: cors });

  try {
    const body = await request.json();
    const text = (body.text || '').trim();
    if (!text) return Response.json({ ok: false, msg: '缺少消息内容' }, { headers: cors });

    const raw = await env.YUNFAKA_KV.get('state');
    if (!raw) return Response.json({ ok: false, msg: '无数据' }, { headers: cors });
    const state = JSON.parse(raw);
    const cfg = (state.db && state.db.config) || {};
    const botToken = cfg.tg_bot_token || env.TG_BOT_TOKEN || '';
    if (!botToken) return Response.json({ ok: false, msg: '未配置 TG Bot Token' }, { headers: cors });

    let chatId = body.chat_id || cfg.tg_chat_id || '';
    // 发送给订单绑定的客户
    if (body.type === 'customer' && body.order_no) {
      const order = (state.db.orders || []).find(o => o.order_no === body.order_no);
      if (order && order.customer_tg_id) chatId = order.customer_tg_id;
    }
    if (!chatId) return Response.json({ ok: false, msg: '未指定接收方' }, { headers: cors });

    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: body.parse_mode || 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const d = await r.json();
    if (!d.ok) return Response.json({ ok: false, msg: d.description || 'TG 发送失败' }, { headers: cors });
    return Response.json({ ok: true }, { headers: cors });
  } catch (e) {
    return Response.json({ ok: false, msg: e.message }, { headers: cors });
  }
}
