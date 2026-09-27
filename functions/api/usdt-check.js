export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(request.url);
  const orderNo = url.searchParams.get('order');
  if (!orderNo) {
    return Response.json({ ok: false, msg: '缺少订单号' }, { headers: corsHeaders });
  }

  const raw = await env.YUNFAKA_KV.get('state');
  if (!raw) return Response.json({ ok: false, msg: '无数据' }, { headers: corsHeaders });
  const state = JSON.parse(raw);
  if (!state.db) return Response.json({ ok: false, msg: '无数据' }, { headers: corsHeaders });

  const order = state.db.orders.find(o => o.order_no === orderNo);
  if (!order) return Response.json({ ok: false, msg: '订单不存在' }, { headers: corsHeaders });

  // 已发货/已驳回等，直接返回
  if (order.status !== 'pending') {
    return Response.json({ ok: true, status: order.status }, { headers: corsHeaders });
  }

  if (order.pay_method !== 'usdt') {
    return Response.json({ ok: false, msg: '非 USDT 订单' }, { headers: corsHeaders });
  }

  const cfg = state.db.config || {};
  const usdtAddress = cfg.pay_usdt_address;
  const rate = Number(cfg.pay_usdt_rate) || 7.2;

  if (!usdtAddress) {
    return Response.json({ ok: false, msg: '未配置 USDT 收款地址' }, { headers: corsHeaders });
  }

  const expectedUsdt = order.amount_due / 100 / rate;
  const minAmount = expectedUsdt * 0.99;
  const maxAmount = expectedUsdt * 1.01;

  const orderTime = new Date(order.created_at.replace(' ', 'T')).getTime();

  try {
    const headers = { 'Accept': 'application/json' };
    if (env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = env.TRONGRID_API_KEY;

    const res = await fetch(
      `https://api.trongrid.io/v1/accounts/${usdtAddress}/transactions/trc20?limit=30&only_to=true`,
      { headers }
    );
    if (!res.ok) throw new Error('TronGrid 请求失败 ' + res.status);
    const data = await res.json();

    const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

    for (const tx of (data.data || [])) {
      if (tx.type !== 'Transfer') continue;
      if (!tx.token_info || tx.token_info.address !== USDT_CONTRACT) continue;
      if (tx.to !== usdtAddress) continue;

      const txTime = tx.block_timestamp;
      if (txTime < orderTime - 5 * 60 * 1000) continue;
      if (txTime > orderTime + 24 * 60 * 60 * 1000) continue;

      const amount = Number(tx.value) / Math.pow(10, tx.token_info.decimals || 6);

      if (amount >= minAmount && amount <= maxAmount) {
        const available = state.db.cards.filter(
          c => c.product_id === order.product_id && c.status === 'unused'
        );

        if (available.length >= order.quantity) {
          available.slice(0, order.quantity).forEach(c => {
            c.status = 'used';
            c.order_no = order.order_no;
            c.used_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
            order.cards.push(c.content);
          });
          order.status = 'delivered';
          order.delivered_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
        } else {
          order.status = 'out_of_stock';
        }

        order.pay_tx = tx.transaction_id;
        order.paid_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
        order.paid_amount_usdt = amount;

        state.rev++;
        await env.YUNFAKA_KV.put('state', JSON.stringify(state));

        return Response.json({
          ok: true,
          status: order.status,
          auto: true,
          tx: tx.transaction_id,
          amount
        }, { headers: corsHeaders });
      }
    }

    return Response.json({ ok: true, status: 'pending', msg: '暂未检测到匹配的转账' }, { headers: corsHeaders });
  } catch (e) {
    return Response.json({ ok: false, msg: e.message }, { headers: corsHeaders });
  }
}
