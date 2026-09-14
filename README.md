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
- **多会话，随时接回** — 用 tabs 切换任务、新建或恢复历史对话；刷新或关闭网页，正在运行的 Agent 继续工作。

## 快速开始

准备 Node.js 22+、Python 3，以及至少一个已安装并完成认证的 Agent CLI。本机目前已验证 macOS。

npm 包名为 `@evanginx/agent-hub`，发布后可通过 `npm install -g @evanginx/agent-hub` 安装，使用 `agent-hub start` 启动。

从源码运行，在项目目录执行：

```sh
npm ci
npm run build
npm start
```

浏览器会自动打开工作台，已检测到的本地 Agent 自动就位。选择 Agent，开始你的第一个任务。

**连接远程？** 先确保本机可以免交互 SSH 登录目标 Linux 机器，且远程已安装 Agent CLI 和 Python 3；然后在工作台「管理 Agents」中注册，测试通过即可保存。

## 保持轻量，也守住边界

Agent Hub 只负责终端与工作区管理，对话仍由各 Agent 自己保存，管理器不落盘保存对话正文或终端录像。关闭网页或 tab 不会结束进程；退出 Agent Hub 服务会关闭它持有的终端连接，本地 Agent 进程也会结束。

服务仅监听本机地址。启动链接包含终端访问凭证，请勿分享。

## 参与开发

```sh
make dev PORT=4318   # 开发服务，前端修改后刷新页面
make check          # 类型检查与非浏览器测试
make test-browser   # 浏览器回归测试，需要 Google Chrome
```

更多命令见 `make help`，开发约定见 [AGENTS.md](AGENTS.md)。

<details>
<summary>维护者：自动检查与 npm 发布</summary>

分支 push / PR 自动运行检查、浏览器测试及发布包安装验证（Linux / macOS）。推送与 `package.json` 版本一致的 `vX.Y.Z` 标签后，测试通过才发布 npm；暂不自动发布预览版本。

首次发布需维护者在本机 `npm login`，运行 `npm publish --access public --registry=https://registry.npmjs.org/` 创建 `@evanginx/agent-hub` 包（会自动构建）。随后在 npm 包设置中添加 **Trusted Publisher → GitHub Actions**：

- Organization or user：`thinkin`
- Repository：`agent-hub`
- Workflow filename：`publish.yml`
- Environment name：留空
- Allowed actions：允许直接 `npm publish`

后续在检查通过、工作区干净且准备发布时运行：

```sh
npm version patch
git push origin main
git push origin "v$(node -p 'require(\"./package.json\").version')"
```

`npm version patch` 会同步版本、创建提交和标签；也可使用 `minor` 或 `major`。发布采用 [npm OIDC](https://docs.npmjs.com/trusted-publishers/)，无需配置 `NPM_TOKEN`。

</details>
