# 开发约定

适用于整个项目；更深目录的同名文件可补充局部约定。

## 产品边界

- 这是薄的本地/远程 Agent 终端管理器，不是重新实现某个 CLI 对话 UI 的聊天客户端。
- 本地 CLI 持有本地或 SSH PTY；浏览器通过 WebSocket 操作 xterm.js。
- CLI 启动时检测本机 `claude`、`codex`、`traex`，若存在则确保有对应 `<hostname> <Agent>`；仅迁移精确匹配 `Local ...` 的旧默认名称，用户自定义名称不得覆盖。本地执行必须绕过 SSH。
- Agent 类型通过 `AgentAdapter` 和 `AgentRegistry` 统一封装；当前实现 Claude Code、Codex 和 TraeX。服务/API 层不得硬编码某个 CLI 的参数或历史路径。
- `AgentAdapter` 负责探测、历史读取、启动命令和恢复命令；`AgentRegistry` 是唯一类型分派入口。新增 CLI 时必须实现适配器并注册，不能在 `server.ts` 或 `sessions.ts` 增加类型分支。
- Claude 可在启动前分配 session ID；Codex 与 TraeX 由 CLI 自行生成 thread ID 且仅在首条用户消息后落库，新会话启动后从 thread 索引持续回填 ID。回填在后台进行，不阻塞启动、失败不报错。不得假设所有 CLI 都有相同参数。
- 不使用 tmux，不部署远程守护服务，不在本地持久化对话正文或终端录像。
- `~/.agent-hub/config.json` 只保存 Agent 配置、展示设置和工作区恢复元数据；禁止将标题缓存、回复、提示词写进去。目录迁移属于用户环境的一次性运维操作，不写入产品启动逻辑。

## 界面约定

- 保持克制的开发工具风格：中性深灰、等宽字体、细分隔线；不要增加营销文案、大幅标题、渐变或装饰卡片。
- 顶部使用简洁终端图标；Agent 选择与管理图标紧邻，配置操作仍放独立对话框。
- Agent 选择器使用自定义 combobox，按 `local:<username>` 或 `ssh:<target>` 分组；键盘焦点顺序必须与分组后的视觉顺序一致，并维护 `aria-activedescendant`。
- 左上角使用 Agent Hub 品牌图标；浅色和深色主题分别使用黑色、白色外围节点版本。
- 不显示底部状态栏、排序说明、分页大小控件或原生终端说明文案；保留按需加载更多。
- 主界面采用全宽 tabs，不保留左侧对话列表；tab 栏仅保留一个 + 入口。统一对话入口采用左侧新建、右侧活跃会话与远程历史的双栏布局；没有 tab 时直接在主区域显示同一入口。
- 每个 Agent 独立保存 tabs 的打开顺序、选中项及恢复标识，首次为空；× 删除工作区 tab，不结束 Agent 进程或关闭 SSH。配置 v2 使用通用 `agentSessionId`，旧 `claudeId` 只允许出现在迁移逻辑中。
- 切换 Agent、关闭浏览器或重启 CLI 后恢复工作区；页面载入或切换 Agent 时只自动恢复当前 active tab，不拉起其他 tabs。用户点击或用键盘切换到停用 tab 时直接恢复；进程主动退出后不得被 effect 再次拉起。
- 选择器活跃优先，tabs 按打开顺序；状态通过圆点呈现，保留悬停说明与屏幕阅读器文字，不只依赖颜色。
- 标题来自对应 Agent 的 thread/session 元数据；Claude 可回退到首条有效用户消息，目录仅作副信息；暂缺标题显示“新对话”。
- 主题通过 CSS 变量统一控制工作台，并同步传入 xterm；浏览器本地只持久化主题名称。
- 按 Agent 类型、连接方式、目标环境和通用 `agentSessionId` 去重，不按标题或目录猜测身份。无可靠 ID 的原生历史选择器单独呈现。
- “活跃”表示管理器跟踪的进程没有退出，不能把它当作模型工作中或等待审批的推断。

## 代码入口

