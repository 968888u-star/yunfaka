// functions/api/smm-store.js · SMM商品多设备同步存储（Cloudflare KV，未绑定时用内存兜底）
let _memCache = null;
export async function onRequest(context) {
  const { request, env } = context;
  const KV = env.SMM_STORE || null;
  const cors = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  try {
    if (request.method === 'GET') {
      let data = null;
      if (KV) data = await KV.get('smm_products', 'json');
      if (!data && _memCache) data = _memCache;
      if (!data) {
        // 回退：从GitHub raw拉取初始数据
        try {
          const r = await fetch('https://raw.githubusercontent.com/968888u-star/yunfaka/main/public/smm-data.json');
          if (r.ok) data = await r.json();
        } catch(e){}
      }
      return new Response(JSON.stringify({ ok: true, products: data && data.products ? data.products : [] }), { headers: cors });
    }
    if (request.method === 'POST') {
      const body = await request.json();
      if (body.key !== 'yunfaka-smm-sync-2026') return new Response(JSON.stringify({ ok: false, msg: 'key invalid' }), { headers: cors, status: 403 });
      const payload = { products: body.products || [], updated: Date.now() };
      if (KV) await KV.put('smm_products', JSON.stringify(payload));
      else _memCache = payload;
      return new Response(JSON.stringify({ ok: true, count: payload.products.length }), { headers: cors });
    }
    return new Response(JSON.stringify({ ok: false, msg: 'method not allowed' }), { headers: cors, status: 405 });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, msg: e.message }), { headers: cors, status: 500 });
  }
}
