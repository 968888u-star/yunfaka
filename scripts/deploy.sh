#!/usr/bin/env bash
# scripts/deploy.sh · 云发卡一键部署到 Cloudflare Pages（Direct Upload 模式）
# 依赖：node>=16, npx, curl
# 用法：
#   export CF_API_TOKEN="你的Cloudflare API Token"   # 权限：Account:Cloudflare Pages:Edit, Workers KV:Edit, Account Settings:Read
#   export CF_ACCOUNT_ID="你的Account ID"             # 仪表盘 URL 中 https://dash.cloudflare.com/<account_id>
#   export CF_PROJECT_NAME="yunfaka"                  # 可选，默认 yunfaka
#   bash scripts/deploy.sh
#
# 可选环境变量（对应平台功能，留空则该功能关闭）：
#   ACCESS_TOKEN      ADMIN_SECRET     TRONGRID_API_KEY  CHINAYINLIU_API_KEY
#   LUBAN_APIKEY      HUMKT_TOKEN      GH_TOKEN          GIST_ID
#   BACKUP_SECRET     SMM_SYNC_KEY     TG_BOT_TOKEN
set -euo pipefail

PROJECT_NAME="${CF_PROJECT_NAME:-yunfaka}"
API="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}"
AUTH=(-H "Authorization: Bearer ${CF_API_TOKEN}" -H "Content-Type: application/json")

echo "==> [1/6] 校验 Cloudflare Token 与 Account ID"
curl -sS "${AUTH[@]}" "https://api.cloudflare.com/client/v4/user/tokens/verify" | grep -q '"success":true' || { echo "✗ Token 无效或无权限"; exit 1; }

echo "==> [2/6] 创建/获取 KV 命名空间 YUNFAKA_KV"
KV_ID=$(curl -sS "${AUTH[@]}" "${API}/storage/kv/namespaces?per_page=100" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);const n=(r.result||[]).find(x=>x.title==='YUNFAKA_KV');console.log(n?n.id:'')})")
if [ -z "$KV_ID" ]; then
  KV_ID=$(curl -sS -X POST "${AUTH[@]}" "${API}/storage/kv/namespaces" \
    --data '{"title":"YUNFAKA_KV"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(JSON.parse(d).result.id)})")
  echo "    新建 KV: $KV_ID"
else
  echo "    复用已有 KV: $KV_ID"
fi

# 回填 wrangler.toml
sed -i "s/REPLACE_WITH_KV_NAMESPACE_ID/${KV_ID}/g" wrangler.toml

echo "==> [3/6] 创建 Pages 项目（如不存在）"
if ! curl -sS "${AUTH[@]}" "${API}/pages/projects/${PROJECT_NAME}" | grep -q '"success":true'; then
  curl -sS -X POST "${AUTH[@]}" "${API}/pages/projects" \
    --data "{\"name\":\"${PROJECT_NAME}\",\"production_branch\":\"main\",\"build_config\":{\"build_command\":\"\",\"destination_dir\":\"public\"}}" >/dev/null
  echo "    已创建项目: ${PROJECT_NAME}"
else
  echo "    项目已存在: ${PROJECT_NAME}"
fi

echo "==> [4/6] 绑定 KV 到生产环境"
curl -sS -X PATCH "${AUTH[@]}" "${API}/pages/projects/${PROJECT_NAME}" \
  --data "{\"deployment_configs\":{\"production\":{\"kv_namespaces\":{\"YUNFAKA_KV\":{\"namespace_id\":\"${KV_ID}\"}}}}}" >/dev/null

echo "==> [5/6] 设置环境变量（已在环境中声明的才会写入）"
VARS=(ACCESS_TOKEN ADMIN_SECRET TRONGRID_API_KEY CHINAYINLIU_API_KEY LUBAN_APIKEY HUMKT_TOKEN GH_TOKEN GIST_ID BACKUP_SECRET SMM_SYNC_KEY TG_BOT_TOKEN)
ENV_JSON="{}"
for v in "${VARS[@]}"; do
  val="${!v:-}"
  if [ -n "$val" ]; then
    ENV_JSON=$(echo "$ENV_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d);o['${v}']={type:'plain_text',value:'${val//\'/\\\''}'};console.log(JSON.stringify(o))})")
  fi
done
if [ "$ENV_JSON" != "{}" ]; then
  curl -sS -X PATCH "${AUTH[@]}" "${API}/pages/projects/${PROJECT_NAME}" \
    --data "{\"deployment_configs\":{\"production\":{\"env_vars\":${ENV_JSON}}}}" >/dev/null
  echo "    已写入变量: $(echo "$ENV_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(Object.keys(JSON.parse(d)).join(', ')))")"
else
  echo "    未设置额外环境变量（功能默认关闭，可后续在仪表盘添加）"
fi

echo "==> [6/6] 上传部署（wrangler pages deploy）"
npx --yes wrangler@3 pages deploy public --project-name="${PROJECT_NAME}" --branch=main

echo ""
echo "✅ 部署完成！"
echo "   项目: https://dash.cloudflare.com/${CF_ACCOUNT_ID}/pages/view/${PROJECT_NAME}"
echo "   默认管理员密码: admin888（登录后请立即在「设置」中修改）"
echo "   首次打开站点会自动初始化数据（KV 为空时 seed 默认分类）"
