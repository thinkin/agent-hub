# Agent Hub

通过本地 Web 工作台，管理本机和多台 Linux 机器上的 Claude Code、Codex 与 TraeX 原生终端。

运行 CLI，在网页中选择 Agent、选择工作目录、新建或恢复对话。浏览器只是终端入口：本地进程和 SSH 连接由 Agent Hub 服务持有，刷新或关闭网页不会结束正在运行的 Agent。

## 环境要求

本地：
- Node.js 22+、npm；连接远程 Agent 时还需要系统 OpenSSH。
- macOS 已验证；其他本地操作系统尚未做完整端到端验证。
- 已安装并完成认证的 Claude Code、Codex 或 TraeX 会在启动时自动注册为对应本地 Agent。
- Python 3 用于读取各类 Agent 历史和运行历史解析测试；Google Chrome 用于当前 Playwright 浏览器测试。
- 可选：Make，提供常用开发命令。

远程：
- 可通过 SSH 连接的 Linux、Bash。
- 已安装并完成认证的 Claude Code、Codex 或 TraeX；具体恢复参数由对应适配器处理。
- Python 3，用于只读获取远程对话摘要；Codex 与 TraeX 的 `state_5.sqlite` 还需要对 SSH 用户可读。
- 无需 tmux 或额外守护服务。

## 快速开始

```sh
npm ci
npm run build
npm start
```

等价的 Make 命令：

```sh
make install
make build
make start
```

默认监听 `127.0.0.1:4317`，启动后打开浏览器，并在终端输出带访问令牌的完整链接。不要分享这个链接：它可以控制已注册环境的终端。

指定端口或不自动打开浏览器：

```sh
make start PORT=4318 ARGS="--no-open"
# 或
npm start -- --port 4318 --no-open
```

构建后的 CLI 也可直接运行：

```sh
node dist/cli.js start --no-open
```

可选执行 `npm link`，将当前项目链接为本机命令后使用 `multi-agent-mgr start`；这一步会修改本机 npm 全局链接。

### 本地 Agent 与注册远程 Agent

启动时会通过当前 CLI 的登录 Shell 检测 `claude`、`codex` 和 `traex`。检测成功后，会按需创建 `Local Claude`、`Local Codex` 与 `Local TraeX`：

- 直接在本机启动 PTY，不经过 SSH；
- 自动使用检测到的 CLI 可执行文件绝对路径，并在选择器中显示当前系统用户名；
- 三种 Agent 均支持新建、读取本机历史和按 session ID 恢复对话；
- 与远程 Agent 分开保存 tabs，不会因路径或配置目录相同而混用会话。

未检测到的 CLI 不会创建不可用的占位 Agent。请先确保登录 Shell 中 `command -v claude`、`command -v codex` 或 `command -v traex` 能找到对应命令，再重新启动 Agent Hub；相同类型的本地 Agent 不会重复创建。

注册远程 Agent：

1. 先在本机终端验证 `ssh your-host`，完成首次主机信任、密钥或 SSH agent 设置。
2. 打开工作台，通过顶部 Agent 选择框旁的管理图标（悬停显示“管理 Agents”）注册 Agent。
3. 选择 Claude Code、Codex 或 TraeX，填写名称、SSH Host 别名或 `user@host`、默认工作目录。
4. 如果远程登录环境找不到所选 CLI，在高级配置中填写对应可执行文件路径。
5. 测试连接，保存后选择 Agent 并新建对话。

SSH 连接使用系统 `~/.ssh/config`、密钥、SSH agent 和跳板机配置。非默认端口可配置在 SSH Host 中。不在网页中收集密码；`BatchMode=yes` 和严格主机密钥校验均保持开启。

同一台机器可以注册多个 Agent。Agent 是环境配置，不自动隔离 Unix 用户或 CLI 数据；Agent 类型、连接方式、目标、配置目录和初始化脚本共同参与环境匹配。当前按配置中的目标字符串识别环境，不解析不同 SSH 别名是否实际指向同一台机器。

### 初始化脚本

在注册或编辑 Agent 的“高级配置”中填写 Bash 初始化脚本，例如：

```bash
source ~/.config/claude/env.sh
export PATH="$HOME/.local/bin:$PATH"
export CLAUDE_CONFIG_DIR="$HOME/.claude-work"
```

