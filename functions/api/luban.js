// ==================================================================
// LubanSms 统一 API 入口
// 如果路径名报 404，请联系 LubanSms 客服确认准确路径
// 常见路径可能在：getBalance / getCountryList / getServiceList /
//               getNumber / getSms / setStatus / reactivateNumber /
//               getSmsHistory / getPhone / getMessage / releasePhone /
//               getMessageHistory
// ==================================================================

export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

  const apikey = env.LUBAN_APIKEY;
  if (!apikey) return Response.json({ ok: false, msg: '未配置 LUBAN_APIKEY 环境变量' }, { headers: corsHeaders });

  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const BASE = 'https://lubansms.com/v2/api/';
  const MARKUP = 1.3;

  function buildUrl(path, params) {
    const p = new URLSearchParams();
    p.set('apikey', apikey);
    Object.keys(params || {}).forEach(function(k){
      const v = params[k];
      if (v !== undefined && v !== null && v !== '') p.set(k, v);
    });
    return BASE + path + '?' + p.toString();
  }
  function markupCost(cost) {
    const n = parseFloat(cost) || 0;
    return Math.round(n * MARKUP * 100) / 100;
  }
  function ok(data) { return Response.json(data, { headers: corsHeaders }); }

  try {
    // ---------- 账户 ----------
    if (action === 'balance') {
      const r = await fetch(buildUrl('getBalance', {}));
      const d = await r.json();
      return ok(d);
    }

    // ---------- 通用 ----------
    if (action === 'countries') {
      const r = await fetch(buildUrl('getCountryList', {}));
      const d = await r.json();
      return ok(d);
    }

    if (action === 'services') {
      const params = {
        language: url.searchParams.get('language') || 'zh',
        page: url.searchParams.get('page') || '1',
      };
      const countryName = url.searchParams.get('countryName');
      const service = url.searchParams.get('service');
      if (countryName) params.countryName = countryName;
      if (service) params.service = service;
      const r = await fetch(buildUrl('getServiceList', params));
      const d = await r.json();
      if (d.code === 0 && Array.isArray(d.msg)) {
        d.msg = d.msg.map(function(item){
          if (item.cost !== undefined) {
            item.origin_cost = item.cost;
            item.cost = markupCost(item.cost);
          }
          return item;
        });
      }
      return ok(d);
    }

    if (action === 'sms_history') {
      const params = {
        language: url.searchParams.get('language') || 'zh',
        page: url.searchParams.get('page') || '1',
      };
      const r = await fetch(buildUrl('getSmsHistory', params));
      const d = await r.json();
      return ok(d);
    }

    // ---------- 验证码接收 ----------
    if (action === 'request_number') {
      const serviceId = url.searchParams.get('service_id');
      if (!serviceId) return ok({ ok: false, msg: '缺少 service_id' });
      const r = await fetch(buildUrl('getNumber', { service_id: serviceId }));
      const d = await r.json();
      return ok(d);
    }

    if (action === 'get_sms') {
      const requestId = url.searchParams.get('request_id');
      if (!requestId) return ok({ ok: false, msg: '缺少 request_id' });
      const r = await fetch(buildUrl('getSms', { request_id: requestId }));
      const d = await r.json();
      return ok(d);
    }

    if (action === 'change_status') {
      const requestId = url.searchParams.get('request_id');
      const status = url.searchParams.get('status') || 'reject';
      if (!requestId) return ok({ ok: false, msg: '缺少 request_id' });
      const r = await fetch(buildUrl('setStatus', { request_id: requestId, status: status }));
      const d = await r.json();
      return ok(d);
    }

    if (action === 'reactivate') {
      const requestId = url.searchParams.get('request_id');
      if (!requestId) return ok({ ok: false, msg: '缺少 request_id' });
      const r = await fetch(buildUrl('reactivateNumber', { request_id: requestId }));
      const d = await r.json();
      return ok(d);
    }

    // ---------- 通用短信接收 ----------
    if (action === 'common_request') {
      const phone = url.searchParams.get('phone') || '';
      const params = phone ? { phone: phone } : {};
      const r = await fetch(buildUrl('getPhone', params));
      const d = await r.json();
      return ok(d);
    }

    if (action === 'common_get_sms') {
      const phone = url.searchParams.get('phone');
      const keyword = url.searchParams.get('keyword') || '';
      if (!phone) return ok({ ok: false, msg: '缺少 phone' });
      const r = await fetch(buildUrl('getMessage', { phone: phone, keyword: keyword }));
      const d = await r.json();
      return ok(d);
    }

    if (action === 'common_release') {
      const phone = url.searchParams.get('phone');
      if (!phone) return ok({ ok: false, msg: '缺少 phone' });
      const r = await fetch(buildUrl('releasePhone', { phone: phone }));
      const d = await r.json();
      return ok(d);
    }

    if (action === 'common_history') {
      const page = url.searchParams.get('page') || '1';
      const r = await fetch(buildUrl('getMessageHistory', { page: page }));
      const d = await r.json();
      return ok(d);
    }

    return ok({ ok: false, msg: '未知 action: ' + action });
  } catch (e) {
    return ok({ ok: false, msg: e.message });
  }
}
