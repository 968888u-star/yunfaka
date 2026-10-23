// functions/api/public.js · 终极防黑防白嫖版 + 状态同步接口
import { hashPwd, hashSecret } from '../_lib/auth.js';
import { optionsResponse, jsonError, jsonOk, rateLimit, getClientIp, requireMember } from '../_lib/common.js';

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
  if (rl.blocked) return jsonError('操作过于频繁，请稍后重试', 429, env, request);
  
  try {
    const body = await request.json();
    const action = body.action || '';
    const raw = await env.YUNFAKA_KV.get('state');
    if (!raw) return jsonError('无数据', 404, env, request);
    const state = JSON.parse(raw);
    const db = state.db;
    const cfg = db.config || {};

    /* ========== 1. 更新接码验证码 ========== */
    if (action === 'update_luban_sms') {
      const orderNo = String(body.order_no || '');
      const sms = String(body.sms || '').slice(0, 200);
      if (!orderNo || !sms) return jsonError('参数缺失', 400, env, request);
      
      const o = (db.orders || []).find(x => x.order_no === orderNo);
      if (!o || o.source !== 'luban') return jsonOk({ ok: true }, env, request);

      o.luban_sms = sms;
      o.luban_code = String(body.code || sms).slice(0, 30); // 优先用前端提取的验证码数字
      o.status = 'delivered';
      if (!o.delivered_at) o.delivered_at = nowStr();

      state.rev = (state.rev || 0) + 1;
      await env.YUNFAKA_KV.put('state', JSON.stringify(state));
      return jsonOk({ ok: true }, env, request);
    }

    /* ========== 2. 确认订单支付（防支付宝白嫖） ========== */
    if (action === 'confirm_pay') {
      const orderNo = String(body.order_no || '');
      if (!orderNo) return jsonError('参数缺失', 400, env, request);
      
      const o = (db.orders || []).find(x => x.order_no === orderNo);
      if (!o) return jsonError('订单不存在', 404, env, request);
      if (o.status !== 'pending' && o.status !== 'pending_review') {
         return jsonOk({ ok: true, msg: '已经是' + o.status }, env, request);
      }

      // 【核心安全】：支付宝不能直接触发 processing，必须等后台审核
      if (o.pay_method === 'alipay') {
        o.status = 'pending_review';
        o.submitted_at = nowStr();
        state.rev = (state.rev || 0) + 1;
        await env.YUNFAKA_KV.put('state', JSON.stringify(state));
        return jsonOk({ ok: true, status: 'pending_review' }, env, request);
      }

      // USDT 或者余额直接触发
      o.status = 'processing';
      o.paid_at = nowStr();
      state.rev = (state.rev || 0) + 1;
      await env.YUNFAKA_KV.put('state', JSON.stringify(state));
      
      if (o.source === 'luban') {
        const { processOrderLuban } = await import('./luban.js');
        context.waitUntil(processOrderLuban(env, o.order_no));
      }
      return jsonOk({ ok: true, status: o.status }, env, request);
    }

    /* ========== 3. 更新订单状态（专治前端状态不同步） ========== */
    if (action === 'update_order_status') {
      const orderNo = String(body.order_no || '');
      const newStatus = String(body.status || '');
      const o = (db.orders || []).find(x => x.order_no === orderNo);
      if (!o) return jsonError('订单不存在', 404, env, request);
      
      // 安全限制：只允许特定状态流转
      const allowedStatuses = ['pending_review', 'processing', 'rejected'];
      if (!allowedStatuses.includes(newStatus)) return jsonError('无效状态', 400, env, request);
      
      // 支付宝订单只允许 pending -> pending_review
      if (o.pay_method === 'alipay' && o.status === 'pending' && newStatus !== 'pending_review') {
          return jsonError('非法状态流转', 400, env, request);
      }
      
      o.status = newStatus;
      if (newStatus === 'pending_review') o.submitted_at = nowStr();
      if (newStatus === 'processing') o.paid_at = nowStr();
      if (newStatus === 'rejected') o.completed_at = nowStr();
      
      state.rev = (state.rev || 0) + 1;
      await env.YUNFAKA_KV.put('state', JSON.stringify(state));
      
      // 如果是余额或 USDT，转为 processing 时必须触发接码
      if (newStatus === 'processing' && o.source === 'luban') {
        const { processOrderLuban } = await import('./luban.js');
        context.waitUntil(processOrderLuban(env, orderNo));
      }
      return jsonOk({ ok: true, status: o.status }, env, request);
    }

    /* ========== 4. 下单（防 0 元购） ========== */
    if (action === 'create_order') {
      const isVirtual = body.source === 'luban' || body.source === 'smm' || body.product_id === 0;
      let product = null;
      let price = 0;

      if (isVirtual) {
        if (body.source === 'luban') {
          if (body.luban_type === 'common') {
            price = Math.round((Number(cfg.luban_common_cost) || 2) * (Number(cfg.luban_markup) || 1.3) * 100);
          } else {
            const exist = (db.products || []).find(p => p.luban_service_id === body.luban_service_id);
            if (exist) price = exist.price;
            else {
               const reqAmount = Number(body.amount) || 0;
               if (reqAmount < 100) return jsonError('价格异常，拒绝下单', 400, env, request); 
               price = reqAmount; 
            }
          }
        } else if (body.source === 'smm') {
          const exist = (db.products || []).find(p => p.smm_service_id === body.smm_service_id);
          if (exist) price = exist.price * (body.quantity || 1);
          else {
             const reqAmount = Number(body.amount) || 0;
             if (reqAmount < 100) return jsonError('价格异常，拒绝下单', 400, env, request);
             price = reqAmount;
          }
        }
        
        product = {
          id: body.product_id || 0,
          name: body.product_name || '虚拟商品',
          price: price,
          source: body.source,
          luban_type: body.luban_type,
          luban_service_id: body.luban_service_id,
          active: true
        };
      } else {
        product = (db.products || []).find(p => p.id === body.product_id);
        if (product) price = product.price;
      }

      if (!product) return jsonError('商品不存在', 404, env, request);
      if (!product.active) return jsonError('商品已下架', 400, env, request);
      
      const quantity = Math.max(1, Math.min(50, parseInt(body.quantity) || 1));
      const amount = price * quantity;
      const secret = String(body.secret || '').slice(0, 60);
      if (!secret) return jsonError('请输入暗号', 400, env, request);

      const username = String(body.username || '').slice(0, 20);
      let member = null;
      if (body.use_balance) {
        const memPayload = await requireMember(request, env);
        if (!memPayload) return jsonError('请先登录会员', 401, env, request);
        member = (db.members || []).find(m => m.username === memPayload.username);
      } else if (username) {
        member = (db.members || []).find(m => m.username === username) || null;
      }

      let balanceUsed = 0;
      if (body.use_balance && member && cfg.balance_enabled !== false) {
        balanceUsed = Math.min(member.balance || 0, amount);
        if (balanceUsed > 0) member.balance -= balanceUsed;
      }
      const amountDue = amount - balanceUsed;
      const payMethod = String(body.pay_method || '').slice(0, 20) || (amountDue === 0 ? 'balance' : 'usdt');
      
      const orderNo = body.order_no && /^\d{14,24}$/.test(body.order_no) ? body.order_no : genOrderNo();
      const rate = Number(cfg.pay_usdt_rate) || 7.2;
      
      const order = {
        order_no: orderNo,
        product_id: product.id,
        product_name: product.name,
        quantity,
        amount,
        balance_used: balanceUsed,
        amount_due: amountDue,
        secret,
        username: member ? member.username : '',
        status: 'pending',
        pay_method: payMethod,
        cards: [],
        created_at: nowStr(),
        source: product.source,
        luban_type: product.luban_type || body.luban_type || '',
        luban_service_id: product.luban_service_id || body.luban_service_id || '',
        luban_keyword: String(body.luban_keyword || '').slice(0, 100),
        luban_cardtype: String(body.luban_cardtype || '').slice(0, 50),
        luban_filter: String(body.luban_filter || '').slice(0, 10),
        luban_phone: '',
        usdt_rate: rate
      };
      
      if (payMethod === 'usdt' && amountDue > 0) {
        const baseUsdt = amountDue / 100 / rate;
        const micro = Math.floor(Math.random() * 9999) + 1;
        order.expected_usdt_exact = Math.round((baseUsdt + micro / 1e6) * 1e6) / 1e6;
      }
      if (payMethod === 'alipay') {
        const prefix = String(cfg.pay_alipay_redpacket_prefix || 'YFK').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'YFK';
        order.redpacket_code = prefix + randStr(6);
      }
      db.orders.unshift(order);
      
      if (amountDue === 0) {
        if (order.source === 'luban') {
          order.status = 'processing';
        } else {
          order.status = 'delivered';
        }
      }
      
      state.rev = (state.rev || 0) + 1;
      await env.YUNFAKA_KV.put('state', JSON.stringify(state));
      
      if (amountDue === 0 && order.source === 'luban') {
        const { processOrderLuban } = await import('./luban.js');
        context.waitUntil(processOrderLuban(env, order.order_no));
      }
      return jsonOk({ ok: true, order_no: orderNo, status: order.status, expected_usdt_exact: order.expected_usdt_exact || 0 }, env, request);
    }

    /* ========== 5. 充值 ========== */
    if (action === 'create_recharge') {
      const memPayload = await requireMember(request, env);
      if (!memPayload) return jsonError('请先登录会员', 401, env, request);
      const member = (db.members || []).find(m => m.username === memPayload.username);
      if (!member) return jsonError('会员不存在', 404, env, request);
      const amount = Math.round(Number(body.amount) || 0);
      const min = Number(cfg.recharge_min) || 1000;
      if (!(amount >= min)) return jsonError(`最低充值 ¥${(min/100).toFixed(2)}`, 400, env, request);
      const method = String(body.method || 'usdt').slice(0, 20);
      const id = 'R' + Date.now() + Math.floor(Math.random() * 900 + 100);
      const rate = Number(cfg.pay_usdt_rate) || 7.2;
      const rc = { id, username: member.username, secret: member.secret || '', amount, method, status: 'pending', created_at: nowStr(), usdt_rate: rate };
      if (method === 'usdt') {
        const baseUsdt = amount / 100 / rate;
        const micro = Math.floor(Math.random() * 9999) + 1;
        rc.expected_usdt_exact = Math.round((baseUsdt + micro / 1e6) * 1e6) / 1e6;
      }
      if (method === 'alipay') {
        const prefix = String(cfg.pay_alipay_redpacket_prefix || 'YFK').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'YFK';
        rc.redpacket_code = prefix + randStr(6);
      }
      if (!Array.isArray(db.recharges)) db.recharges = [];
      db.recharges.unshift(rc);
      state.rev = (state.rev || 0) + 1;
      await env.YUNFAKA_KV.put('state', JSON.stringify(state));
      return jsonOk({ ok: true, id, status: 'pending', expected_usdt_exact: rc.expected_usdt_exact || 0 }, env, request);
    }

    /* ========== 6. 注册 ========== */
    if (action === 'register_member') {
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const secret = String(body.secret || '').trim();
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return jsonError('账号格式错误', 400, env, request);
      if ((db.members || []).some(m => m.username === username)) return jsonError('账号已注册', 409, env, request);
      db.members.push({ username, password: await hashPwd(password), secret: await hashSecret(secret), balance: 0, created_at: nowStr() });
      state.rev = (state.rev || 0) + 1;
      await env.YUNFAKA_KV.put('state', JSON.stringify(state));
      return jsonOk({ ok: true, username }, env, request);
    }

    return jsonError('未知操作', 400, env, request);
  } catch (e) {
    return jsonError('操作失败', 500, env, request, e);
  }
}