- 在 Agent 对应的本地或远程登录 Bash 中先执行初始化，再启动/恢复对应 CLI、测试连接或读取历史；所有后续命令继承导出的环境变量。
- 脚本使用 Bash `set -e` 执行，普通命令失败会中止操作；条件命令、管道等遵循 Bash 自身规则。不要关闭错误检查或调用 `exit`、`exec`。
- 脚本必须无交互且可重复执行，历史查询和标题轮询也会运行；初始化的标准输入为空，不应读取终端输入。
- 显式填写的“Agent 配置目录”会映射到 `CLAUDE_CONFIG_DIR`、`CODEX_HOME` 或 `TRAECLI_HOME`，并优先于初始化脚本中的同名变量。后续 CLI 命令仍会切换到所选工作目录。
- 脚本最多 8192 字符，明文保存在本地 Agent 配置；不要直接填密钥，优先 `source` 远程权限受控的文件，也不要输出秘密信息。
- 修改脚本只影响后续操作，不修改正在运行的进程。脚本内容参与环境匹配和历史缓存隔离；旧环境的 tabs 不会自动接入新环境。远程被 source 文件的内容变化无法自动识别。

## 对话与生命周期

- 顶部选择 Agent；每个 Agent 有独立的全宽 tabs 工作区。没有 tab 时，主区域直接显示对话入口；新建或打开已有对话后添加 tab。
- tab 栏只有一个 `+` 入口，点击后打开与空工作区相同的对话入口：左侧按工作目录新建，右侧选择运行会话和远程历史，支持按已加载的标题、目录搜索及加载更多；重复打开定位到已有 tab。
- tabs 保持打开顺序，支持左右方向键、Home / End 切换；当前 Agent、各 Agent 的 tabs 和选中项持久化到本地配置。
- 右上角可切换深色现代、浅色现代、Solarized Dark 和 Monokai；选择保存在当前浏览器，并同步应用到终端配色。
- 浅蓝实心圆点表示本地管理器跟踪的进程仍活跃，灰色空心圆点表示历史或已退出；悬停可查看状态。
- “活跃”不等于模型正在思考，也不是远程全机进程监控。
- 标题优先使用对应 CLI 的 thread/session 标题；Claude 缺少标题时使用首条有效用户消息摘要。没有摘要时显示“新对话”，工作目录仅作副信息。
- 点击活跃对话接回原终端；点击历史由对应适配器使用 Claude `--resume`、Codex `resume` 或 TraeX `resume` 恢复。
- 历史包含对应 Agent 配置目录内的记录，不限于工作台创建的对话。Claude 读取项目 JSONL；Codex 与 TraeX 只读查询各自的 `state_5.sqlite`。
- 同一终端只允许一个页面控制输入和尺寸，其他页面可明确接管。
- tab 上的 × 只关闭并移除该工作窗口，不结束 Agent 进程或关闭 SSH；从“打开对话”可接回活跃进程。关闭浏览器、刷新或切换 Agent 不移除 tabs，也不关闭连接。
- CLI 重启后恢复 tab 布局；页面打开、刷新或切换 Agent 时，只自动恢复该 Agent 当前选中的一个 tab，不批量启动其他 tabs。用户点击停用 tab 或通过键盘切换到它时，也会直接恢复对应对话。Agent 主动退出后不会自动重启；历史缺失或环境变化时显示错误。
- 需要结束 Agent 时，在原生终端内退出；正常退出 Agent Hub CLI 会清理其持有的连接和进程。
- CLI 重启后只能从 Agent 自身持久化历史恢复对话，不能恢复旧终端画面；网络分区或 CLI 崩溃时不保证远程进程立即退出，也不管理 Agent 派生的后台任务。

## 存储与安全

本地持久化目录：`~/.multi-agent-mgr/`。

| 数据 | 位置 |
| --- | --- |
| Agent 配置、历史分页数量、各 Agent 的 tabs 和选中项 | `~/.multi-agent-mgr/config.json` |
| 本地或 SSH PTY、终端屏幕与有限滚动缓冲 | CLI 内存 |
| 临时历史摘要缓存 | CLI / 浏览器内存 |
| Agent 对话正文 | 对应 CLI 自身的配置或会话目录 |

管理器不落盘保存标题、提示词、回复、终端输出或认证密钥。配置 v2 的工作区只保存 tab ID、运行会话 ID、通用 `agentSessionId`、Agent 类型、工作目录和环境标识；标题按需从对应 Agent 获取。旧版 `claudeId` 会在加载时迁移为 `agentSessionId`。配置目录权限为 `0700`，配置文件以 `0600` 原子写入。

服务仅监听本机回环地址；HTTP 和 WebSocket 校验来源，认证后使用 HttpOnly、SameSite Cookie。访问令牌没有按时间过期机制，但每次 CLI 启动都会生成新令牌，旧服务的令牌及 Cookie 不再适用。不要把配置、含 token 的链接、终端截图或真实对话加入版本控制。

