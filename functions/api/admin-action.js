// functions/api/admin-action.js · 后台敏感操作（自动取号版）
import { hashPwd } from '../_lib/auth.js';
import { writeAdminConfig, readAdminConfig } from '../_lib/admin-config.js';
import { requireAdmin, optionsResponse, jsonError, jsonOk, rateLimit, getClientIp } from '../_lib/common.js';

function nowStr() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function addLog(db, action, detail, ip, ua) {
  if (!Array.isArray(db.logs)) db.logs = [];
  db.logs.unshift({ time: nowStr(), action, detail, ip: ip || '', ua: (ua || '').slice(0, 80) });
  if (db.logs.length > 500) db.logs.length = 500;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return optionsResponse(request, env);
  if (request.method !== 'POST') return jsonError('Method not allowed', 405, env, request);

  const admin = await requireAdmin(request, env);
  if (!admin) return jsonError('未登录或登录已过期，请重新登录', 401, env, request);

  const ip = getClientIp(request);
  const rl = await rateLimit(env.YUNFAKA_KV, 'adminaction:' + ip, 60, 60000);
  if (rl.blocked) return jsonError('操作过于频繁，请稍后再试', 429, env, request);

  const ua = request.headers.get('user-agent') || '';

  try {
    const body = await request.json();
    const action = body.action || '';
    const raw = await env.YUNFAKA_KV.get('state');
    if (!raw) return jsonError('无数据', 404, env, request);
    const state = JSON.parse(raw);
    const db = state.db;
    let changed = false;

    /* ========== 确认发货 ========== */
    if (action === 'approve_order') {
      const o = (db.orders || []).find(x => x.order_no === body.order_no);
      if (!o) return jsonError('订单不存在', 404, env, request);
      if (o.status !== 'pending_review') return jsonError('订单状态不是待审核', 400, env, request);

      if (o.source === 'luban') {
        o.status = 'processing';
        o.approved_at = nowStr();
        addLog(db, 'approve_order', `订单 ${o.order_no} 转上游接码`, ip, ua);
        
        state.rev = (state.rev || 0) + 1;
        await env.YUNFAKA_KV.put('state', JSON.stringify(state));
        
        const { processOrderLuban } = await import('./luban.js');
        context.waitUntil(processOrderLuban(env, o.order_no));
        return jsonOk({ ok: true, rev: state.rev }, env, request);

      } else if (o.source === 'smm') {
        o.status = 'processing';
        o.approved_at = nowStr();
        addLog(db, 'approve_order', `订单 ${o.order_no} 转上游 SMM`, ip, ua);
        
        state.rev = (state.rev || 0) + 1;
        await env.YUNFAKA_KV.put('state', JSON.stringify(state));

        context.waitUntil((async () => {
            try {
                const p = new URLSearchParams({ key: env.CHINAYINLIU_API_KEY, action: 'add', service: o.smm_service_id, link: o.smm_link, quantity: o.quantity });
                const r = await fetch('https://chinayinliu.com/api/v2', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: p.toString() });
                const d = await r.json();
                const raw2 = await env.YUNFAKA_KV.get('state');
                const st2 = JSON.parse(raw2);
                const o2 = st2.db.orders.find(x => x.order_no === o.order_no);
                if (d.order) { o2.smm_order_id = String(d.order); }
                else { o2.status = 'smm_error'; o2.smm_error = d.error || 'SMM提交失败'; }
                st2.rev++; await env.YUNFAKA_KV.put('state', JSON.stringify(st2));
            } catch(e) {}
        })());
        return jsonOk({ ok: true, rev: state.rev }, env, request);
      } else {
        const orderSku = o.sku_id || 0;
        const available = (db.cards || []).filter(c => c.product_id === o.product_id && c.status === 'unused' && String(c.sku_id || 0) === String(orderSku));
        if (available.length < o.quantity) {
          return jsonError(`库存不足：需 ${o.quantity}，仅余 ${available.length}`, 400, env, request);
        }
        const usedIds = new Set((db.orders || []).flatMap(x => x.cards || []));
        const safe = available.filter(c => !usedIds.has(c.content));
        const toUse = safe.length >= o.quantity ? safe.slice(0, o.quantity) : available.slice(0, o.quantity);
        toUse.forEach(c => {
          c.status = 'used';
          c.order_no = o.order_no;
          c.used_at = nowStr();
          o.cards.push(c.content);
        });
        o.status = 'delivered';
        o.delivered_at = nowStr();
        o.approved_at = nowStr();
        addLog(db, 'approve_order', `订单 ${o.order_no} 发货`, ip, ua);
      }
      changed = true;
    }

    /* ========== 驳回订单 ========== */
    else if (action === 'reject_order') {
      const o = (db.orders || []).find(x => x.order_no === body.order_no);
      if (!o) return jsonError('订单不存在', 404, env, request);
      if (o.balance_used > 0 && o.username) {
        const m = (db.members || []).find(x => x.username === o.username);
        if (m) m.balance = (m.balance || 0) + o.balance_used;
        o.refunded_amount = o.balance_used;
        o.refunded_at = nowStr();
        o.balance_used = 0;
      }
      o.status = 'rejected';
      o.rejected_at = nowStr();
      o.reject_reason = (body.reason || '').slice(0, 200);
      addLog(db, 'reject_order', `订单 ${o.order_no} 被驳回`, ip, ua);
      changed = true;
    }

    /* ========== 调整余额 ========== */
    else if (action === 'adjust_balance') {
      const m = (db.members || []).find(x => x.username === body.username);
      if (!m) return jsonError('会员不存在', 404, env, request);
      const delta = Math.round(Number(body.delta) || 0);
      if (delta === 0) return jsonError('调整金额不能为0', 400, env, request);
      const newBal = (m.balance || 0) + delta;
      if (newBal < 0) return jsonError('调整后余额不能为负', 400, env, request);
      m.balance = newBal;
      addLog(db, 'adjust_balance', `会员 ${m.username} 余额 ${delta > 0 ? '+' : ''}${(delta / 100).toFixed(2)}元`, ip, ua);
      changed = true;
    }

    /* ========== 删除订单 ========== */
    else if (action === 'delete_order') {
      const idx = (db.orders || []).findIndex(x => x.order_no === body.order_no);
      if (idx < 0) return jsonError('订单不存在', 404, env, request);
      db.orders.splice(idx, 1);
      addLog(db, 'delete_order', `删除订单 ${body.order_no}`, ip, ua);
      changed = true;
    }

    /* ========== 保存设置 ========== */
    else if (action === 'save_settings') {
      const cfg = body.config || {};
      const allowed = [
        'site_name', 'tg_chat_id', 'tg_username', 'tg_bot_token', 'tg_btn_color',
        'pay_usdt_address', 'pay_usdt_qr', 'pay_usdt_rate', 'pay_usdt_network', 'pay_usdt_enabled',
        'pay_alipay_enabled', 'pay_alipay_mode', 'pay_alipay_qr', 'pay_alipay_note',
        'pay_alipay_redpacket_prefix', 'recharge_min', 'recharge_bonus_pct', 'recharge_bonus_text',
        'smm_markup', 'smm_cost_currency', 'luban_markup', 'luban_common_cost'
      ];
      if (!db.config) db.config = {};
      allowed.forEach(k => {
        if (cfg[k] !== undefined) db.config[k] = String(cfg[k]).slice(0, 500);
      });
      if (body.new_admin_password) {
        if (String(body.new_admin_password).length < 6) {
          return jsonError('新密码至少 6 位', 400, env, request);
        }
        const ac = (await readAdminConfig(env)) || {};
        const newHash = await hashPwd(body.new_admin_password);
        await writeAdminConfig(env, { ...ac, admin_pwd_hash: newHash });
        addLog(db, 'change_admin_pwd', '修改管理员密码', ip, ua);
      }
      addLog(db, 'save_settings', '修改站点设置', ip, ua);
      changed = true;
    }

    /* ========== 重置会员密码 ========== */
    else if (action === 'reset_member_pwd') {
      const m = (db.members || []).find(x => x.username === body.username);
      if (!m) return jsonError('会员不存在', 404, env, request);
      if (!body.new_password || String(body.new_password).length < 6) {
        return jsonError('新密码至少6位', 400, env, request);
      }
      m.password = await hashPwd(body.new_password);
      addLog(db, 'reset_member_pwd', `重置会员 ${m.username} 密码`, ip, ua);
      changed = true;
    }

    /* ========== 删除会员 ========== */
    else if (action === 'delete_member') {
      const idx = (db.members || []).findIndex(x => x.username === body.username);
      if (idx < 0) return jsonError('会员不存在', 404, env, request);
      db.members.splice(idx, 1);
      addLog(db, 'delete_member', `删除会员 ${body.username}`, ip, ua);
      changed = true;
    }

    /* ========== 退款订单 ========== */
    else if (action === 'refund_order') {
      const o = (db.orders || []).find(x => x.order_no === body.order_no);
      if (!o) return jsonError('订单不存在', 404, env, request);
      if (o.balance_used > 0 && o.username) {
        const m = (db.members || []).find(x => x.username === o.username);
        if (m) m.balance = (m.balance || 0) + o.balance_used;
        o.refunded_amount = o.balance_used;
        o.refunded_at = nowStr();
        o.balance_used = 0;
      }
      o.status = 'rejected';
      o.refund_auto = true;
      addLog(db, 'refund_order', `订单 ${o.order_no} 退款`, ip, ua);
      changed = true;
    }

    else {
      return jsonError('未知操作: ' + String(action).slice(0, 30), 400, env, request);
    }

    if (changed) {
      state.rev = (state.rev || 0) + 1;
      await env.YUNFAKA_KV.put('state', JSON.stringify(state));
    }

    return jsonOk({ ok: true, rev: state.rev }, env, request);
  } catch (e) {
    return jsonError('操作失败', 500, env, request, e);
  }
}
