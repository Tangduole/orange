# Cobalt 自托管部署指南

> 用 cobalt 解决 **X / Twitter 高清视频下载** 痛点（fxtwitter 免费 API 只能给 540p–720p，cobalt 直接拿到推文原画）。
> 同时它对 YouTube / Bilibili / Reddit / Tumblr / SoundCloud / Vimeo / Pinterest 等几十个平台也有相当稳定的兜底解析能力。

## 为什么要自托管

- **公开实例不稳**：官方 `api.cobalt.tools` 经常被滥用 ban、速率限制重；其他公开实例画质会被人为降级
- **隐私**：自己机器上跑，URL 和 IP 不出去
- **给你自己的下载器吃独食**：通过 `Authorization: Api-Key` 锁住，别人扫到也用不了

---

## 一、最快上手（Docker Compose，5 分钟）

在你的 VPS 上新建 `cobalt/docker-compose.yml`：

```yaml
services:
  cobalt-api:
    image: ghcr.io/imputnet/cobalt:10
    init: true
    restart: unless-stopped
    container_name: cobalt-api
    ports:
      - 9000:9000/tcp
    environment:
      # 必填：你这台机器对外的完整 URL（含协议和端口或域名）
      API_URL: "https://cobalt.your-domain.com/"

      # 强烈建议开启鉴权，避免被全网扫到白嫖
      API_AUTH_REQUIRED: "1"
      API_KEY_URL: "file:///keys.json"

      # 限速（每个 IP 每分钟最大请求数），可按需放大/缩小
      RATELIMIT_WINDOW: "60"
      RATELIMIT_MAX: "20"

      # 时区（日志用）
      TZ: "Asia/Shanghai"

      # 可选：指定外部代理（绕过 IP 封锁，如 YouTube 的部分国家限制）
      # API_EXTERNAL_PROXY: "http://user:pass@proxy.example.com:8080"

    volumes:
      - ./keys.json:/keys.json:ro
    labels:
      - com.centurylinklabs.watchtower.scope=cobalt

  # 可选：自动更新 cobalt 镜像
  watchtower:
    image: ghcr.io/containrrr/watchtower
    restart: unless-stopped
    command: --cleanup --scope cobalt --interval 86400
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
```

新建 `cobalt/keys.json`（鉴权密钥列表，**注意权限只给 cobalt 容器读**）：

```json
{
  "orange-prod": {
    "name": "orange downloader (prod)",
    "limit": 1000,
    "ips": []
  }
}
```

> Key 的名字（这里是 `orange-prod`）可以换；后续在 orange 后端的 `COBALT_API_KEY` 填的就是这个 key 名。
> `limit` 是每窗口（默认 60 秒）允许的请求数；`ips` 留空表示不绑 IP，填了就只允许这些 IP 访问。

启动：

```bash
docker compose up -d
docker compose logs -f cobalt-api
```

看到 `cobalt API ... started` 就成了。

---

## 二、把它接到 orange 后端

在 `backend/.env` 里加：

```env
COBALT_API_URL=https://cobalt.your-domain.com/
COBALT_API_KEY=orange-prod
```

> 注意：`COBALT_API_URL` 末尾**不要**带路径，cobalt v10 的接口就是根路径 `POST /`。
> 留空 = 不启用 cobalt，X 下载会自动回落到 fxtwitter（540p~720p）。

重启 orange backend 后，X 下载会自动走 cobalt：

- **解析失败**：自动 fallback 到 fxtwitter，不会让用户感知中断
- **日志关键字**：`[x-download] cobalt path failed, will fallback to fxtwitter`

---

## 三、反向代理 + HTTPS（生产环境必做）

cobalt 默认监听 `9000`，**不要直接暴露到公网**。用 Caddy / Nginx 套层 HTTPS。

### Caddy（最省事）

```caddyfile
cobalt.your-domain.com {
    reverse_proxy localhost:9000
}
```

把这段加到 `/etc/caddy/Caddyfile`，`systemctl reload caddy` 就完事了，证书 Caddy 自动续期。

