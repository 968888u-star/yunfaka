// functions/api/admin-action.js · 后台敏感操作统一入口（后端执行，防前端篡改）
// 所有操作必须携带 X-Admin-Token（由 /api/admin-login 签发）
// POST { action, ...params }
import { verifyToken, getSecret, hashPwd } from '../_lib/auth.js';

function nowStr() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
function addLog(db, action, detail) {
  if (!Array.isArray(db.logs)) db.logs = [];
  db.logs.unshift({ time: nowStr(), action, detail });
  if (db.logs.length > 500) db.logs.length = 500;
}

export async function onRequest(context) {
  const { request, env } = context;
  const cors = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Admin-Token',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return Response.json({ ok: false, msg: 'Method not allowed' }, { status: 405, headers: cors });

  // ⭐ 校验管理员 session token
  const token = request.headers.get('x-admin-token') || request.headers.get('X-Admin-Token') || '';
  const payload = await verifyToken(token, getSecret(env));
  if (!payload || payload.sub !== 'admin') {
    return Response.json({ ok: false, msg: '未登录或登录已过期，请重新登录' }, { status: 401, headers: cors });
  }

  try {
    const body = await request.json();
    const action = body.action || '';
    const raw = await env.YUNFAKA_KV.get('state');
    if (!raw) return Response.json({ ok: false, msg: '无数据' }, { headers: cors });
    const state = JSON.parse(raw);
    const db = state.db;
    let changed = false;

    // ========== 1. 审核通过并发货 ==========
    if (action === 'approve_order') {
      const o = (db.orders || []).find(x => x.order_no === body.order_no);
      if (!o) return Response.json({ ok: false, msg: '订单不存在' }, { headers: cors });
      if (o.status !== 'pending_review') return Response.json({ ok: false, msg: '订单状态不是待审核' }, { headers: cors });
      if (o.source === 'luban' || o.source === 'smm') {
        o.status = 'processing'; o.approved_at = nowStr();
        addLog(db, 'approve_order', `订单 ${o.order_no}(${o.product_name}) 审核通过，转上游处理`);
        changed = true;
      } else {
        const orderSku = o.sku_id || 0;
        const available = (db.cards || []).filter(c => c.product_id === o.product_id && c.status === 'unused' && String(c.sku_id || 0) === String(orderSku));
        if (available.length < o.quantity) {
          return Response.json({ ok: false, msg: `库存不足：需要 ${o.quantity} 条，仅余 ${available.length} 条` }, { headers: cors });
        }
        const usedIds = new Set((db.orders || []).flatMap(x => x.cards || []));
        const safe = available.filter(c => !usedIds.has(c.content));
        const toUse = safe.length >= o.quantity ? safe.slice(0, o.quantity) : available.slice(0, o.quantity);
        toUse.forEach(c => { c.status = 'used'; c.order_no = o.order_no; c.used_at = nowStr(); o.cards.push(c.content); });
        o.status = 'delivered'; o.delivered_at = nowStr(); o.approved_at = nowStr();
        addLog(db, 'approve_order', `订单 ${o.order_no}(${o.product_name}×${o.quantity}) 审核通过并发货`);
        changed = true;
      }
    }

    // ========== 2. 驳回订单（自动退余额） ==========
    else if (action === 'reject_order') {
      const o = (db.orders || []).find(x => x.order_no === body.order_no);
      if (!o) return Response.json({ ok: false, msg: '订单不存在' }, { headers: cors });
      if (o.balance_used > 0 && o.username) {
        const m = (db.members || []).find(x => x.username === o.username);
        if (m) { m.balance = (m.balance || 0) + o.balance_used; }
        o.refunded_amount = o.balance_used; o.refunded_at = nowStr(); o.balance_used = 0;
      }
      o.status = 'rejected'; o.rejected_at = nowStr(); o.reject_reason = body.reason || '';
      addLog(db, 'reject_order', `订单 ${o.order_no} 被驳回${body.reason ? '：' + body.reason : ''}`);
      changed = true;
    }

    // ========== 3. 调整会员余额 ==========
    else if (action === 'adjust_balance') {
      const m = (db.members || []).find(x => x.username === body.username);
      if (!m) return Response.json({ ok: false, msg: '会员不存在' }, { headers: cors });
      const delta = Math.round(Number(body.delta) || 0);
      if (delta === 0) return Response.json({ ok: false, msg: '调整金额不能为0' }, { headers: cors });
      const newBal = (m.balance || 0) + delta;
      if (newBal < 0) return Response.json({ ok: false, msg: '调整后余额不能为负' }, { headers: cors });
      m.balance = newBal;
      addLog(db, 'adjust_balance', `会员 ${m.username} 余额 ${delta > 0 ? '+' : ''}${(delta / 100).toFixed(2)}元 → ¥${(newBal / 100).toFixed(2)}（${body.reason || '未说明'}）`);
      changed = true;
    }

    // ========== 4. 删除订单 ==========
    else if (action === 'delete_order') {
      const idx = (db.orders || []).findIndex(x => x.order_no === body.order_no);
      if (idx < 0) return Response.json({ ok: false, msg: '订单不存在' }, { headers: cors });
      const o = db.orders[idx];
      db.orders.splice(idx, 1);
      addLog(db, 'delete_order', `删除订单 ${o.order_no}(${o.product_name})`);
      changed = true;
    }

    // ========== 5. 保存设置（含敏感字段） ==========
    else if (action === 'save_settings') {
      const cfg = body.config || {};
      // 只允许白名单字段，防止注入其他字段
      const allowed = ['site_name', 'tg_chat_id', 'tg_username', 'tg_bot_token', 'tg_btn_color',
        'pay_usdt_address', 'pay_usdt_qr', 'pay_usdt_rate', 'pay_usdt_network', 'pay_usdt_enabled',
        'pay_alipay_enabled', 'pay_alipay_mode', 'pay_alipay_qr', 'pay_alipay_note', 'pay_alipay_redpacket_prefix',
        'recharge_min', 'recharge_bonus_pct', 'recharge_bonus_text', 'admin_pwd_hash'];
      if (!db.config) db.config = {};
      allowed.forEach(k => { if (cfg[k] !== undefined) db.config[k] = cfg[k]; });
      // 修改管理员密码需单独校验
      if (body.new_admin_password) {
        if (body.new_admin_password.length < 6) return Response.json({ ok: false, msg: '新密码至少6位' }, { headers: cors });
        db.config.admin_pwd_hash = hashPwd(body.new_admin_password);
      }
      addLog(db, 'save_settings', '修改站点设置');
      changed = true;
    }

    // ========== 6. 重置会员密码 ==========
    else if (action === 'reset_member_pwd') {
      const m = (db.members || []).find(x => x.username === body.username);
      if (!m) return Response.json({ ok: false, msg: '会员不存在' }, { headers: cors });
      if (!body.new_password || body.new_password.length < 6) return Response.json({ ok: false, msg: '新密码至少6位' }, { headers: cors });
      m.password = hashPwd(body.new_password);
      addLog(db, 'reset_member_pwd', `重置会员 ${m.username} 的密码`);
      changed = true;
    }

    // ========== 7. 删除会员 ==========
    else if (action === 'delete_member') {
      const idx = (db.members || []).findIndex(x => x.username === body.username);
      if (idx < 0) return Response.json({ ok: false, msg: '会员不存在' }, { headers: cors });
      db.members.splice(idx, 1);
      addLog(db, 'delete_member', `删除会员 ${body.username}`);
      changed = true;
    }

    // ========== 8. 缺货/失败订单自动退款（也可手动触发） ==========
    else if (action === 'refund_order') {
      const o = (db.orders || []).find(x => x.order_no === body.order_no);
      if (!o) return Response.json({ ok: false, msg: '订单不存在' }, { headers: cors });
      if (o.balance_used > 0 && o.username) {
        const m = (db.members || []).find(x => x.username === o.username);
        if (m) { m.balance = (m.balance || 0) + o.balance_used; }
        o.refunded_amount = o.balance_used; o.refunded_at = nowStr(); o.balance_used = 0;
      }
      o.status = 'rejected'; o.refund_auto = true;
      addLog(db, 'refund_order', `订单 ${o.order_no} 退款 ¥${((o.refunded_amount || 0) / 100).toFixed(2)}`);
      changed = true;
    }

    else {
      return Response.json({ ok: false, msg: '未知操作: ' + action }, { headers: cors });
    }

    if (changed) {
      state.rev = (state.rev || 0) + 1;
      await env.YUNFAKA_KV.put('state', JSON.stringify(state));
    }
    return Response.json({ ok: true, rev: state.rev }, { headers: cors });
  } catch (e) {
    return Response.json({ ok: false, msg: e.message }, { status: 500, headers: cors });
  }
}
