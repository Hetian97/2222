# 微信读书代理 Worker

## 部署

在 `workers` 目录执行：

```bat
cd /d D:\app\2222EPhone-merge-new\workers
npx.cmd -y wrangler deploy
```

第一次使用 wrangler 需要登录：

```bat
npx.cmd -y wrangler login
```

## 配置 API Key

不要把 Key 写进代码或 wrangler.toml。部署后设置 Secret：

```bat
npx.cmd -y wrangler secret put WEREAD_API_KEY
```

粘贴微信读书 API Key，格式：

```text
wrk-xxxxxxxx
```

可选访问口令：

```bat
npx.cmd -y wrangler secret put APP_TOKEN
```

设置后，2222 的“微信读书 → 设置 → 访问口令”必须填写同一个值。

可选限制来源：在 Cloudflare 控制台为 Worker 添加环境变量：

```text
ALLOWED_ORIGIN = https://你的2222页面域名
```

默认是 `*`。个人使用时建议同时设置 `APP_TOKEN`。

## 地址

Worker 地址通常类似：

```text
https://ephone-weread-proxy.你的子域.workers.dev/api/weread
```

把这个地址填入：

```text
微信读书 App → 设置 → Worker 地址
```

## 接口

Worker 只转发微信读书 Agent Gateway：

```text
POST /api/weread
```

请求体：

```json
{
  "api_name": "/shelf/sync",
  "skill_version": "1.0.5"
}
```

Key 由 Worker 注入，前端不接触 API Key。
