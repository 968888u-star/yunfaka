// functions/api/chat.js · 在线客服消息中转（Cloudflare Pages Function）
// 客户消息存KV并转发到店主TG；店主在TG回复带 #会话ID 前缀，系统解析后存回对应会话
export async function onRequest(context) {
  const { request, env } = context;
  const cors = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const kv = env.YUNFAKA_KV || env.KV || env.YF_KV;
  if (!kv) return Response.json({ ok: false, msg: '未找到 KV 绑定' }, { headers: cors, status: 500 });

  const url = new URL(request.url);

  try {
    /* ========== GET：拉取会话消息（同时检查TG店主回复） ========== */
    if (request.method === 'GET') {
      const sessionId = url.searchParams.get('session');
      if (!sessionId) return Response.json({ ok: false, msg: '缺少会话ID' }, { headers: cors, status: 400 });

      // 1) 检查TG店主回复（getUpdates轮询）
      await checkTgReplies(kv, env);

      // 2) 返回该会话消息
      const raw = await kv.get('chat_sessions');
      const sessions = raw ? JSON.parse(raw) : {};
      const msgs = sessions[sessionId] || [];
      return Response.json({ ok: true, messages: msgs }, { headers: cors });
    }

    /* ========== POST：客户发送消息 ========== */
    if (request.method === 'POST') {
      const body = await request.json();
      const sessionId = body.session;
      const text = (body.text || '').trim();
      if (!sessionId || !text) return Response.json({ ok: false, msg: '缺少会话ID或消息内容' }, { headers: cors, status: 400 });

      // 1) 存到KV
      const raw = await kv.get('chat_sessions');
      const sessions = raw ? JSON.parse(raw) : {};
      if (!sessions[sessionId]) sessions[sessionId] = [];
      const msg = { role: 'customer', text, time: new Date().toISOString().slice(0, 19).replace('T', ' ') };
      sessions[sessionId].push(msg);
      // 只保留最近100条
      if (sessions[sessionId].length > 100) sessions[sessionId] = sessions[sessionId].slice(-100);
      await kv.put('chat_sessions', JSON.stringify(sessions));

      // 2) 转发到店主TG（带会话ID前缀，店主回复时带#ID即可）
      const stateRaw = await kv.get('state');
      let botToken = '', chatId = '';
      try {
        if (stateRaw) {
          const st = JSON.parse(stateRaw);
          const cfg = (st.db && st.db.config) || {};
          botToken = cfg.tg_bot_token || '';
          chatId = cfg.tg_chat_id || '';
        }
      } catch (e) {}
      if (botToken && chatId) {
        const siteName = (() => { try { return JSON.parse(stateRaw).db.config.site_name || '云发卡'; } catch (e) { return '云发卡'; } })();
        const tgText = `💬 <b>客服新消息</b> [${siteName}]\n\n会话ID：<code>#${sessionId}</code>\n客户说：${text}\n\n👉 回复格式：<code>#${sessionId} 你的回复内容</code>`;
        try {
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: tgText, parse_mode: 'HTML' }),
          });
        } catch (e) { console.warn('TG转发失败', e); }
      }

      return Response.json({ ok: true }, { headers: cors });
    }

    return Response.json({ ok: false, msg: 'Method not allowed' }, { headers: cors, status: 405 });
  } catch (e) {
    return Response.json({ ok: false, msg: e.message }, { headers: cors, status: 500 });
  }
}

/* 检查TG店主回复：解析带 #会话ID 前缀的消息，存回对应会话 */
async function checkTgReplies(kv, env) {
  let botToken = '';
  try {
    const stateRaw = await kv.get('state');
    if (stateRaw) {
      const st = JSON.parse(stateRaw);
      botToken = (st.db && st.db.config && st.db.config.tg_bot_token) || '';
    }
  } catch (e) {}
  if (!botToken) return;

  // 读取上次offset
  let offset = 0;
  try { offset = parseInt(await kv.get('chat_tg_offset')) || 0; } catch (e) {}

  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?offset=${offset}&timeout=2`, {
      headers: { 'Content-Type': 'application/json' },
    });
    const d = await r.json();
    if (!d.ok || !d.result || !d.result.length) return;

    const raw = await kv.get('chat_sessions');
    const sessions = raw ? JSON.parse(raw) : {};
    let newOffset = offset;

    for (const upd of d.result) {
      newOffset = Math.max(newOffset, upd.update_id + 1);
      const msg = upd.message || upd.edited_message;
      if (!msg || !msg.text) continue;
      const text = msg.text.trim();
      // 匹配 #会话ID 回复格式
      const m = text.match(/^#([A-Za-z0-9_-]+)\s+(.+)$/s);
      if (!m) continue;
      const sessionId = m[1];
      const replyText = m[2].trim();
      if (!sessions[sessionId]) sessions[sessionId] = [];
      sessions[sessionId].push({
        role: 'admin',
        text: replyText,
        time: new Date().toISOString().slice(0, 19).replace('T', ' '),
      });
      if (sessions[sessionId].length > 100) sessions[sessionId] = sessions[sessionId].slice(-100);
    }

    await kv.put('chat_sessions', JSON.stringify(sessions));
    await kv.put('chat_tg_offset', String(newOffset));
  } catch (e) {
    console.warn('检查TG回复失败', e);
  }
}
