// functions/api/backup.js · 数据自动备份到 GitHub Gist（安全加固版）
// 变更：
//   1. 恢复鉴权改走 X-Backup-Secret 请求头（不再用 URL query，避免日志泄露）
//   2. BACKUP_SECRET 独立，不再 fallback 到 ACCESS_TOKEN
//   3. 手动触发备份也需要鉴权（管理员 token 或 X-Backup-Secret），防止公开接口被滥用
//   4. CORS 收紧、错误脱敏
import { requireAdmin, corsHeaders, optionsResponse, jsonError, jsonOk } from '../_lib/common.js';

const GIST_FILENAME = 'yunfaka-backup.json';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return optionsResponse(request, env);
  if (request.method !== 'GET') return jsonError('Method not allowed', 405, env, request);

  const url = new URL(request.url);
  const GH_TOKEN = env.GH_TOKEN || '';
  const GIST_ID = env.GIST_ID || '';
  const backupSecret = env.BACKUP_SECRET || '';
  const clientSecret = request.headers.get('x-backup-secret') || '';
  const admin = await requireAdmin(request, env);
  // 任何写操作（恢复）和手动触发备份都需要鉴权
  const isAuthed = admin || (backupSecret && clientSecret === backupSecret);

  // ========== 恢复操作 ==========
  if (url.searchParams.get('id')) {
    if (!isAuthed) return jsonError('无权限', 403, env, request);
    if (!GH_TOKEN || !GIST_ID) return jsonError('未配置 GH_TOKEN/GIST_ID', 400, env, request);
    try {
      const r = await fetch(`https://api.github.com/gists/${GIST_ID}/${url.searchParams.get('id')}`, {
        headers: { 'Authorization': 'Bearer ' + GH_TOKEN, 'User-Agent': 'yunfaka-backup' },
      });
      if (!r.ok) return jsonError('备份读取失败', 502, env, request);
      const d = await r.json();
      const file = d.files && d.files[GIST_FILENAME];
      if (!file || !file.content) return jsonError('备份文件不存在', 404, env, request);
      const parsed = JSON.parse(file.content);
      if (!parsed || !parsed.db) return jsonError('备份数据格式错误', 400, env, request);
      await env.YUNFAKA_KV.put('state', JSON.stringify({ rev: parsed.rev || 0, db: parsed.db, restored_at: Date.now() }));
      return jsonOk({ ok: true, msg: '已从备份恢复', rev: parsed.rev }, env, request);
    } catch (e) { return jsonError('恢复失败', 500, env, request, e); }
  }

  // ========== 执行备份（也需要鉴权，Cron 调用时带 X-Backup-Secret） ==========
  if (!isAuthed) return jsonError('无权限触发备份', 403, env, request);
  if (!GH_TOKEN || !GIST_ID) return jsonError('未配置 GH_TOKEN/GIST_ID，无法备份', 400, env, request);
  try {
    const raw = await env.YUNFAKA_KV.get('state');
    if (!raw) return jsonError('无数据可备份', 404, env, request);
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
    if (!r.ok) return jsonError('备份写入失败', 502, env, request);
    return jsonOk({ ok: true, rev: state.rev, backup_at: payload.backup_at }, env, request);
  } catch (e) {
    return jsonError('备份失败', 500, env, request, e);
  }
}
