<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="web/public/agent-hub-lockup-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="web/public/agent-hub-lockup-light.png">
    <img src="web/public/agent-hub-lockup-light.png" alt="Agent Hub" width="360">
  </picture>
</p>

<h3 align="center">Agent 专注任务，Agent Hub 专注管理。</h3>

<p align="center">不再造一个 Agent，也不重做它的对话界面。<br>只把你已经在用的 Agent，汇聚到一个轻量的终端工作台。</p>

## 一个工作台，管理所有 Agent

- **本机与远程，统一入口** — 管理 Claude Code、Codex 与 TraeX，复用现有 SSH 配置，无需远程守护服务或 tmux。
- **原生终端，原有体验** — 保留各个 CLI 的交互、工具与审批流程，不另造一套聊天界面。
- **多会话，随时接回** — 一条 tab 栏同时容纳不同 Agent 的会话，按机器与 Agent 分组、可折叠；切换任务、新建或恢复历史对话，刷新或关闭网页，正在运行的 Agent 继续工作。
- **圈选文件，交给当前 Agent** — 在只读文件审阅器中圈选文本并写下标注，逐条或同文件批量送入当前终端，由 Agent 直接修改工作区文件。

## 快速开始

准备 Node.js 22+、Python 3，以及至少一个已安装并完成认证的 Agent CLI。本机目前已验证 macOS。

无需克隆仓库或全局安装，直接运行最新版：

```sh
npx --yes --registry=https://registry.npmjs.org/ @evanginx/agent-hub@latest start
```

浏览器会自动打开工作台，已检测到的本地 Agent 自动就位。点击「+」新建对话，选择 Agent，开始你的第一个任务。

需要审阅文件时，打开终端右侧的「审阅」工具（`Ctrl+Shift+G`），从文件树选择文本并圈选内容；Git 未提交变更仍可在同一抽屉的「变更」页查看。

可通过 `PORT`（默认 `4317`）和 `CONFIG_DIR`（默认 `~/.agent-hub/`）自定义启动环境；`--port` / `--config-dir` 参数优先。`CONFIG_DIR` 只控制 Agent Hub 自身配置，不改变各 Agent CLI 的配置目录。

**连接远程？** 先确保本机可以免交互 SSH 登录目标 Linux 机器，且远程已安装 Agent CLI 和 Python 3；然后在工作台「扫描远程 Agent」中填入 SSH 目标，自动探测该机器上的 Claude Code、Codex、TraeX，勾选后一键批量注册。需要自定义可执行文件、配置目录或初始化脚本时，可切换到「手动填写」。

## 保持轻量，也守住边界

Agent Hub 只负责终端与工作区管理，对话仍由各 Agent 自己保存，管理器不落盘保存对话正文或终端录像。关闭网页或 tab 不会结束进程；退出 Agent Hub 服务会关闭它持有的终端连接，本地 Agent 进程也会结束。

服务仅监听本机地址。启动链接包含终端访问凭证，请勿分享。

## 参与开发

在项目目录执行：

```sh
npm ci
make dev PORT=4318   # 开发服务，前端修改后刷新页面
make check          # 类型检查与非浏览器测试
make test-browser   # 浏览器回归测试，需要 Google Chrome
```

更多命令见 `make help`，开发约定见 [AGENTS.md](AGENTS.md)。

## 个人远程访问（Relay）

一个 relay 对接一台运行中的 Agent Hub，手机或其他电脑通过浏览器访问。B 机器主动建立出站连接，无需开放 B 的入站端口。本地访问仍可使用；relay 断开不会结束 B 持有的 PTY，会自动重连。

先在两端设置同一个 `AGENT_HUB_RELAY_KEY`。使用随机密钥，例如通过 `openssl rand -hex 32` 生成，将结果安全地设置到两端环境变量；不要放进 URL 或提交到仓库。设备连接密钥与浏览器访问 token 分离。

在公网服务器上启动 relay（下列命令需使用包含本功能的构建）：

```sh
node dist/cli.js relay --port 4320 --public-origin https://hub.example.com
```

Relay 只监听 `127.0.0.1:4320`，由 HTTPS 反向代理对外提供服务。例如 Caddy 配置：

```caddyfile
hub.example.com {
    reverse_proxy 127.0.0.1:4320
}
```

代理必须保留原始 Host，支持 WebSocket 升级，并关闭请求/响应正文记录；不启用访问日志可避免记录终端路径。两个网络链路均须使用 HTTPS/WSS。Relay 能看到转发内容，应部署在自己信任的服务器上，不落盘保存终端内容。

在 B 机器上启动 Agent Hub：

```sh
node dist/cli.js start --relay https://hub.example.com --no-open
```

手机打开 CLI 输出的“远程访问”链接即可。链接中的 token 是浏览器访问凭证，验证后转成 HttpOnly、SameSite Cookie，HTTPS 下设置 Secure；请勿分享。浏览器和 relay 不持有 Agent 进程。退出 B 的 Agent Hub 仍会结束其终端；重启 B 的服务后需使用新的访问链接。

手机端会话入口纵向排列，不显示顶部栏和 tabs，通过右上角的设置图标打开列表，再切换、移除工作区会话、新建或打开对话，终端快捷键可横向滑动。左侧加宽的悬浮滑块可拖动查看终端历史，隐藏轨道且不占终端宽度，与右侧工具按钮分开。终端底部“键盘”用于聚焦或收起输入，“粘贴”可输入多行文本；点击“输入终端”只写入文本，再按 Enter 提交。连接或切换 tab 不会主动弹出软键盘，终端随可用视口高度调整。手机和电脑端遇到终端控制权冲突时，会显示居中的接管弹窗并阻止背景操作，刷新页面或点击接管按钮可接管，成功后恢复。

第一版不提供账号系统、多设备路由或 APK，访问权限等同于完整工作台权限。只允许一个 B 连接同一 relay，其他设备连接不会替换已在线的 B；需要更换 B 时先断开原连接。撤销浏览器访问可重启 B 的 Agent Hub（会结束终端）；设备密钥轮换需更新两端并重启 relay。纯本机调试可以用 `http://127.0.0.1:PORT`，公网地址必须是 HTTPS origin，不能带路径。
