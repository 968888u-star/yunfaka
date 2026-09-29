// functions/api/smm.js · chinayinliu.com SMM 代理 (Cloudflare Pages Function)

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    });
  }

  const API_KEY = env.CHINAYINLIU_API_KEY;
  if (!API_KEY) return json({ ok: false, msg: '后端未配置 CHINAYINLIU_API_KEY 环境变量' });

  const ENDPOINT = 'https://chinayinliu.com/api/v2';

  let body = {};
  try { body = await request.json(); }
  catch (e) { body = Object.fromEntries(new URL(request.url).searchParams); }

  const action = body.action || '';
  const params = new URLSearchParams();
  params.append('key', API_KEY);

  if (action === 'services') {
    params.append('action', 'services');
  } else if (action === 'balance') {
    params.append('action', 'balance');
  } else if (action === 'add') {
    params.append('action', 'add');
    params.append('service', body.service || '');
    params.append('link', body.link || '');
    params.append('quantity', body.quantity || '');
    if (body.runs) params.append('runs', body.runs);
    if (body.interval) params.append('interval', body.interval);
  } else if (action === 'status') {
    params.append('action', 'status');
    if (body.orders) params.append('orders', body.orders);
    else params.append('order', body.order || '');
  } else if (action === 'refill') {
    params.append('action', 'refill');
    params.append('order', body.order || '');
  } else if (action === 'cancel') {
    params.append('action', 'cancel');
    params.append('orders', body.orders || body.order || '');
  } else {
    return json({ ok: false, msg: 'unknown action: ' + action });
  }

  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); }
    catch (e) { return json({ ok: false, msg: '上游返回非JSON', raw: text.substring(0, 500) }); }
    return json({ ok: true, data });
  } catch (e) {
    return json({ ok: false, msg: 'fetch failed: ' + e.message });
  }
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    }
  });
}
