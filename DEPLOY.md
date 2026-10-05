# 云发卡 · Cloudflare Pages 部署指南

## 方式一：一键脚本（推荐，全自动）

1. 在 Cloudflare 右上角「我的资料 → API Tokens」创建 Token，模板选 **Edit Cloudflare Workers**（包含 Pages + KV 权限），或自定义权限：
   - Account · Cloudflare Pages · Edit
   - Account · Workers KV Storage · Edit
   - Account · Account Settings · Read
2. 获取 **Account ID**：仪表盘 URL `https://dash.cloudflare.com/<这一串就是Account ID>`
3. 执行：
   ```bash
   export CF_API_TOKEN="你的Token"
   export CF_ACCOUNT_ID="你的Account ID"
   npm run deploy
   ```
   脚本自动完成：校验 Token → 创建 KV → 创建 Pages 项目 → 绑定 KV → 写入环境变量 → 上传部署。

## 方式二：Git 连接（仪表盘手动一次，后续 push 自动部署）

1. 仪表盘 → Workers & Pages → Create → Pages → Connect to Git → 选 `yunfaka` 仓库
2. 构建设置：
   - Framework preset: None
   - Build command: （留空）
   - Build output directory: `public`
3. 创建后进入项目 → Settings → Functions：
   - KV namespace bindings → 添加绑定，变量名 `YUNFAKA_KV`（先在 Workers & Pages → KV 创建命名空间）
   - Environment variables → 按需添加（见下表）
4. 重新部署一次（Deployment → Retry deployment）

## 环境变量清单（均可选，不配则对应功能关闭）

| 变量 | 作用 |
|---|---|
| `ACCESS_TOKEN` | 开启后 `/api/state` 写入需带 `X-Access-Token` 头（防篡改） |
| `ADMIN_SECRET` | 管理员 Session 签名密钥（务必改，默认弱） |
| `TRONGRID_API_KEY` | USDT-TRC20 到账检测（TronGrid 免费额度） |
| `CHINAYINLIU_API_KEY` | SMM 推广上游（chinayinliu.com）自动下单 |
| `LUBAN_APIKEY` | 鲁班接码上游（lubansms.com） |
| `HUMKT_TOKEN` | Humkt 上游对接 |
| `GH_TOKEN` + `GIST_ID` | 数据自动备份到 GitHub Gist |
| `BACKUP_SECRET` | 从备份恢复的鉴权密钥 |
| `SMM_SYNC_KEY` | SMM 商品同步接口保护密钥 |
| `TG_BOT_TOKEN` | TG 通知兜底 Token（也可在后台设置里填） |

## 部署后

- 访问 `https://<项目名>.pages.dev`，首次打开自动初始化默认分类
- 管理后台：页面底部「管理」入口，默认密码 **`admin888`**，登录后立即在「设置」修改
- 数据存储在 KV 的 `state` 键；建议配置 `GH_TOKEN`+`GIST_ID` 开启自动备份
