# DevTrack

**安装一次，全局自动记录，然后直接查看"我今天 / 这周干了什么"。**

DevTrack 是一个本地命令行工具，通过 [Claude Code Hooks](https://code.claude.com/docs/en/hooks) 自动统计你使用 Claude Code 开发时的活动：

- 自动识别当前项目（无需手动注册）
- 记录 Claude Code 会话与活跃开发时长
- 记录文件修改（Claude 的编辑工具 + Git 工作区变化补充）
- 记录重要命令（测试 / 构建 / 安装等，自动脱敏）
- 读取 Git 提交（分支、说明、文件数、增删行数）
- 识别开发任务（Claude 任务工具，或从 Git 提交推断）
- 按天 / 周 / 月统计，一键生成 Markdown 周报（可选 AI 总结）
- **所有数据默认只保存在本机**，不修改 Claude Code 客户端

```bash
npm install -g devtrack
devtrack init
claude            # 之后正常使用，DevTrack 自动工作
devtrack today    # 今天干了什么
```

---

## 目录

- [安装](#安装)
- [初始化](#初始化)
- [Claude Code Hook 如何安装](#claude-code-hook-如何安装)
- [支持哪些 Claude Code 使用方式](#支持哪些-claude-code-使用方式)
- [查看今天](#查看今天)
- [查看本周 / 本月](#查看本周--本月)
- [查看项目](#查看项目)
- [生成周报](#生成周报)
- [AI 周报（可选）](#ai-周报可选)
- [数据保存在哪里](#数据保存在哪里)
- [隐私与安全](#隐私与安全)
- [如何删除数据](#如何删除数据)
- [如何关闭某类数据采集](#如何关闭某类数据采集)
- [配置参考](#配置参考)
- [故障排查：devtrack doctor](#故障排查devtrack-doctor)
- [工作原理](#工作原理)
- [命令参考](#命令参考)
- [开发](#开发)
- [卸载](#卸载)

---

## 安装

要求：

- Node.js **22.12** 或更高
- Git（用于提交统计，可选但推荐）
- Claude Code **v2.1.139** 或更高（更早的版本请参考 [`--hook-command path`](#claude-code-hook-如何安装)）

从 npm 安装：

```bash
npm install -g devtrack
```

从源码安装（包尚未发布到 npm 时使用这种方式）：

```bash
git clone https://github.com/sp1128/DevTrack.git
cd DevTrack
npm install
npm run build
npm install -g .          # 或：npm pack && npm install -g ./devtrack-*.tgz
```

安装后确认：

```bash
devtrack --version
```

> SQLite 驱动 better-sqlite3 自带各平台的预编译文件（Windows / macOS / Linux，x64 / arm64），一般不需要本地编译环境。

## 初始化

```bash
devtrack init
```

`init` 会完成三件事：

1. 创建数据目录 `~/.devtrack/`（Windows 为 `%USERPROFILE%\.devtrack\`），包括 `config.json`、`devtrack.db`、`logs/`、`reports/`
2. 创建 SQLite 数据库并执行迁移
3. 把 Hook 写入 Claude Code 的用户级设置文件 `~/.claude/settings.json`

然后 **重新启动 Claude Code**（已打开的会话不会加载新的 Hook），之后像平常一样使用 `claude` 即可。

`init` 可以重复执行：配置文件和已有数据不会被覆盖，Hook 会被替换为最新版本而不会重复。

| 参数 | 说明 |
| --- | --- |
| `--no-hooks` | 只初始化数据目录和数据库，不安装 Hook |
| `--hook-command <node\|path>` | Hook 的调用方式，见下文 |
| `--settings <file>` | 指定 Claude Code 设置文件（默认 `~/.claude/settings.json`，遵循 `CLAUDE_CONFIG_DIR`） |
| `--enable-task-tools` | 同时在设置中加入 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`，让新模型也启用任务工具，提升任务识别效果 |

## Claude Code Hook 如何安装

`devtrack init` 会自动安装 Hook，一般不需要手动操作。它会向 `~/.claude/settings.json` 追加以下事件（**保留你已有的所有设置与 Hook**，修改前会把原文件备份到 `~/.devtrack/backups/`）：

| 事件 | 用途 | 执行方式 |
| --- | --- | --- |
| `SessionStart` | 会话开始、项目识别、Git 基线快照 | 后台异步 |
| `UserPromptSubmit` | 活跃时间（只记录提示词长度，不保存内容） | 后台异步 |
| `PostToolUse` | 工具调用、文件修改、命令、任务 | 后台异步 |
| `PostToolUseFailure` | 失败的命令与退出码 | 后台异步 |
| `Stop` | 回复结束、Git 提交与工作区变化 | 后台异步 |
| `TaskCreated` / `TaskCompleted` | 开发任务 | 后台异步 |
| `SessionEnd` | 会话结束与时长 | 同步（最长 5 秒） |

安装后的配置形如：

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "/usr/local/bin/node",
            "args": ["/usr/local/lib/node_modules/devtrack/dist/cli.js", "hook", "--devtrack-managed"],
            "async": true
          }
        ]
      }
    ]
  }
}
```

说明：

- 默认使用 **exec 形式**（`command` + `args`）：直接用当前 Node.js 的绝对路径执行，不经过 shell，路径含空格也没有问题，Windows 同样适用。该形式需要 Claude Code v2.1.139+。
- 如果你的 Claude Code 较旧，或经常切换 Node 版本（nvm 等），可以改用 PATH 形式：`devtrack init --hook-command path`，Hook 命令变为 `devtrack hook --devtrack-managed`。
- 升级 / 移动了 Node.js 或 DevTrack 之后，重新执行一次 `devtrack init` 即可更新路径；`devtrack doctor` 会检测失效的路径。
- `--devtrack-managed` 是 DevTrack 识别自己安装的 Hook 的标记，重装和卸载只会处理带这个标记的 Hook。
- 可以在 Claude Code 中输入 `/hooks` 查看已加载的 Hook。
- **Hook 永远不会影响 Claude Code 的正常使用**：处理过程中的任何错误都只写入 `~/.devtrack/logs/devtrack.log`，进程始终以退出码 0 结束、不向 stdout 输出任何内容；除 `SessionEnd` 外都在后台异步执行，不阻塞 Claude。
- 注意：[Claude Code 云端会话](https://code.claude.com/docs/en/claude-code-on-the-web) 不读取本机的 `~/.claude/settings.json`，因此只统计本机上运行的 Claude Code，详见下一节。

## 支持哪些 Claude Code 使用方式

DevTrack 依赖 `~/.claude/settings.json` 中的 Hook。按照[官方文档](https://code.claude.com/docs/en/desktop)，桌面客户端和命令行读取同一套配置文件，settings 中定义的 Hook 对两者都生效；VS Code 插件也共用 `~/.claude/settings.json`。

| 使用方式 | 能否记录 | 说明 |
| --- | --- | --- |
| 终端中的 `claude` 命令 | ✅ | |
| 桌面客户端 Code 标签页的**本地会话**（Local） | ✅ | 与命令行完全一样 |
| VS Code / JetBrains 中的 Claude Code 插件 | ✅ | |
| 桌面客户端的 **WSL 会话**（Windows） | ✅ | DevTrack 需要安装在 WSL 发行版内部 |
| 桌面客户端的 **SSH 远程会话** | ⚠️ | 预计需要在远程主机上安装 DevTrack；官方文档只明确了 SSH 会话读取远程主机的 skills，未验证 |
| **云端会话**（claude.ai/code、客户端中的云端会话） | ❌ | 不读取本机的 `~/.claude/settings.json` |
| 桌面客户端的 **Cowork** 标签页 | ❌ | 使用 claude.ai 账号中的配置，不读取 `~/.claude` |

使用桌面客户端的本地会话开发时：

1. 在电脑上执行一次 `npm install -g devtrack` 和 `devtrack init`
2. **完全退出并重新打开**桌面客户端，之后的本地会话会自动记录
3. 在本地会话中输入 `/hooks`，应该能看到 8 个 DevTrack 事件
4. 与 Claude 对话几句后运行 `devtrack doctor`，确认"Hook 事件"显示了最近一次收到事件的时间

说明：

- **不需要安装命令行版 `claude`**：Hook 通过 Node.js 的绝对路径直接调用，不依赖 PATH。只用客户端时 `devtrack doctor` 会提示"未在 PATH 中找到 claude 命令"，这只是警告，可以忽略。
- 想先试用、不修改全局配置，可以把 Hook 写到单独的文件，只在指定的命令行会话中启用（这种方式只适用于命令行）：

  ```bash
  devtrack init --settings ./devtrack-hooks.json
  claude --settings ./devtrack-hooks.json
  ```

- 使用 `claude -p` 一次性模式时，Claude Code 退出时会终止仍在后台运行的 Hook，最后一轮的 `Stop` 事件可能收不到；`SessionEnd` 是同步执行的，Git 提交与文件变化仍会在会话结束时同步，不影响统计结果。

## 查看今天

```bash
devtrack today
```

显示今日开发时长、Claude 会话、项目、修改文件、Git 提交、完成任务、执行命令，以及每个项目的明细。

```text
今天 · 2026-09-24（周四）

  开发时长     3小时25分钟
  Claude 会话  4 个（进行中 1）
  项目         2 个
  修改文件     23 个（56 次修改）
  Git 提交     5 次（+320 / -45 行）
  完成任务     3 个
  执行命令     42 次（失败 3）
...
```

常用参数：`--yesterday`、`--date 2026-09-20`、`--json`（输出 JSON，方便脚本处理）。

## 查看本周 / 本月

```bash
devtrack week            # 本周（ISO 周，周一至周日）
devtrack week --last     # 上周
devtrack week --week 2026-W39
devtrack month           # 本月
devtrack month --last
devtrack month --month 2026-08
```

`week` 显示本周开发时长、会话数、项目数量、Commit 数、文件修改数量、完成任务、每日分布，以及**各项目的开发时间与占比**。

## 查看项目

```bash
devtrack project                 # 列出所有项目
devtrack project my-app          # 按项目名查看
devtrack project .               # 查看当前目录所在的项目
devtrack project ~/code/my-app   # 按路径查看
devtrack project my-app --since 30d
```

项目根据 Claude Code 运行时的目录自动识别：在 git 仓库中（包括子目录与 git worktree）时项目为仓库主目录，否则为当前目录。例如在 `D:/code/project-a` 中运行 Claude Code，会自动识别为项目 `project-a`。

## 生成周报

```bash
devtrack report                  # 本周 -> ~/.devtrack/reports/2026-W39.md
devtrack report --last           # 上周
devtrack report --week 2026-W38  # 指定周
devtrack report --stdout         # 直接输出到终端
devtrack report -o ./weekly.md   # 指定输出文件
```

周报包含：

1. 本周开发概况（时长、活跃天数、会话、项目、提交、文件、命令、任务、每日分布）
2. 项目（各项目时长、提交、代码行、主要修改文件）
3. 完成任务（没有 Claude 任务时根据 Git 提交推断）
4. Git 活动
5. 文件修改
6. 技术问题（失败的测试 / 构建命令、失败率、失败最多的命令、工具调用失败）
7. AI 总结（使用 `--ai` 时）

## AI 周报（可选）

```bash
devtrack report --ai
```

支持 Anthropic（默认）、OpenAI、DeepSeek 以及任意 OpenAI 兼容接口。**AI 只接收统计数字与必要的任务摘要**（项目名、任务标题、提交说明，均已脱敏），不发送源代码、命令原文、对话内容，默认也不发送文件路径。发送前可以先检查：

```bash
devtrack report --ai --dry-run   # 打印将要发送的数据，不实际调用
```

配置方式（API Key 只从环境变量读取，不会写入配置文件）：

```bash
# Anthropic（默认，模型 claude-opus-5，通过官方 @anthropic-ai/sdk 调用）
export ANTHROPIC_API_KEY=...

# DeepSeek
devtrack config set ai.provider deepseek      # 默认模型 deepseek-chat
export DEEPSEEK_API_KEY=...

# OpenAI
devtrack config set ai.provider openai
devtrack config set ai.model <模型名>
export OPENAI_API_KEY=...

# 任意 OpenAI 兼容接口（如本地 Ollama / vLLM / 公司网关）
devtrack config set ai.provider openai-compatible
devtrack config set ai.baseUrl http://localhost:11434/v1
devtrack config set ai.model qwen3
export DEVTRACK_AI_API_KEY=...
```

也可以用 `devtrack config set ai.apiKeyEnv MY_KEY_VAR` 指定从哪个环境变量读取 Key；`DEVTRACK_AI_API_KEY` 对所有提供商都有效。AI 调用失败时周报仍会生成，并在末尾注明失败原因。

## 数据保存在哪里

所有数据只保存在本机：

```text
~/.devtrack/                 （Windows：%USERPROFILE%\.devtrack\）
├── devtrack.db              SQLite 数据库
├── config.json              配置
├── logs/devtrack.log        Hook 错误日志（不含任何采集内容）
├── reports/2026-W39.md      生成的周报
└── backups/                 修改 ~/.claude/settings.json 前的备份
```

可以通过环境变量 `DEVTRACK_HOME` 指定其他目录。

数据库表：`projects`、`sessions`、`events`、`file_changes`、`commands`、`git_commits`、`tasks`（以及内部使用的 `session_git_state`、`schema_migrations`）。可以用任意 SQLite 工具直接查询，所有时间均为 UTC ISO-8601 字符串。

## 隐私与安全

默认 **不会** 保存：

- 源代码（文件编辑只记录路径和动作；命令中的 heredoc 正文、`python -c` / `node -e` 等内联脚本会被省略）
- 完整的 Claude 对话（提示词只记录长度；Claude 的回复不读取）
- API Key、密码、Cookie、Token、Authorization、SSH 私钥
- 环境变量的值

所有写入数据库的文本（命令、提交说明、任务标题）都会先脱敏，例如：

```text
curl -H "Authorization: Bearer xxx" …   ->  curl -H "Authorization: [REDACTED]" …
API_KEY=abc npm test                     ->  API_KEY=[REDACTED] npm test
mycli --password hunter2                 ->  mycli --password [REDACTED]
git clone https://user:token@host/r.git  ->  git clone https://[REDACTED]@host/r.git
sk-ant-… / ghp_… / AKIA… / eyJ…(JWT)     ->  [REDACTED]
-----BEGIN OPENSSH PRIVATE KEY----- …    ->  [REDACTED PRIVATE KEY]
```

还可以通过 `privacy.redactPatterns` 添加自定义脱敏正则。Git remote 地址中的凭据会被去除。

## 如何删除数据

```bash
devtrack purge --before 30d        # 删除 30 天前的数据（支持 12h / 30d / 12w / 6m / 1y / 2026-01-01）
devtrack purge --before 30d --dry-run   # 只显示将删除多少条
devtrack reset                     # 删除全部已采集数据（数据库、日志、周报），保留配置
devtrack reset --all               # 删除整个 ~/.devtrack 目录
```

删除操作会先显示将要删除的内容并要求确认；在脚本中使用时加 `--yes`。`purge` 完成后会执行 SQLite `VACUUM`，确保被删除的数据不残留在数据库文件中。

## 如何关闭某类数据采集

使用 `devtrack config set` 修改，或直接编辑 `~/.devtrack/config.json`，立即生效（无需重启 Claude Code）：

```bash
devtrack config set collect.commands false      # 不记录命令
devtrack config set collect.fileChanges false   # 不记录文件修改
devtrack config set collect.git false           # 不读取 Git 提交
devtrack config set collect.tasks false         # 不记录任务
devtrack config set git.trackWorkingTree false  # 不通过 git status 补充文件变化
devtrack config set enabled false               # 暂停全部采集
```

其他控制方式：

```bash
# 排除某些项目（项目名或路径前缀）
devtrack config set privacy.excludeProjects '["secret-project", "~/work/confidential"]'

# 只忽略更多琐碎命令（这些命令仍计入工具调用次数，但不写入命令表）
devtrack config set commands.ignore '["ls","pwd","cat","git status","kubectl get"]'

# 临时关闭（只对当前终端启动的 Claude Code 生效）
DEVTRACK_DISABLE=1 claude
```

会话开始 / 结束与工具调用事件（只有工具名称与耗时，不含任何输入输出）始终记录，用于计算开发时长；如需完全停止记录，使用 `enabled false` 或 `devtrack uninstall`。

## 配置参考

`~/.devtrack/config.json`（`devtrack config` 查看完整配置）：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 采集总开关 |
| `collect.commands` | `true` | 记录 Bash / PowerShell 命令 |
| `collect.fileChanges` | `true` | 记录文件修改 |
| `collect.git` | `true` | 读取 Git 提交 |
| `collect.tasks` | `true` | 记录 Claude 任务 |
| `collect.promptSummary` | `false` | 保存每个会话首条提示词的前 80 个字符（脱敏后）作为会话标题 |
| `privacy.redactPatterns` | `[]` | 自定义脱敏正则 |
| `privacy.excludeProjects` | `[]` | 不记录的项目（名称或路径前缀） |
| `commands.ignore` | `ls`、`cat`、`git status` 等 | 不写入命令表的琐碎命令（按命令前缀匹配） |
| `commands.maxLength` | `300` | 命令最大保存长度 |
| `git.authorOnly` | `true` | 只统计 `git config user.email` 对应作者的提交 |
| `git.backfillDays` | `14` | 首次发现项目时回溯读取的天数 |
| `git.trackWorkingTree` | `true` | 通过 `git status` 快照补充 Bash / 编辑器造成的文件变化 |
| `activity.idleMinutes` | `30` | 空闲阈值：同一会话中相邻活动间隔超过该值的时间不计入开发时长 |
| `ai.provider` | `anthropic` | `anthropic` / `openai` / `deepseek` / `openai-compatible` |
| `ai.model` | 按提供商 | 模型名 |
| `ai.baseUrl` | 按提供商 | 接口地址 |
| `ai.apiKeyEnv` | 按提供商 | 读取 API Key 的环境变量名 |
| `ai.includeFilePaths` | `false` | 是否向 AI 发送文件路径 |
| `ai.timeoutSeconds` | `120` | AI 请求超时 |

## 故障排查：devtrack doctor

```bash
devtrack doctor
```

逐项检查并给出失败原因与解决方式：

```text
DevTrack Doctor

  ✔ Node.js            v22.22.2（/usr/local/bin/node）
  ✔ Git                git version 2.43.0
  ✔ Claude Code        2.1.281 (Claude Code)
  ✔ Claude Code Hooks  已安装 8 个事件（exec 形式）：~/.claude/settings.json
  ✔ Hook 事件          最近一次收到事件：3 分钟前
  ✔ 任务识别           …
  ✔ SQLite             better-sqlite3 已加载，SQLite 3.53.4
  ✔ Database           ~/.devtrack/devtrack.db（1.2 MB，schema v1，…）
  ✔ Configuration      ~/.devtrack/config.json
  ✔ File permissions   数据目录与 Claude 设置文件可读写
  ✔ Hook 错误          最近 24 小时没有错误

11 项通过，0 项警告，0 项失败
```

常见问题：

| 现象 | 处理 |
| --- | --- |
| `today` 没有数据 | 安装 Hook 后需要**重新启动** Claude Code；运行 `devtrack doctor` 查看"Hook 事件" |
| 桌面客户端里没有记录 | 确认使用的是**本地会话**而不是云端会话或 Cowork；安装后需要完全退出并重新打开客户端 |
| 只用桌面客户端，doctor 提示找不到 claude 命令 | 可以忽略，Hook 不依赖命令行版 `claude` |
| Hook 引用的文件不存在 | Node.js 或 DevTrack 位置变了（例如 nvm 切换版本），重新运行 `devtrack init` |
| Claude Code 版本过旧 | `claude update`，或 `devtrack init --hook-command path` |
| settings.json 设置了 `disableAllHooks` | 删除该设置 |
| 没有识别到任务 | 新版模型默认不启用 Claude 任务工具，周报会从 Git 提交推断；可运行 `devtrack init --enable-task-tools` |
| Hook 报错 | 查看 `~/.devtrack/logs/devtrack.log`（Hook 出错不会影响 Claude Code） |

## 工作原理

```text
Claude Code ──(Hook 事件 JSON, stdin)──> devtrack hook ──> ~/.devtrack/devtrack.db
                                              │
                                              ├── git rev-parse / remote  识别项目
                                              ├── git log --numstat       读取提交
                                              └── git status              补充文件变化

devtrack today / week / month / project / report  ──>  读取数据库并统计
```

- **会话**：`SessionStart` / `SessionEnd`。没有收到 `SessionEnd`（例如直接关闭终端）且 6 小时无活动的会话标记为"已中断"，再次收到事件时自动恢复。
- **开发时长**：采用活跃时长。同一会话内相邻两个事件（提示词、工具调用、回复结束等）间隔不超过 `activity.idleMinutes`（默认 30 分钟）的时间计为活跃；多个会话并行时取时间并集，不重复计算；跨天会话按天拆分。
- **文件修改**：`Write`（新建 / 覆盖）、`Edit`、`MultiEdit`、`NotebookEdit` 工具；Bash 命令修改的文件来自 `tool_response.bashEditDiff`（Claude Code 在部分模式下提供）；其余变化（其他 Bash 命令、代码生成器、你在编辑器里的修改）在每轮回复结束（`Stop`）时通过 `git status` 快照对比补充，已记录过的文件不重复计算。
- **命令**：`Bash` / `PowerShell` 工具。成功（`PostToolUse`）即退出码 0；失败（`PostToolUseFailure`）从错误信息首行 `Exit code N` 解析退出码；耗时取自 `duration_ms`。命令按类别归类（测试 / 构建 / 检查 / 依赖安装 / Git / 运行 / 其他）。
- **Git 提交**：在会话开始、每轮回复结束（节流 20 秒）、会话结束以及执行统计命令时增量读取所有本地分支的提交（不含 merge 提交），默认只统计自己的提交；会话期间产生的提交会关联到对应会话。
- **任务**：`TaskCreated` / `TaskCompleted` 事件与 `TaskCreate` / `TaskUpdate` / `TodoWrite` 工具。新版模型默认不启用任务工具，此时周报根据 Git 提交推断完成的工作。

## 命令参考

| 命令 | 说明 |
| --- | --- |
| `devtrack init` | 初始化数据目录、数据库并安装 Hook |
| `devtrack doctor` | 检查运行环境与安装状态 |
| `devtrack today` | 今天的开发情况 |
| `devtrack week` | 本周的开发情况与各项目开发时间 |
| `devtrack month` | 本月的开发情况 |
| `devtrack project [name]` | 项目列表 / 指定项目的统计 |
| `devtrack report` | 生成 Markdown 周报（`--ai` 生成 AI 总结） |
| `devtrack stats` | 全部记录的总体统计 |
| `devtrack purge --before 30d` | 删除指定时间之前的数据 |
| `devtrack reset` | 删除全部数据 |
| `devtrack config [list\|get\|set\|unset\|reset\|path]` | 查看或修改配置 |
| `devtrack uninstall` | 移除 Claude Code Hook |
| `devtrack hook` | 由 Claude Code 调用的 Hook 入口（无需手动执行） |

所有统计命令都支持 `--json` 输出与 `--no-sync`（跳过查询前的 Git 同步）。`devtrack <命令> --help` 查看完整参数。

## 开发

```bash
npm install
npm run build      # 编译到 dist/
npm test           # 先构建，再运行全部测试（单元 + Hook 集成 + CLI 端到端）
npm run typecheck  # 类型检查（含测试代码）
npm pack           # 打包
```

技术栈：Node.js、TypeScript、SQLite（better-sqlite3）、Commander、date-fns、Zod、Vitest；AI 总结使用官方 `@anthropic-ai/sdk`（Anthropic）或 fetch（OpenAI 兼容接口）。

目录结构：

```text
src/
├── cli.ts              命令行入口（hook 走快速路径）
├── config.ts           配置（Zod 校验）
├── paths.ts / logger.ts
├── db/                 SQLite 连接、迁移、数据访问
├── hooks/              Hook 输入 schema、事件处理、安装 / 卸载
├── core/               项目识别、Git、脱敏、命令处理、时间工具
├── stats/              活跃时长与统计查询
├── report/             周报 Markdown 与 AI 总结
└── cli/                终端渲染与各子命令
test/                   Vitest 测试
```

### 发布到 npm（维护者）

发布由 GitHub Actions 自动完成（`.github/workflows/release.yml`）：推送 `v*` 标签后，工作流会先检查标签是否与 `package.json` 的版本一致、标签指向的提交是否在 `main` 上，然后运行类型检查和全部测试，最后带 [provenance（来源证明）](https://docs.npmjs.com/generating-provenance-statements) 发布。预发布版本（如 `1.1.0-beta.1`）发布到 `next` 标签，不影响 `latest`。

#### 认证：推荐使用 Trusted Publishing（无需令牌）

[Trusted Publishing](https://docs.npmjs.com/trusted-publishers) 通过 GitHub Actions 的 OIDC 身份直接发布，不需要保存任何 npm 令牌，也不存在令牌过期的问题。一次性配置（二选一）：

- **命令行**（需要 npm 11.15 以上，账号已开启两步验证，并且已用 `npm login` 登录）：

  ```bash
  npm install -g npm@latest
  npm trust github devtrack --file release.yml --repo sp1128/DevTrack --allow-publish
  ```

- **网页**：在 npmjs.com 打开 `devtrack` 的 **Settings → Trusted Publisher**，选择 **GitHub Actions**，填写 Organization or user `sp1128`、Repository `DevTrack`、Workflow filename `release.yml`，然后保存。

配置完成并成功发布一次后，建议：

1. 删除 GitHub 仓库密钥 `NPM_TOKEN`，并在 npm 上吊销对应的令牌；
2. 在 `devtrack` 的 **Settings → Publishing access** 中选择要求两步验证并禁止令牌发布，这样只能通过受信任的工作流发布。

#### 后备：NPM_TOKEN

如果暂时无法使用 Trusted Publishing，可以在仓库 **Settings → Secrets and variables → Actions** 中添加密钥 `NPM_TOKEN`，值为 npm 的 **Granular Access Token**（权限选 **Read and write**，勾选 **Bypass two-factor authentication**）。工作流会优先尝试 Trusted Publishing，失败时才使用这个令牌。

#### 发布新版本

```bash
git checkout main && git pull
npm version patch -m "chore: 发布 v%s"   # 或 minor / major；会修改版本号、提交并打标签
git push origin main --follow-tags       # 推送标签后自动发布
```

说明：`devtrack` 这个名字以前有人发布过 1.0.0 后又撤销了，而 npm 上发布过的版本号永远不能再用，所以首个版本是 1.0.1。

发布结果可以在仓库的 **Actions → Release** 中查看。

## 卸载

```bash
devtrack uninstall            # 移除 Hook，保留数据
devtrack uninstall --purge    # 移除 Hook 并删除 ~/.devtrack
npm uninstall -g devtrack
```

## License

MIT
