// functions/api/smm-store.js · SMM商品多设备同步（安全修复版：删除硬编码默认密钥）
import { optionsResponse, jsonError, jsonOk } from '../_lib/common.js';
const GH_REPO = '968888u-star/yunfaka';
const GH_PATH = 'public/smm-data.json';
const GH_API = 'https://api.github.com/repos/' + GH_REPO + '/contents/' + GH_PATH;
const GH_RAW = 'https://raw.githubusercontent.com/' + GH_REPO + '/main/' + GH_PATH;
async function ghGetJson() { try { const r = await fetch(GH_RAW + '?t=' + Date.now()); if (r.ok) return await r.json(); } catch (e) {} return { products: [] }; }

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return optionsResponse(request, env);
  const GH_TOKEN = env.GH_TOKEN || '';
  if (request.method === 'GET') { const data = await ghGetJson(); return jsonOk({ products: data.products || [] }, env, request); }
  if (request.method === 'POST') {
    const expected = env.SMM_SYNC_KEY || '';
    const key = request.headers.get('x-sync-key') || '';
    if (!expected || expected === 'yunfaka-smm-sync-2026' || key !== expected) return jsonError('未授权或未配置 SMM_SYNC_KEY', 403, env, request);
    if (!GH_TOKEN) return jsonError('后端未配置 GH_TOKEN', 500, env, request);
    try {
      const body = await request.json();
      const payload = { products: body.products || [], updated: Date.now(), markup: body.markup || null };
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(payload, null, 2))));
      let sha = null;
      try { const gr = await fetch(GH_API, { headers: { 'Authorization': 'token ' + GH_TOKEN, 'User-Agent': 'yunfaka' } }); if (gr.ok) { const gd = await gr.json(); sha = gd.sha; } } catch (e) {}
      const putBody = { message: 'chore: auto sync smm products', content, branch: 'main' };
      if (sha) putBody.sha = sha;
      const pr = await fetch(GH_API, { method: 'PUT', headers: { 'Authorization': 'token ' + GH_TOKEN, 'User-Agent': 'yunfaka', 'Content-Type': 'application/json' }, body: JSON.stringify(putBody) });
      return jsonOk({ ok: pr.ok, count: payload.products.length }, env, request);
    } catch (e) { return jsonError('同步失败', 500, env, request, e); }
  }
  return jsonError('method not allowed', 405, env, request);
}
