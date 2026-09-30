// functions/api/smm-store.js · SMM商品多设备同步（GitHub持久化存储）
// 需要在Cloudflare Pages → Settings → Environment variables 添加 GH_TOKEN（GitHub Personal Access Token）
const GH_REPO = '968888u-star/yunfaka';
const GH_PATH = 'public/smm-data.json';
const GH_API = 'https://api.github.com/repos/' + GH_REPO + '/contents/' + GH_PATH;
const GH_RAW = 'https://raw.githubusercontent.com/' + GH_REPO + '/main/' + GH_PATH;
const cors = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

async function ghGetJson() {
  try {
    const r = await fetch(GH_RAW + '?t=' + Date.now());
    if (r.ok) return await r.json();
  } catch (e) {}
  return { products: [] };
}

export async function onRequest(context) {
  const { request, env } = context;
  const GH_TOKEN = env.GH_TOKEN || '';
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  try {
    if (request.method === 'GET') {
      const data = await ghGetJson();
      return new Response(JSON.stringify({ ok: true, products: data.products || [] }), { headers: cors });
    }
    if (request.method === 'POST') {
      const body = await request.json();
      if (body.key !== 'yunfaka-smm-sync-2026') return new Response(JSON.stringify({ ok: false, msg: 'key invalid' }), { headers: cors, status: 403 });
      if (!GH_TOKEN) return new Response(JSON.stringify({ ok: false, msg: '后端未配置GH_TOKEN环境变量' }), { headers: cors, status: 500 });
      const payload = { products: body.products || [], updated: Date.now(), markup: body.markup || null };
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(payload, null, 2))));
      let sha = null;
      try {
        const gr = await fetch(GH_API, { headers: { 'Authorization': 'token ' + GH_TOKEN, 'User-Agent': 'yunfaka' } });
        if (gr.ok) { const gd = await gr.json(); sha = gd.sha; }
      } catch (e) {}
      const putBody = { message: 'chore: auto sync smm products', content: content, branch: 'main' };
      if (sha) putBody.sha = sha;
      const pr = await fetch(GH_API, {
        method: 'PUT',
        headers: { 'Authorization': 'token ' + GH_TOKEN, 'User-Agent': 'yunfaka', 'Content-Type': 'application/json' },
        body: JSON.stringify(putBody)
      });
      return new Response(JSON.stringify({ ok: pr.ok, count: payload.products.length }), { headers: cors });
    }
    return new Response(JSON.stringify({ ok: false, msg: 'method not allowed' }), { headers: cors, status: 405 });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, msg: e.message }), { headers: cors, status: 500 });
  }
}
