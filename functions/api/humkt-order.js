export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return Response.json({ ok: false, msg: 'Method not allowed' }, { status: 405, headers: corsHeaders });

  try {
    const token = env.HUMKT_TOKEN;
    if (!token) return Response.json({ ok: false, msg: '未配置 HUMKT_TOKEN 环境变量' }, { headers: corsHeaders });

    const body = await request.json();
    const orderNo = body.order_no;
    if (!orderNo) return Response.json({ ok: false, msg: '缺少订单号' }, { headers: corsHeaders });

    // 读取本地数据库
    const raw = await env.YUNFAKA_KV.get('state');
    if (!raw) return Response.json({ ok: false, msg: '无数据' }, { headers: corsHeaders });
    const state = JSON.parse(raw);
    const order = (state.db.orders || []).find(o => o.order_no === orderNo);
    if (!order) return Response.json({ ok: false, msg: '订单不存在' }, { headers: corsHeaders });

    if (order.humkt_trx) {
      // 已下过单，直接返回
      return Response.json({ ok: true, trx: order.humkt_trx, already: true }, { headers: corsHeaders });
    }

    const productId = order.humkt_product_id;
    if (!productId) return Response.json({ ok: false, msg: '订单缺少 humkt 商品 ID' }, { headers: corsHeaders });

    // 调用 humkt 下单
    const params = new URLSearchParams();
    params.set('id', String(productId));
    params.set('qty', String(order.quantity || 1));
    if (order.humkt_account_ids) params.set('account_ids', order.humkt_account_ids);

    const res = await fetch('https://www.humkt.com/api/v1/orders', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const data = await res.json();
    if (data.code !== 1) {
      return Response.json({ ok: false, msg: data.message || 'humkt 下单失败' }, { headers: corsHeaders });
    }

    // 把 trx 写回订单
    order.humkt_trx = data.data.trx;
    order.humkt_status = data.data.status;
    order.humkt_created_at = new Date().toISOString();
    order.humkt_last_check = 0;
    state.rev++;
    await env.YUNFAKA_KV.put('state', JSON.stringify(state));

    return Response.json({
      ok: true,
      trx: data.data.trx,
      status: data.data.status,
      status_label: data.data.status_label,
    }, { headers: corsHeaders });
  } catch (e) {
    return Response.json({ ok: false, msg: e.message }, { headers: corsHeaders });
  }
}
