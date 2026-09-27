export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

  try {
    const token = env.HUMKT_TOKEN;
    if (!token) return Response.json({ ok: false, msg: '未配置 HUMKT_TOKEN' }, { headers: corsHeaders });

    const url = new URL(request.url);
    const action = url.searchParams.get('action') || 'products';

    let apiUrl;
    if (action === 'categories') {
      apiUrl = 'https://www.humkt.com/api/v1/categories';
    } else if (action === 'detail') {
      const id = url.searchParams.get('id');
      if (!id) return Response.json({ ok: false, msg: '缺少 id' }, { headers: corsHeaders });
      apiUrl = 'https://www.humkt.com/api/v1/products/' + encodeURIComponent(id);
    } else {
      const params = new URLSearchParams();
      const q = url.searchParams.get('q');
      const categoryId = url.searchParams.get('category_id');
      const page = url.searchParams.get('page') || '1';
      const perPage = url.searchParams.get('per_page') || '50';
      if (q) params.set('q', q);
      if (categoryId) params.set('category_id', categoryId);
      params.set('page', page);
      params.set('per_page', perPage);
      params.set('in_stock', url.searchParams.get('in_stock') || '1');
      apiUrl = 'https://www.humkt.com/api/v1/products?' + params.toString();
    }

    const res = await fetch(apiUrl, {
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/json',
      },
    });
    const data = await res.json();
    return Response.json(data, { headers: corsHeaders });
  } catch (e) {
    return Response.json({ ok: false, msg: e.message }, { headers: corsHeaders });
  }
}
