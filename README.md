# Egern Dual Server Monitor

同屏显示两台服务器状态的 Egern 小组件，风格参考 `xcgtb/Egern-Widgets` 的 `Server Monitor 探针`。

## 安装

在 Egern 中添加模块：

```text
https://raw.githubusercontent.com/dashitongzhi/egern-dual-server-widget/main/DualProbe.yaml
```

或使用 URL Scheme：

```text
egern:/modules/new?name=Dual%20Server%20Monitor&url=https%3A%2F%2Fraw.githubusercontent.com%2Fdashitongzhi%2Fegern-dual-server-widget%2Fmain%2FDualProbe.yaml
```

## 配置

至少填写第一台服务器：

- `SERVER_1_NAME`
- `SERVER_1_HOST`
- `SERVER_1_PORT`
- `SERVER_1_USER`
- `SERVER_1_PASSWORD` 或 `SERVER_1_KEY`

第二台服务器使用同名的 `SERVER_2_*` 变量。

如果是搬瓦工服务器，可以额外填写：

- `SERVER_1_BWH_VEID`
- `SERVER_1_BWH_API_KEY`
- `SERVER_2_BWH_VEID`
- `SERVER_2_BWH_API_KEY`

未填写搬瓦工 API 时，流量占比会用 SSH 读取到的网卡累计流量除以 `SERVER_N_TRAFFIC_LIMIT` 估算。
