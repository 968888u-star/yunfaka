import { optionsResponse, jsonError, jsonOk, rateLimit, getClientIp } from '../_lib/common.js';
export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return optionsResponse(request, env);
  const rl = await rateLimit(env.YUNFAKA_KV, 'humkt:' + getClientIp(request), 30, 60000);
  if (rl.blocked) return jsonError('请求过于频繁', 429, env, request);
  try {
    const token = env.HUMKT_TOKEN;
    if (!token) return jsonError('未配置 HUMKT_TOKEN', 400, env, request);
    const url = new URL(request.url);
    const action = url.searchParams.get('action') || 'products';
    let apiUrl;
    if (action === 'categories') apiUrl = 'https://www.humkt.com/api/v1/categories';
    else if (action === 'detail') { const id = url.searchParams.get('id'); if (!id) return jsonError('缺少 id', 400, env, request); apiUrl = 'https://www.humkt.com/api/v1/products/' + encodeURIComponent(id); }
    else {
      const params = new URLSearchParams();
      if (url.searchParams.get('q')) params.set('q', url.searchParams.get('q'));
      if (url.searchParams.get('category_id')) params.set('category_id', url.searchParams.get('category_id'));
      params.set('page', url.searchParams.get('page') || '1');
      params.set('per_page', url.searchParams.get('per_page') || '50');
      params.set('in_stock', url.searchParams.get('in_stock') || '1');
      apiUrl = 'https://www.humkt.com/api/v1/products?' + params.toString();
    }
    const res = await fetch(apiUrl, { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' } });
    const data = await res.json();
    return jsonOk(data, env, request);
  } catch (e) { return jsonError('操作失败，请稍后重试', 500, env, request, e); }
}
