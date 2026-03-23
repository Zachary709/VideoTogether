# Bilibili Watch Together MVP

一个可运行的“Bilibili 异地一起看”最小版本。

当前实现已经支持：

- 两端分别在各自浏览器打开同一个 Bilibili 普通视频页或番剧播放页
- 通过 Tampermonkey 用户脚本加入同一个房间
- 同步播放、暂停、拖动进度、切换分 P、切换番剧剧集
- 通过 HTTP 轮询同步事件，避免依赖 WebSocket / WSS
- 主控播放时附带时间戳，跟随端按接收时刻做播放补偿
- 服务端维护主控最新播放状态，并对跟随端做低频漂移纠偏
- 同一标签页切换到新的视频或番剧 URL 后自动恢复房间连接
- 跟随端在新页面视频加载完成后主动 `readyForSync`，再补齐到主控当前进度
- 用户手动点击“加入房间”时自动接管主控，便于自然切换到新内容
- 本地 HTTP 调试，以及“本地 HTTPS 服务 + 纯 TCP 隧道”远程访问

项目不抓取视频、不下载视频、不自建播放器。

## 目录结构

```text
project-root/
  server/
    certs/
      .gitkeep
    src/
      index.ts
      protocol.ts
      roomManager.ts
      types.ts
    package.json
    tsconfig.json
    README.md
  userscript/
    bilibili-watch-together.user.js
    README.md
  README.md
```

## 快速开始

### 1. 启动服务端

```bash
cd server
npm install
npm run dev
```

默认监听 `0.0.0.0:8787`。

- 如果存在 `server/certs/server.key` 和 `server/certs/server.crt`，则自动以 HTTPS 启动
- 否则以 HTTP 启动

### 2. 安装用户脚本

1. 安装 Tampermonkey
2. 打开 [userscript/bilibili-watch-together.user.js](/E:/WorkSpace/tools/VideoTogether/userscript/bilibili-watch-together.user.js)
3. 复制全部内容到 Tampermonkey 新建脚本窗口并保存
4. 打开以下任一页面：
   - `https://www.bilibili.com/video/*`
   - `https://www.bilibili.com/bangumi/play/*`

### 3. 配置服务地址

脚本面板中可直接填写服务地址：

- 本地调试：`http://localhost:8787`
- 远程联调：填写你的 `https://域名:端口`

注意：用户脚本运行在 HTTPS 的 Bilibili 页面里时，远程地址必须是 `https://`，不能是 `http://`。

## 使用方式

1. 两边浏览器都安装同一份用户脚本
2. 两边打开同一个 Bilibili 普通视频页或番剧播放页
3. 在脚本面板中填写同一个服务地址和房间号
4. 点击“加入房间”
5. 主控播放、暂停、拖动进度、切换分 P 或切换番剧剧集，另一边应自动同步
6. 当页面跳转到新的 `video/*` 或 `bangumi/play/*` 地址后，脚本会自动尝试恢复同一房间的连接
7. 如果房间内某一方手动在新页面再次点击“加入房间”，该用户会自动接管主控，另一方会自然跟随到新内容

这套主控规则适合“先一起看同一页面，之后由任意一方主动带大家切到新视频或新剧集”的使用方式。

## 当前同步原理

- `play` 事件会携带主控发出事件时的时间戳、当前进度和播放速率
- 跟随端收到 `play` 后，不是直接跳到旧进度，而是根据“当前时间 - 发送时间”做补偿，直接跳到主控理论上的当前进度
- `pause` 与普通 `seek` 仍然按当前进度精确对齐
- 服务端维护主控最近一次上报的播放状态
- 主控和跟随端都会低频上报自己的播放状态，服务端只在偏差超过阈值时才让跟随端纠偏
- 跟随端切页后会在新页面 `<video>` 加载完成时主动请求一次 `readyForSync`，服务端返回主控当前快照，避免等下一轮普通轮询才追进度

## 远程联调方案

### 方案 A：浏览器友好的 HTTPS 隧道

如果你的穿透工具直接提供可用的 HTTPS 地址，脚本里直接填写该地址即可。

### 方案 B：纯 TCP 隧道

如果你的穿透工具只提供 TCP 转发，那么需要让本地 Node 服务自己提供 HTTPS。

步骤：

1. 使用 `mkcert` 为隧道域名生成证书
2. 将证书放到：
   - [server/certs/server.key](/E:/WorkSpace/tools/VideoTogether/server/certs/server.key)
   - [server/certs/server.crt](/E:/WorkSpace/tools/VideoTogether/server/certs/server.crt)
3. 重启服务端，确认日志显示 `HTTPS polling server listening`
4. 在脚本里填写 `https://隧道域名:端口`

示例：

```bash
cd server
mkcert -install
mkcert -key-file certs/server.key -cert-file certs/server.crt 7e526c6c1d80.ofalias.net localhost 127.0.0.1
npm run dev
```

注意：访问这条 HTTPS 地址的每一台电脑，都需要信任同一套 `mkcert` 根证书，否则浏览器会报证书错误。

## 验证

建议先验证：

```text
https://你的地址/health
```

如果能返回：

```json
{"ok":true,"protocol":"https-polling"}
```

说明浏览器到服务端链路正常。

## 当前已知限制

- 同步方式仍然基于 HTTP 轮询，播放开始仍会受轮询到达时机影响
- 自动播放可能被浏览器策略拦截
- 依赖 Bilibili 页面结构和 `<video>` 探测结果
- 页面改版后可能需要调整探测逻辑
- 番剧支持当前基于 `bangumi/play/*` 播放页和 URL 变化恢复，不保证所有番剧专题页或活动页