## 开发

```sh
make dev PORT=4318
```

开发服务使用 Vite middleware，默认不自动打开浏览器；从启动输出复制完整链接。当前关闭 HMR，前端修改后刷新浏览器；后端修改需要手动重启开发服务。

| 命令 | 用途 |
| --- | --- |
| `make help` | 查看目标及参数 |
| `make install` | 使用锁文件安装依赖 |
| `make typecheck` | 前后端 TypeScript 检查 |
| `make test` | 单元测试、HTTP/WebSocket 和真实本地 PTY 集成测试 |
| `make test-browser` | Chrome 完整交互测试，测试启动独立开发服务 |
| `make check` | 顺序执行类型检查和非浏览器测试 |
| `make build` | 构建 CLI、后端、前端并复制 Python 脚本 |
| `make build-web` | 仅更新 `dist/web`，不重启 CLI |
| `make start` | 启动已有构建，不自动重新构建 |

`make build-web` 适用于前后端接口不变的 UI 修改，完成后刷新页面即可。后端改动需要构建并重启，但重启会结束本地服务持有的 SSH 连接；不要未经确认重启正在使用的服务。Makefile 不提供自动停止或删除用户配置的目标。

### 项目结构

```text
src/
  cli.ts              启动、浏览器打开及退出清理
  server.ts           本地 API、鉴权及 WebSocket
  config.ts           Agent 配置校验与原子存储
  ssh.ts              本地/SSH 命令与 PTY 分流及 shell 转义
  sessions.ts         PTY 生命周期与终端快照
  agents/types.ts      AgentAdapter 统一接口
  agents/registry.ts   Agent 类型与适配器路由
  agents/{claude,codex,traex}.ts  各 CLI 的探测、启动与恢复协议
  agents/history.py   Claude JSONL 与 Codex/TraeX SQLite 历史提取
web/src/
  App.tsx             Agent 管理、对话列表和工作台
  api.ts              API 类型、对话合并逻辑
  Terminal.tsx        xterm.js 与 WebSocket 交互
  style.css           工作台样式
scripts/              PTY 辅助程序权限修正及构建资源复制
tests/                核心、服务与浏览器回归测试
```

## 测试范围与限制

浏览器测试使用真实 Chrome、本地 PTY 和远程测试替身，覆盖注册、共享历史、tab 去重与键盘切换、Agent 独立工作区、浏览器重开、CLI 重启后的自动恢复、关闭后接回同一进程、历史缺失、环境变化及窄屏；HTTP/WebSocket 测试另覆盖控制权接管。真实环境只做三个本地 CLI 的只读探测、历史查询和命令生成验证；远程验证需使用明确授权的测试主机。

历史格式与 CLI 版本相关。Claude 按项目枚举 JSONL，并有限读取首尾片段；Codex 与 TraeX 只读查询 `state_5.sqlite` 的 `threads` 表。未来格式变化可能造成标题或工作目录缺失，首次读取大量历史仍可能有延迟。

通过原生历史选择器打开的进程尚不能可靠回传所选 session ID，界面显示“历史选择器”，不会用目录或相似标题猜测并合并。Codex 新建会话的 ID 在进程启动后从 thread 索引回填；若同一环境并发创建多个会话且无法唯一匹配，当前 tab 仍可运行，但重启后可能无法按 ID 恢复。

## 常见问题

- **访问令牌无效**：使用当前 CLI 输出的完整链接，尤其在重启之后；不要只复制主机和端口。不要通过关闭鉴权解决此问题。
- **SSH 连接失败**：先在本机终端连接相同目标，检查 host key、密钥和跳板机；工作台不会自动接受未知主机。
- **Agent CLI 找不到**：配置绝对可执行文件路径。远程通过 `bash -lc` 启动，环境与交互式 shell 可能不同。
- **历史读取失败**：检查 Python 3、对应配置目录和文件读取权限；不会自动安装依赖。
- **Web 终端颜色不同**：PTY 会清理 `NO_COLOR` / `FORCE_COLOR`，设置 `TERM=xterm-256color`、`COLORTERM=truecolor` 和 `TERM_PROGRAM=AgentHub`；xterm 使用当前主题的完整 ANSI 16 色。不同于系统终端的自定义 palette 时仍可能存在轻微差异。
- **macOS `posix_spawnp failed`**：先运行 `node scripts/prepare-pty.mjs`，它修正当前 node-pty 包中 spawn-helper 的执行权限，正常安装时也会执行。
- **Chrome 测试被沙箱阻止**：在允许本地浏览器进程的环境中运行测试；不要把测试失败当作通过。
