# Server

服务端是一个极简 HTTP/HTTPS 轮询房间服务，负责：

- 分配连接 ID
- 维护房间成员与主控
- 接收主控同步事件
- 通过轮询接口向跟随端分发事件
- 维护每个成员最近一次上报的播放状态
- 在跟随者上报时，根据主控状态快照计算是否需要纠偏
- 清理长时间未轮询的失效成员
- 返回跨域响应头，允许用户脚本从 Bilibili 页面请求接口

## 启动

```bash
npm install
npm run dev
```

默认监听 `0.0.0.0:7777`。

- 如果 `certs/server.key` 和 `certs/server.crt` 存在，则自动以 HTTPS 启动
- 如果证书不存在，则退回 HTTP 启动

## 启动日志示例

HTTP：

```text
[server] HTTP polling server listening on http://0.0.0.0:7777
```

HTTPS：

```text
[server] HTTPS polling server listening on https://0.0.0.0:7777
[server] Using certificate files: key=..., cert=...
```

## 房间与主控规则

- 第一个加入房间的成员会成为主控
- 主控离开或失效后，房间会自动移交给剩余成员中的下一位
- 用户在页面里手动点击“加入房间”时，会以 `takeoverMaster=true` 加入并接管主控
- 因 URL 跳转触发的自动恢复连接不会抢占主控
- `/rooms/join` 支持 `sinceEventId`，自动恢复时只拉取增量事件，避免重复重放历史切换事件

## 状态同步机制

- 主控会持续上报自己的最近播放状态：`currentTime`、`paused`、`playbackRate`、`reportedAt`
- 跟随者也会低频上报自己的播放状态
- 服务端根据主控的最新快照估算“主控此刻理论进度”，并和跟随者当前估算进度比较
- 只有在偏差超过阈值，或者跟随者明确以 `readyForSync=true` 请求补偿时，服务端才返回 `syncInstruction`
- 这样可以把高频同步压力从“不断追事件”改成“按需纠偏”

## 用 mkcert 生成 HTTPS 证书

如果你要复用纯 TCP 隧道，必须让本地 Node 服务自己提供 HTTPS。

1. 安装 `mkcert`
2. 初始化本地根证书：

```bash
mkcert -install
```

3. 在 `server/` 目录下生成证书，例如：

```bash
cd server
mkcert -key-file certs/server.key -cert-file certs/server.crt 7e526c6c1d80.ofalias.net localhost 127.0.0.1
```

注意：如果隧道域名变了，需要重新生成证书。

## 纯 TCP 隧道说明

纯 TCP 隧道只负责转发字节流，不会替你做 TLS。

因此浏览器访问：

```text
https://7e526c6c1d80.ofalias.net:59905
```

时，TLS 握手实际上由你本机的 Node 服务完成。所以必须满足：

- 本地服务以 HTTPS 启动
- 证书里的域名包含隧道域名
- 访问这条地址的电脑信任同一套 `mkcert` 根证书

## 主要接口

- `POST /rooms/join`
- `POST /rooms/leave`
- `POST /rooms/events`
- `POST /rooms/state`
- `GET /rooms/poll`
- `GET /health`