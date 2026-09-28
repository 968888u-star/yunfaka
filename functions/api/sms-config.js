export async function onRequest(context) {
    const { request, env } = context;
    // 自动兼容不同名字的 KV 绑定
    const kv = env.KV || env.YUNFAKA_KV || env.YF_KV || env.yunfaka;
    
    if (!kv) {
        return new Response(JSON.stringify({ error: '未找到 KV 绑定，请检查 Cloudflare 设置中的 KV 命名空间' }), { 
            status: 500, 
            headers: { 'Content-Type': 'application/json' } 
        });
    }

    if (request.method === 'GET') {
        try {
            const data = await kv.get('sms_config');
            return new Response(data || '{}', { headers: { 'Content-Type': 'application/json' } });
        } catch (e) {
            return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        }
    }

    if (request.method === 'POST') {
        try {
            const body = await request.json();
            const newConfig = {
                sub: body.sub || '选择国家和平台，实时接码，全自动发货',
                luban: typeof body.luban === 'boolean' ? body.luban : true
            };
            await kv.put('sms_config', JSON.stringify(newConfig));
            return new Response(JSON.stringify({ success: true, data: newConfig }), { headers: { 'Content-Type': 'application/json' } });
        } catch (e) {
            return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        }
    }

    return new Response('Method Not Allowed', { status: 405 });
}
