# Userscript

`bilibili-watch-together.user.js` 是可直接安装到 Tampermonkey 的用户脚本。

## 安装

1. 安装 Tampermonkey
2. 打开 `userscript/bilibili-watch-together.user.js`
3. 复制全部内容并保存为新脚本
4. 打开以下任一页面验证脚本生效：
   - `https://www.bilibili.com/video/*`
   - `https://www.bilibili.com/bangumi/play/*`

## 面板功能

脚本面板支持：

- 输入服务地址
- 输入房间号
- 加入房间
- 离开房间
- 申请主控
- 重新检测播放器
- 查看连接状态、当前角色、videoKey、最近日志

## 服务地址填写规则

- 本地调试：`http://localhost:8787`
- 远程联调：填写你的 `https://域名:端口`

脚本会把这个地址保存到浏览器 `localStorage`，下次自动复用。

如果你使用纯 TCP 隧道，请确保本地服务已经启用 HTTPS，否则浏览器无法从 Bilibili 页面请求该地址。

## 当前同步能力

已支持：

- 普通视频页播放/暂停/拖动进度
- 番剧播放页播放/暂停/拖动进度
- 分 P 切换
- 番剧剧集切换
- 房间主控切换
- 同一标签页在 URL 跳转后自动恢复房间连接
- 手动重新加入房间时自动接管主控

## 主控行为说明

- 脚本因页面跳转自动恢复连接时，不会抢主控
- 用户在当前页面手动点击“加入房间”时，会主动接管主控
- 这使得“先加入同一房间，再由其中一方手动切到新视频或新剧集并重新加入”成为自然流程

## 已知限制

- 同步依赖轮询，实时性略弱于 WebSocket
- 自动播放可能被浏览器拦截
- 页面结构变化可能影响播放器探测
- 番剧支持当前只覆盖 `bangumi/play/*` 播放页
