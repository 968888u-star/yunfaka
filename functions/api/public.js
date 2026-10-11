// functions/api/public.js · 普通用户公开写入口
// 支持：下单 / 充值 / 注册 / 到货提醒
// 后端完全控制业务逻辑（价格、库存、余额），前端只提交"意图"
import { hashPwd, hashSecret } from '../_lib/auth.js';
import { optionsResponse, jsonError, jsonOk, rateLimit, getClientIp } from '../_lib/common.js';

function nowStr() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
function randStr(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function genOrderNo() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${Math.floor(Math.random()*900000+100000)}`;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return optionsResponse(request, env);
  if (request.method !== 'POST') return jsonError('Method not allowed', 405, env, request);

  const ip = getClientIp(request);
  const rl = await rateLimit(env.YUNFAKA_KV, 'pub:' + ip, 30, 60000);
  if (rl.blocked) return jsonError('操作过于频繁，请稍后再试', 429, env, request);

  try {
    const body = await request.json();
    const action = body.action || '';
    const raw = await env.YUNFAKA_KV.get('state');
    if (!raw) return jsonError('无数据', 404, env, request);
    const state = JSON.parse(raw);
    const db = state.db;
    const cfg = db.config || {};

    /* ========== 下单 ========== */
    if (action === 'create_order') {
      const product = (db.products || []).find(p => p.id === body.product_id);
      if (!product) return jsonError('商品不存在', 404, env, request);
      if (!product.active) return jsonError('商品已下架', 400, env, request);

      // 后端权威定价：忽略前端传来的 price
      let price = product.price || 0;
      let skuName = '';
      if (body.sku_id) {
        const sku = (product.skus || []).find(s => String(s.id) === String(body.sku_id));
        if (!sku) return jsonError('规格不存在', 400, env, request);
        price = sku.price;
        skuName = sku.name;
      }

      const quantity = Math.max(1, Math.min(50, parseInt(body.quantity) || 1));
      const amount = price * quantity;
      const secret = String(body.secret || '').slice(0, 60);
      if (!secret) return jsonError('请输入暗号', 400, env, request);

      // 会员身份（前端会带上会员账号，但这是弱标识，只用于记录）
      const username = String(body.username || '').slice(0, 20);
      const member = username ? (db.members || []).find(m => m.username === username) : null;

      // 余额抵扣
      let balanceUsed = 0;
      if (body.use_balance && member && cfg.balance_enabled !== false) {
        balanceUsed = Math.min(member.balance || 0, amount);
        if (balanceUsed > 0) member.balance -= balanceUsed;
      }
      const amountDue = amount - balanceUsed;

      const payMethod = String(body.pay_method || '').slice(0, 20) || (amountDue === 0 ? 'balance' : 'usdt');
      if (amountDue > 0 && !['alipay', 'usdt'].includes(payMethod)) {
        return jsonError('无效的支付方式', 400, env, request);
      }

      const orderNo = body.order_no && /^\d{14,24}$/.test(body.order_no) ? body.order_no : genOrderNo();
      if ((db.orders || []).some(o => o.order_no === orderNo)) {
        return jsonError('订单号冲突，请重试', 409, env, request);
      }

      const order = {
        order_no: orderNo,
        product_id: product.id,
        product_name: product.name,
        sku_id: body.sku_id || 0,
        sku_name: skuName,
        category_id: product.category_id || 0,
        quantity,
        amount,
        balance_used: balanceUsed,
        amount_due: amountDue,
        secret,
        username,
        status: 'pending',
        pay_method: payMethod,
        cards: [],
        note: product.note || '',
        created_at: nowStr(),
        delivered_at: '',
        source: product.source || 'local',
        luban_type: product.luban_type || '',
        luban_service_id: product.luban_service_id || '',
        luban_service_name: product.luban_service_name || '',
        luban_country: product.luban_country || '',
        usdt_rate: Number(cfg.pay_usdt_rate) || 7.2
      };

      if (payMethod === 'alipay') {
        const prefix = String(cfg.pay_alipay_redpacket_prefix || 'YFK').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'YFK';
        order.redpacket_code = prefix + randStr(6);
      }

      db.orders.unshift(order);

      // 余额充足：立即发货
      if (amountDue === 0) {
        if (order.source === 'local') {
          const orderSku = order.sku_id || 0;
          const available = (db.cards || []).filter(c =>
            c.product_id === order.product_id && c.status === 'unused' &&
            String(c.sku_id || 0) === String(orderSku));
          if (available.length >= order.quantity) {
            available.slice(0, order.quantity).forEach(c => {
              c.status = 'used'; c.order_no = order.order_no; c.used_at = nowStr();
              order.cards.push(c.content);
            });
            order.status = 'delivered';
            order.delivered_at = nowStr();
          } else if (available.length === 0 && order.product_id) {
            order.status = 'out_of_stock';
          } else {
            order.status = 'out_of_stock';
          }
        } else {
          order.status = 'processing';  // Luban/SMM 上游由后续流程处理
        }
      }

      state.rev = (state.rev || 0) + 1;
      await env.YUNFAKA_KV.put('state', JSON.stringify(state));

      // 通知店主
      context.waitUntil(notifyTg(cfg, `🔔 新订单\n订单号：<code>${orderNo}</code>\n商品：${order.product_name}\n数量：${quantity}\n金额：¥${(amount/100).toFixed(2)}\n状态：${order.status}`));

      return jsonOk({ ok: true, order_no: orderNo, status: order.status }, env, request);
    }

    /* ========== 充值 ========== */
    if (action === 'create_recharge') {
      const username = String(body.username || '').slice(0, 20);
      if (!username) return jsonError('请先登录会员', 400, env, request);
      const member = (db.members || []).find(m => m.username === username);
      if (!member) return jsonError('会员不存在', 404, env, request);

      const amount = Math.round(Number(body.amount) || 0);
      const min = Number(cfg.recharge_min) || 1000;
      if (!(amount >= min)) return jsonError(`最低充值 ¥${(min/100).toFixed(2)}`, 400, env, request);

      const method = String(body.method || 'usdt').slice(0, 20);
      if (!['alipay', 'usdt'].includes(method)) return jsonError('无效支付方式', 400, env, request);

      const id = 'R' + Date.now() + Math.floor(Math.random() * 900 + 100);
      const rc = {
        id, username, secret: member.secret || '', amount, method,
        status: 'pending', created_at: nowStr(), completed_at: '',
        usdt_rate: Number(cfg.pay_usdt_rate) || 7.2
      };
      if (method === 'alipay') {
        const prefix = String(cfg.pay_alipay_redpacket_prefix || 'YFK').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'YFK';
        rc.redpacket_code = prefix + randStr(6);
      }
      db.recharges.unshift(rc);
      state.rev = (state.rev || 0) + 1;
      await env.YUNFAKA_KV.put('state', JSON.stringify(state));
      return jsonOk({ ok: true, id, status: 'pending' }, env, request);
    }

    /* ========== 注册 ========== */
    if (action === 'register_member') {
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const secret = String(body.secret || '').trim();
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
        return jsonError('账号长度 3-20 位字母数字下划线', 400, env, request);
      }
      if (password.length < 6) return jsonError('密码至少 6 位', 400, env, request);
      if (secret.length < 2) return jsonError('暗号至少 2 个字符', 400, env, request);
      if ((db.members || []).some(m => m.username === username)) {
        return jsonError('该账号已被注册', 409, env, request);
      }
      db.members.push({
        username,
        password: hashPwd(password),
        secret: hashSecret(secret),
        balance: 0,
        created_at: nowStr()
      });
      state.rev = (state.rev || 0) + 1;
      await env.YUNFAKA_KV.put('state', JSON.stringify(state));
      return jsonOk({ ok: true, username }, env, request);
    }

    /* ========== 到货提醒 ========== */
    if (action === 'notify_stock') {
      const pid = Number(body.product_id);
      const product = (db.products || []).find(p => p.id === pid);
      if (!product) return jsonError('商品不存在', 404, env, request);
      const contact = String(body.contact || '').slice(0, 100);
      if (!contact) return jsonError('请留下联系方式', 400, env, request);
      if (!Array.isArray(db.stock_notifies)) db.stock_notifies = [];
      db.stock_notifies.unshift({
        id: 'N' + Date.now(),
        product_id: pid,
        product_name: product.name,
        contact,
        created_at: nowStr(),
        notified: false
      });
      state.rev = (state.rev || 0) + 1;
      await env.YUNFAKA_KV.put('state', JSON.stringify(state));
      return jsonOk({ ok: true }, env, request);
    }

    return jsonError('未知操作', 400, env, request);
  } catch (e) {
    return jsonError('操作失败', 500, env, request, e);
  }
}

async function notifyTg(cfg, text) {
  if (!cfg.tg_bot_token || !cfg.tg_chat_id) return;
  try {
    await fetch(`https://api.telegram.org/bot${cfg.tg_bot_token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.tg_chat_id, text, parse_mode: 'HTML' })
    });
  } catch (e) {}
}
