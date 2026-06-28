# Egern Multi Server Monitor

同屏显示多台服务器状态的 Egern 小组件，整体风格参考 `xcgtb/Egern-Widgets` 的 `Server Monitor 探针`，服务器卡片布局参考开源项目 Komari 的节点卡片。

当前最多支持 8 台服务器。Egern 模块参数界面不能动态创建无限字段，所以这里预置 `SERVER_1_*` 到 `SERVER_8_*`，通过 `SERVER_COUNT` 控制启用数量。

## 安装

在 Egern 中添加模块：

```text
https://raw.githubusercontent.com/dashitongzhi/egern-dual-server-widget/main/DualProbe.yaml
```

或使用 URL Scheme：

```text
egern:/modules/new?name=Multi%20Server%20Monitor&url=https%3A%2F%2Fraw.githubusercontent.com%2Fdashitongzhi%2Fegern-dual-server-widget%2Fmain%2FDualProbe.yaml
```

## 配置

先设置启用数量：

- `SERVER_COUNT` = `1` 到 `8`

然后从 1 号槽位开始填写服务器：

- `SERVER_1_NAME`
- `SERVER_1_HOST`
- `SERVER_1_PORT`
- `SERVER_1_USER`
- `SERVER_1_PASSWORD` 或 `SERVER_1_KEY`

其它服务器使用同名变量，例如 `SERVER_2_*`、`SERVER_3_*`，一直到 `SERVER_8_*`。如果某个槽位没有填写 Host，会自动跳过。

## 布局

- 小号组件：1 台时显示一张紧凑 Komari 风格卡片；多台时切换更密的单列卡片。
- 中号组件：2 台时固定左右两张等宽卡片，按 iPhone 小号组件比例压缩，避免超出边缘。
- 大号组件：自动两列铺满；5 到 8 台时切换超密卡片，优先保留每台的 `CPU / MEM / TRAF / DSK` 四项。

小组件会通过 SSH 读取 CPU、内存、实时流量、磁盘、累计网卡流量、运行时间、公网 IP/位置和实时上下行速度。每台服务器都显示 `CPU / MEM / TRAF / DSK` 四项，其中 `TRAF` 是 `/proc/net/dev` 两次刷新之间计算出的实时吞吐。
