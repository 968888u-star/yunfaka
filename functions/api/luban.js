// ==================================================================
// LubanSms API 统一入口（正确路径版）
// 真实路径来自官方文档，不要修改
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
  const USD_TO_CNY = 7.2;

  function buildUrl(path, params) {
    const p = new URLSearchParams();
    p.set('apikey', apikey);
    Object.keys(params || {}).forEach(function(k){
      const v = params[k];
      if (v !== undefined && v !== null && v !== '') p.set(k, v);
    });
    return BASE + path + '?' + p.toString();
  }
  function ok(data) { return Response.json(data, { headers: corsHeaders }); }

  try {
    // ---------- 账户 ----------
    if (action === 'balance') {
      const r = await fetch(buildUrl('getBalance', {}));
      const d = await r.json();
      return ok(d);
    }

    // ---------- 国家列表（countries）----------
    if (action === 'countries') {
      const r = await fetch(buildUrl('countries', {}));
      const d = await r.json();
      return ok(d);
    }

    // ---------- 服务列表（List，大写 L）----------
    if (action === 'services') {
      const params = {
        language: url.searchParams.get('language') || 'zh',
        page: url.searchParams.get('page') || '1',
      };
      const countryName = url.searchParams.get('countryName');
      const service = url.searchParams.get('service');
      if (countryName) params.country = countryName;
      if (service) params.service = service;
      const r = await fetch(buildUrl('List', params));
      const d = await r.json();
      // 加价 30%
      if (d.code === 0 && Array.isArray(d.msg)) {
        d.msg = d.msg.map(function(item){
          if (item.cost !== undefined) {
            item.origin_cost = item.cost;
            item.cost = Math.round(parseFloat(item.cost) * MARKUP * 100) / 100;
          }
          return item;
        });
      }
      return ok(d);
    }

    // ---------- 请求号码（验证码接收）----------
    if (action === 'request_number') {
      const serviceId = url.searchParams.get('service_id');
      if (!serviceId) return ok({ ok: false, msg: '缺少 service_id' });
      const r = await fetch(buildUrl('getNumber', { service_id: serviceId }));
      const d = await r.json();
      return ok(d);
    }

    // ---------- 获取短信（验证码接收）----------
    if (action === 'get_sms') {
      const requestId = url.searchParams.get('request_id');
      if (!requestId) return ok({ ok: false, msg: '缺少 request_id' });
      const r = await fetch(buildUrl('getSms', { request_id: requestId }));
      const d = await r.json();
      return ok(d);
    }

    // ---------- 更改请求状态（释放号码）----------
    if (action === 'change_status') {
      const requestId = url.searchParams.get('request_id');
      const status = url.searchParams.get('status') || 'reject';
      if (!requestId) return ok({ ok: false, msg: '缺少 request_id' });
      const r = await fetch(buildUrl('setStatus', { request_id: requestId, status: status }));
      const d = await r.json();
      return ok(d);
    }

    // ---------- 重新激活号码（getAgainNmber，官方拼写如此）----------
    if (action === 'reactivate') {
      const requestId = url.searchParams.get('request_id');
      if (!requestId) return ok({ ok: false, msg: '缺少 request_id' });
      const r = await fetch(buildUrl('getAgainNmber', { request_id: requestId }));
      const d = await r.json();
      return ok(d);
    }

    // ---------- 通用短信：请求号码（getKeywordNumber）----------
    if (action === 'common_request') {
      const phone = url.searchParams.get('phone') || '';
      const params = phone ? { phone: phone } : {};
      const r = await fetch(buildUrl('getKeywordNumber', params));
      const d = await r.json();
      return ok(d);
    }

    // ---------- 通用短信：获取短信（getKeywordSms）----------
    if (action === 'common_get_sms') {
      const phone = url.searchParams.get('phone');
      const keyword = url.searchParams.get('keyword') || '';
      if (!phone) return ok({ ok: false, msg: '缺少 phone' });
      const r = await fetch(buildUrl('getKeywordSms', { phone: phone, keyword: keyword }));
      const d = await r.json();
      return ok(d);
    }

    // ---------- 通用短信：释放号码（delKeywordNumber）----------
    if (action === 'common_release') {
      const phone = url.searchParams.get('phone');
      if (!phone) return ok({ ok: false, msg: '缺少 phone' });
      const r = await fetch(buildUrl('delKeywordNumber', { phone: phone }));
      const d = await r.json();
      return ok(d);
    }

    return ok({ ok: false, msg: '未知 action: ' + action });
  } catch (e) {
    return ok({ ok: false, msg: e.message });
  }
}