### Nginx

```nginx
server {
    server_name cobalt.your-domain.com;
    listen 443 ssl http2;

    ssl_certificate     /etc/letsencrypt/live/cobalt.your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cobalt.your-domain.com/privkey.pem;

    # cobalt 返回的视频可能很大，关掉 buffer 让流式直通
    proxy_buffering off;
    proxy_request_buffering off;
    client_max_body_size 0;

    location / {
        proxy_pass http://127.0.0.1:9000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 600s;
    }
}
```

---

## 四、推荐机器规格

| 用途        | CPU       | 内存  | 带宽       | 备注                                    |
| ----------- | --------- | ----- | ---------- | --------------------------------------- |
| 个人测试    | 1 vCPU    | 512MB | 100Mbps    | 单线程也跑得动                          |
| 小流量生产  | 1–2 vCPU  | 1GB   | 1Gbps      | 几百 DAU 完全够                         |
| 中流量      | 2–4 vCPU  | 2GB   | 1Gbps      | cobalt 主要瓶颈是出口带宽，不是 CPU/RAM |

**机房选址**（按平台访问质量优先级）：

| 你想稳定下载的平台 | 推荐机房                      |
| ------------------ | ----------------------------- |
| YouTube            | 美国（任意，住宅 IP > IDC）   |
| X / Twitter        | 美国 / 欧洲                   |
| TikTok             | 新加坡 / 美西                 |
| Bilibili           | 香港（不要日本，日本会被风控）|

---

## 五、常见坑

### 1. cobalt 返回 `error.code = error.api.youtube.login`
YouTube 这条机器 IP 被识别为机器人。两条路：
- 给 cobalt 加 `cookies.txt`（cobalt 支持）：在 cobalt 容器里挂一份你浏览器导出的 YouTube cookies
- 或者换 IP（住宅代理 / 换机房）

### 2. cobalt 返回 `tunnel` 但下载链接 403 / 410
正常现象，cobalt 给的 tunnel URL 有效期一般几分钟。orange 后端是收到 cobalt 响应后**立即开始下载**的，不会缓存这个 URL，所以正常情况下不会出现。
如果偶发 403，多半是用户解析后停了几分钟才点下载——这个目前的实现是一气呵成解析+下载，没问题。

### 3. X 视频下载下来是 360p
cobalt 解析失败回落到了 fxtwitter。看日志确认：
```
[x-download] cobalt path failed, will fallback to fxtwitter: <原因>
```
常见原因：
- COBALT_API_KEY 写错（401/403）
- COBALT_API_URL 末尾带了多余路径
- cobalt 实例所在机房被 X 风控（换机房或加代理）

### 4. cobalt 自己被人扫到滥用
- 必须开 `API_AUTH_REQUIRED=1`
- 在 `keys.json` 加 IP 白名单：`"ips": ["1.2.3.4"]` 锁住只允许 orange 后端访问
- Caddy/Nginx 加 IP allowlist 双保险

### 5. 我能直接用公开 cobalt 实例吗？
能，但**强烈不建议生产用**：
- 速率限制严格，高峰被 429
- 任何时候可能下线（维护/被滥用 ban）
- 画质会被人为限制
- 公开实例运营者随时能看到你转发去的 URL

公开实例只适合：本地调试、demo。

---

## 六、监控（强烈建议）

cobalt 自带 `/api/serverInfo`，可以让 Uptime Kuma / Healthchecks.io 定时打：

```bash
curl https://cobalt.your-domain.com/api/serverInfo
```

返回 JSON 即正常。orange 后端没接死状态依赖（cobalt 挂了会自动 fallback），但你最好早一步知道——画质降级用户会来骂的。

---

## 七、升级

watchtower 已加进 docker-compose，每 24 小时自动拉新版。如果想手动：

```bash
cd cobalt
docker compose pull
docker compose up -d
```

cobalt v10 的 schema 已经稳定，orange 客户端代码兼容 v10+。
