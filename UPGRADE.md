# 云发卡 · 安全加固升级指南（v2 → v3）

> 本次升级修复了全部 16 个已知安全漏洞，包含 **5 个严重**、**5 个高危**、**6 个中危**。
> 升级涉及破坏性变更，部署前请务必通读本文。

## 一、部署前必做（5 分钟）

### 1. 配置环境变量（Cloudflare Pages → Settings → Functions → Environment variables）

| 变量 | 是否必填 | 说明 |
|---|---|---|
| `ADMIN_SECRET` | **必填** | JWT 签名密钥，随机 32 位以上。**缺失则登录接口直接拒绝服务** |
| `ACCESS_TOKEN` | 建议填 | 兼容旧前端写入，随机 32 位（与 ADMIN_SECRET 不同） |
| `SMM_SYNC_KEY` | 建议填 | SMM 商品同步密钥，调用时放 `X-Sync-Key` 请求头 |
| `BACKUP_SECRET` | 建议填 | 备份/恢复密钥，调用时放 `X-Backup-Secret` 请求头 |
| `ALLOWED_ORIGINS` | 可选 | 允许跨域的域名，逗号分隔，如 `https://shop.example.com`。不填则仅同源 |

生成随机密钥（本地执行）：
```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

### 2. 记录当前管理员密码
升级后旧密码仍可登录（自动兼容旧哈希），登录成功后会自动升级为 PBKDF2 格式。**无需重新注册**。

### 3. 备份当前数据
后台 → 设置 → 导出数据，或确认 Gist 备份正常。升级不改变数据结构，仅新增字段。

## 二、破坏性变更说明

| 变更 | 影响 | 前端是否需要改 |
|---|---|---|
| `GET /api/state` 未登录返回脱敏数据（无卡密内容/订单/会员密码） | 公开页面正常（商品列表保留）；管理后台登录后需**重新拉取一次**完整数据 | 建议：登录成功后重新 `fetch('/api/state', {headers:{'X-Admin-Token': token}})` |
| `POST /api/state` 必须携带 `X-Admin-Token`（或兼容 `X-Access-Token`） | 未登录无法写入 | 前端保存设置时确保已登录并携带 token |
| `GET /api/smm-auto-sync` 密钥改走 `X-Sync-Key` 请求头（不再用 `?key=`） | 定时任务调用方式需改 | 改 cron 任务的请求头：`X-Sync-Key: xxx` |
| `GET /api/backup` 恢复/触发备份都需要 `X-Backup-Secret` 或管理员 token | 定时备份任务需加请求头 | 改 cron 任务请求头 |
| `GET /api/auto-refund` 需要会员/管理员登录 | 公开退款接口关闭 | 前端退款按钮需携带 `X-Member-Token`（会员登录接口已返回 token） |
| 密码哈希升级为 PBKDF2 | 首次登录自动升级，无感 | 无 |
| 会员暗号升级为哈希存储 | 首次找回密码自动升级 | 无 |
| CORS 从 `*` 收紧为同源/白名单 | 跨域调用被拦截（正常前端不受影响） | 无 |

## 三、部署步骤

1. 把 `functions/` 和 `public/_headers` 替换为本次升级后的版本
2. 在 Cloudflare Pages 配置上述环境变量（Production 环境）
3. 触发部署（git push 或 Retry deployment）
4. 部署完成后验证：
   - 匿名访问 `https://你的域名/api/state` → 返回数据中**不应包含** `cards` 数组、会员密码/暗号、`tg_bot_token`、`admin_pwd_hash`
   - 访问管理后台 → 用原密码登录 → 应正常登录（返回 `need_change: true` 表示仍是默认密码，需立即修改）
   - 保存一次设置 → 确认写入成功

## 四、升级后建议立即执行

1. **修改管理员密码**（≥12 位，含大小写数字符号）
2. **轮换 TG Bot Token**（@BotFather → /revoke → 更新到后台设置），旧 token 已随历史数据泄露
3. **评估卡密泄露**：766KB 历史数据已泄露，高价值未使用卡密建议作废重新生成
4. **通知会员改密**：会员暗号已泄露，建议会员修改密码和暗号
5. 开启 Gist 自动备份（配置 `GH_TOKEN` + `GIST_ID`），每周验证一次可恢复性

## 五、文件变更清单

| 文件 | 变更类型 |
|---|---|
| `functions/_lib/common.js` | **新增** 共享工具（CORS 白名单/限流/脱敏/鉴权/错误脱敏） |
| `functions/_lib/auth.js` | **重写** PBKDF2 密码哈希、暗号哈希、强制 ADMIN_SECRET |
| `functions/api/state.js` | **重写** GET 脱敏、POST 强制管理员鉴权 |
| `functions/api/admin-login.js` | **重写** 登录限流、强制改密标记、错误脱敏 |
| `functions/api/member-login.js` | **重写** 暗号哈希、登录/找回限流、防枚举、签发会员 token |
| `functions/api/admin-action.js` | **重写** 日志记录 IP/UA、hashPwd 异步化、输入长度限制 |
| `functions/api/usdt-check.js` | **重写** rev 乐观锁防并发超发、唯一金额尾数精确匹配、限流 |
| `functions/api/smm-auto-sync.js` | **重写** 密钥改请求头、默认值拒绝 |
| `functions/api/backup.js` | **重写** 恢复密钥改请求头、独立 BACKUP_SECRET、触发备份也需鉴权 |
| `functions/api/auto-refund.js` | **重写** 需会员/管理员登录、只能退自己订单、限流 |
| `public/_headers` | **重写** 新增 CSP/HSTS/X-Frame-Options 等安全头 |
| `functions/api/*.js`（其余 11 个） | **加固** 移除 CORS `*`、错误信息脱敏 |

## 六、回滚方案

如升级后出现兼容性问题，回滚只需：
1. 还原 `functions/` 目录为旧版本
2. 环境变量保留（旧版本会忽略新增的变量）
3. 重新部署

数据完全兼容，无需回滚数据。
