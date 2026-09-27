export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

  const url = new URL(request.url);
  const orderNo = url.searchParams.get('order');
  if (!orderNo) return Response.json({ ok: false, msg: '缺少订单号' }, { headers: corsHeaders });

  try {
    const token = env.HUMKT_TOKEN;
    if (!token) return Response.json({ ok: false, msg: '未配置 HUMKT_TOKEN' }, { headers: corsHeaders });

    const raw = await env.YUNFAKA_KV.get('state');
    if (!raw) return Response.json({ ok: false, msg: '无数据' }, { headers: corsHeaders });
    const state = JSON.parse(raw);
    const order = (state.db.orders || []).find(o => o.order_no === orderNo);
    if (!order) return Response.json({ ok: false, msg: '订单不存在' }, { headers: corsHeaders });

    if (!order.humkt_trx) {
      return Response.json({ ok: false, msg: '该订单未在 humkt 下过单' }, { headers: corsHeaders });
    }

    // 节流：同一订单 15 秒内不重复查
    const now = Date.now();
    if (order.humkt_last_check && now - order.humkt_last_check < 15000 && order.humkt_status !== 'shipped') {
      return Response.json({
        ok: true,
        status: order.humkt_status || 'processing',
        cached: true,
      }, { headers: corsHeaders });
    }

    // 已经是终态，直接返回缓存
    if (order.humkt_status === 'shipped' || order.humkt_status === 'refunded') {
      return Response.json({
        ok: true,
        status: order.humkt_status,
        items: order.humkt_items || [],
        cached: true,
      }, { headers: corsHeaders });
    }

    const res = await fetch('https://www.humkt.com/api/v1/orders/' + encodeURIComponent(order.humkt_trx), {
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/json',
      },
    });
    const data = await res.json();

    order.humkt_last_check = now;

    if (data.code !== 1) {
      await env.YUNFAKA_KV.put('state', JSON.stringify(state));
      return Response.json({ ok: false, msg: data.message || 'humkt 查询失败' }, { headers: corsHeaders });
    }

    const d = data.data;
    order.humkt_status = d.status;
    order.humkt_status_label = d.status_label;

    if (d.status === 'shipped' && d.items && d.items.length) {
      order.humkt_items = d.items;
      // 自动填充到订单卡密
      order.cards = d.items.slice(0, order.quantity);
      order.status = 'delivered';
      order.delivered_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
    } else if (d.status === 'partial') {
      order.cards = d.items || [];
      order.status = 'partial';
    } else if (d.status === 'refunded') {
      order.status = 'rejected';
      order.humkt_refunded = true;
    }

    state.rev++;
    await env.YUNFAKA_KV.put('state', JSON.stringify(state));

    return Response.json({
      ok: true,
      status: d.status,
      status_label: d.status_label,
      items: d.items || [],
      delivered: d.delivered,
      refunded_qty: d.refunded_qty,
    }, { headers: corsHeaders });
  } catch (e) {
    return Response.json({ ok: false, msg: e.message }, { headers: corsHeaders });
  }
}
