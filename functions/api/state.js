export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Access-Token',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method === 'GET') {
    const raw = await env.YUNFAKA_KV.get('state');
    const data = raw ? JSON.parse(raw) : null;
    return Response.json(
      { ok: true, rev: data?.rev || 0, db: data?.db || null },
      { headers: corsHeaders }
    );
  }

  if (request.method === 'POST') {
    try {
      /* ⭐ 可选鉴权：若配置了ACCESS_TOKEN环境变量则校验 */
      const token = env.ACCESS_TOKEN || '';
      if (token) {
        const clientToken = request.headers.get('x-access-token') || request.headers.get('X-Access-Token') || '';
        if (clientToken !== token) {
          return Response.json({ ok: false, msg: '无权限写入' }, { status: 403, headers: corsHeaders });
        }
      }
      const body = await request.json();
      if (!body || !body.db) throw new Error('bad');

      const raw = await env.YUNFAKA_KV.get('state');
      const current = raw ? JSON.parse(raw) : null;
      const currentRev = current?.rev || 0;

      if (body.baseRev !== undefined && current && body.baseRev !== currentRev) {
        return Response.json(
          { ok: false, msg: '数据已被其他设备更新', rev: currentRev, db: current.db },
          { status: 409, headers: corsHeaders }
        );
      }

      const newRev = currentRev + 1;
      await env.YUNFAKA_KV.put('state', JSON.stringify({ rev: newRev, db: body.db, updated_at: Date.now() }));
      return Response.json({ ok: true, rev: newRev }, { headers: corsHeaders });
    } catch (e) {
      return Response.json({ ok: false, msg: '数据格式错误' }, { status: 400, headers: corsHeaders });
    }
  }

  return Response.json({ ok: false, msg: 'Method not allowed' }, { status: 405, headers: corsHeaders });
}