- `src/config.ts`：Zod 输入边界、配置文件原子写入及权限。
- `src/ssh.ts`：本地/SSH 执行分流、SSH 参数与 shell 引用；路径与参数必须复用 `quote` / `remotePath`。
- `src/sessions.ts`：PTY 生命周期、快照队列、背压与单页面控制权。
- `src/agents/types.ts`、`base.ts`、`registry.ts`：统一 Agent 接口、缓存和路由。
- `src/agents/claude.ts`、`codex.ts`、`traex.ts`、`history.py`：各 CLI 参数、恢复与有限历史读取。
- `src/server.ts`：HTTP/WebSocket 的认证、Origin/Host 校验与资源操作。
- `web/src/api.ts`：共享前端类型和对话合并纯函数。
- `web/src/App.tsx`、`Terminal.tsx`、`style.css`：工作台、终端传输与样式。

## 修改原则

- 使用现有 TypeScript、React、Express、Vite、xterm.js 技术栈，优先修改现有文件，不为小功能引入新依赖。
- 高频终端输出不要放入 React state；通过 xterm 直接处理。
- 保持浏览器断开与 SSH 关闭分离；组件卸载不能结束远程会话。
- 快照必须与输出排队顺序一致，避免重连时重复或遗漏；保留单页面控制、resize 和背压行为。
- 历史查询按需、有限读取、短期内存缓存；标题批量读取，页面隐藏时暂停相应轮询。
- 校验外部输入，保留 SSH host key 校验和 BatchMode；不能为了方便关闭认证或放开公网监听。
- Agent 初始化脚本在本地或远程的同一个 Bash 中统一用于启动、探测和历史读取；无交互、可重复执行，初始化 stdin 不得消费 Python 历史脚本。
- 配置目录按类型映射：Claude Code 使用 `CLAUDE_CONFIG_DIR`，Codex 使用 `CODEX_HOME`，TraeX 使用 `TRAECLI_HOME`。
- Claude 历史来自项目 JSONL；Codex 与 TraeX 历史来自各自 `state_5.sqlite` 的 `threads` 表，查询必须只读、分页且限制返回量。
- Web PTY 必须移除 `NO_COLOR` / `FORCE_COLOR`，声明 `TERM=xterm-256color`、`COLORTERM=truecolor`、`TERM_PROGRAM=AgentHub`；xterm 主题必须提供完整 ANSI 16 色。
- Codex 与 TraeX 的 UI 图标由 `scripts/prepare-agent-icons.py` 从产品提供的 28px WebP 去除烘焙背景后生成透明 PNG；不使用手绘近似图标或依赖开发机应用资源。
- 初始化脚本指纹参与环境匹配和缓存隔离；脚本明文只保存在 Agent 配置，不复制到 tabs，不在日志或错误中额外输出脚本。
- 不记录 token、Cookie、SSH 密钥、对话正文；测试使用临时目录和合成数据。
- 不创建无关文档或冗长注释；在改动影响操作方式时同步 README。

## 开发与验证

从项目根目录执行：

```sh
make install
make check
make test-browser
make build
```

- Node.js 22+；非浏览器测试还需要本地 Python 3，浏览器测试当前使用 Google Chrome。
- `make dev PORT=4318` 启动独立开发服务；默认无 HMR，前端修改后刷新，后端修改后手动重启。
- UI 修改必须用浏览器实际操作，验证正常流程、空状态、错误、窄屏和已有终端交互，必要时查看截图。
- `tests/core.test.ts` 覆盖配置、转义、历史解析及对话合并；`tests/server.test.ts` 使用真实本地 PTY 验证鉴权和重连；`tests/workspace.browser.ts` 覆盖完整工作台流程。
- 改动行为时同步现有测试。浏览器远程测试替身通过不代表真实 Linux + Agent CLI 通过；完成说明要明确验证边界。
- 未经明确授权，不连接用户的真实远程主机做测试，不启动消耗额度的 Agent 对话，不遍历 SSH 主机清单。真实本机验证默认限于 `--help`、只读历史和命令生成。

## 运行中服务与构建

- 执行前检查已有后台任务和监听端口，避免重复启动、并发构建、端口冲突。
- 不擅自停止运行中的 CLI：它可能持有用户的远程任务，重启会丢失进程和终端状态。
- 仅前端且接口不变的改动可运行 `make build-web` 更新静态资源，用户刷新即可，不需要新 token。
- 后端修改需先测试再构建。若旧服务仍在使用，避免让新前端调用旧接口；可先在独立构建目录验证，切换前征得确认。
- `make start` 只启动已有构建；不要以删除配置、清理用户历史或杀掉占用端口的进程来绕过错误。
- 未被要求不创建 Git 提交、不推送、不全局安装命令；`npm link` 会修改本机全局链接。
