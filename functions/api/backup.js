// functions/api/backup.js · 数据自动备份到 GitHub Gist
// 环境变量：GH_TOKEN（GitHub PAT）、GIST_ID（备份用 Gist ID）
// GET  → 立即备份一次（可被 Cloudflare Cron Trigger 定时调用）
// GET ?id=xxx → 从 Gist 恢复指定版本（需带 ?secret=BACKUP_SECRET 鉴权）
const GIST_FILENAME = 'yunfaka-backup.json';

export async function onRequest(context) {
  const { request, env } = context;
  const cors = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const url = new URL(request.url);
  const GH_TOKEN = env.GH_TOKEN || '';
  const GIST_ID = env.GIST_ID || '';

  // 恢复操作需要鉴权
  if (url.searchParams.get('id')) {
    const secret = url.searchParams.get('secret') || '';
    if (secret !== (env.BACKUP_SECRET || env.ACCESS_TOKEN || '')) {
      return Response.json({ ok: false, msg: '无权限' }, { status: 403, headers: cors });
    }
    if (!GH_TOKEN || !GIST_ID) return Response.json({ ok: false, msg: '未配置 GH_TOKEN/GIST_ID' }, { headers: cors });
    try {
      const r = await fetch(`https://api.github.com/gists/${GIST_ID}/${url.searchParams.get('id')}`, {
        headers: { 'Authorization': 'Bearer ' + GH_TOKEN, 'User-Agent': 'yunfaka-backup' },
      });
      if (!r.ok) return Response.json({ ok: false, msg: 'Gist 读取失败 ' + r.status }, { headers: cors });
      const d = await r.json();
      const file = d.files && d.files[GIST_FILENAME];
      if (!file || !file.content) return Response.json({ ok: false, msg: '备份文件不存在' }, { headers: cors });
      const parsed = JSON.parse(file.content);
      await env.YUNFAKA_KV.put('state', JSON.stringify({ rev: parsed.rev || 0, db: parsed.db, restored_at: Date.now() }));
      return Response.json({ ok: true, msg: '已从备份恢复', rev: parsed.rev }, { headers: cors });
    } catch (e) { return Response.json({ ok: false, msg: e.message }, { headers: cors }); }
  }

  // 执行备份
  if (!GH_TOKEN || !GIST_ID) return Response.json({ ok: false, msg: '未配置 GH_TOKEN/GIST_ID，无法备份' }, { headers: cors });
  try {
    const raw = await env.YUNFAKA_KV.get('state');
    if (!raw) return Response.json({ ok: false, msg: '无数据可备份' }, { headers: cors });
    const state = JSON.parse(raw);
    const payload = {
      rev: state.rev, db: state.db,
      backup_at: new Date().toISOString(),
      orders_count: (state.db.orders || []).length,
      members_count: (state.db.members || []).length,
    };
    const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + GH_TOKEN, 'Content-Type': 'application/json', 'User-Agent': 'yunfaka-backup' },
      body: JSON.stringify({ files: { [GIST_FILENAME]: { content: JSON.stringify(payload) } } }),
    });
    if (!r.ok) return Response.json({ ok: false, msg: 'Gist 写入失败 ' + r.status }, { headers: cors });
    return Response.json({ ok: true, rev: state.rev, backup_at: payload.backup_at }, { headers: cors });
  } catch (e) {
    return Response.json({ ok: false, msg: e.message }, { headers: cors });
  }
}
