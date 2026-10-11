# pi-fold

[English](README.md) · **中文**

为 [Pi](https://pi.dev) 提供 Claude Code 风格的折叠：思考块与工具输出各自收成一行，
再用 Pi 自带的按键展开。

```
● read src/injector.ts · 42 lines · 0.3s
● bash npm test · exit 0 · 18 lines · 4.2s
✻ Thought for 3.2s
✻ Worked for 12.3s · 3 tools · thought 4.1s
```

每个已完成的工具调用收成一行状态行（compact 模式，默认开启）。`/fold compact`
可以切回两行布局：

```
⏺ read  src/injector.ts
  ⎿  42 lines · 0.3s
     12  import { createInjector } from "./injector";
     13  return createInjector(options);
     14
     15  export function bootstrap() {
     16    return start();
     … 37 more lines (ctrl+o to expand)
⏺ bash  npm test
  ⎿ exit 0 · 18 lines · 4.2s
     ✓ 18 passed
     … 17 earlier lines (ctrl+o to expand)
```

- **助手正文永不折叠**，只折叠思考块和工具结果。
- **没有东西被永久隐藏**：每一行折叠内容都能用 Pi 原生的 `ctrl+o` / `ctrl+t`
  或鼠标点击展开。不引入任何新按键。
- **工具执行本身不受影响**，只改渲染；模型看到的输出和以前完全一样。

---

## 目录

- [环境要求](#环境要求)
- [安装](#安装)
- [首次使用](#首次使用)
- [看懂对话区](#看懂对话区)
  - [工具调用行](#工具调用行)
  - [折叠后的结果行](#折叠后的结果行)
  - [各工具的汇总对照表](#各工具的汇总对照表)
  - [思考行](#思考行)
  - [轮次汇总](#轮次汇总)
- [按键](#按键)
- [命令](#命令)
- [配置](#配置)
- [关掉某一部分](#关掉某一部分)
- [疑难排查](#疑难排查)
- [兼容性与平台](#兼容性与平台)
- [卸载](#卸载)
- [开发](#开发)

---

## 环境要求

- 一个带扩展 API 的 Pi：需要 `registerToolRenderer`、`registerEntryRenderer`、
  `appendEntry`，以及 `tool_execution_*` / `agent_*` 事件。当前所有 Pi 版本都有。
- 思考折叠额外依赖 Pi 的 `hideThinkingBlock` 设置（见[首次使用](#首次使用)）。

## 安装

### 推荐：作为 Pi 包安装

在包目录下执行：

```bash
pi install /path/to/pi-ext
```

`pi` 会读取 `package.json` 里的 `pi.extensions` 字段，把扩展登记进你的设置，之后每次启动
都会加载。

```bash
pi list                     # 确认已登记
pi remove /path/to/pi-ext   # 移除
```

### 或者：软链到扩展目录

macOS / Linux：

```bash
ln -s "/path/to/pi-ext/extensions/fold" ~/.pi/agent/extensions/fold
```

Windows（PowerShell）：

```powershell
New-Item -ItemType SymbolicLink `
  -Path "$env:USERPROFILE\.pi\agent\extensions\fold" `
  -Target "C:\path\to\pi-ext\extensions\fold"
```

直接把 `extensions/fold` 目录复制过去也可以；用软链只是方便跟本仓库保持同步。

### 只试一次

```bash
pi --no-extensions -e /path/to/pi-ext/extensions/fold/index.ts
```

`--no-extensions` 会关掉其它被发现的扩展，但显式用 `-e` 指定的路径仍会加载。首次尝试建议
用它，可以避免和别的折叠类扩展打架——见[疑难排查](#疑难排查)。

## 首次使用

1. 启动 Pi，确认扩展已生效：

   ```
   /fold status
   ```

   应该看到类似
   `fold: enabled=true tools=true compact=true thinking=true summary=true preview=true/5 turn=true hints=true | patch=yes …` 的输出。

2. **做一次**思考折叠的初始化：

   ```
   /fold init
   ```

   Pi 只有在自己的 `hideThinkingBlock` 为真时才会折叠思考块，而且这个设置只在启动时读取。
   `/fold init` 会把它写进 `~/.pi/agent/settings.json`，并在会话空闲时自动重载。
   跳过这一步，思考块会完整显示，扩展也不会去动它。

3. 发一个会用到工具的提示，结果默认就是折叠状态。

## 看懂对话区

### 单行工具行（compact，默认）

```
● read src/injector.ts · 42 lines · 0.3s
```

- 开头的 `●` 是状态灯：执行中是 accent 色（此时整行是 `● bash npm test · running…`），
  成功后变绿，失败变红。
- 工具名后面是参数摘要：`read`/`write`/`edit` 显示文件名（basename），`bash` 显示
  首条命令，`grep` 显示 pattern，以此类推。
- 其余部分与经典模式的汇总相同（见下面那张表）。shell 失败时会在末尾追加输出首行
  作为失败原因。
- 工具还在执行、尚无任何输出时，同一行显示 `running…` 代替汇总。
- **`edit` 是例外**：状态行下方附 diff 预览，直接从原始 diff 文本切片——**改动行优先**
  （`-`/`+` 红/绿着色），每处改动上下各保留 1 行上下文，总量钳制在 `previewLines + 2` 行，
  末尾加 `… N more diff lines` 提示。不像 Pi 自顶向下的 diff 渲染会把行数浪费在开头上下文上。
  `write` 维持单行。
- 按 `ctrl+o`（或点击该行）展开成 Pi 原生的调用行和完整结果，与经典模式一致。

### 工具调用行（经典模式）

```
⏺ read  src/injector.ts
```

`⏺` 是 pi-fold 的标记，颜色反映工具状态：执行中是 accent 色，失败是错误红，其余是弱化色。
这一行剩下的部分是 Pi 自己的调用渲染器，原样保留。

### 折叠后的结果行（经典模式）

```
  ⎿  42 lines · 0.3s
     12  import { createInjector } from "./injector";
     13  return createInjector(options);
     … 37 more lines (ctrl+o to expand)
```

- `⎿` 引出汇总行。可以通过 `/fold summary` 关掉。
- `42 lines` 是汇总内容，**因工具而异**——见下面那张表。
- `0.3s` 是工具耗时，**只有耗时达到 1 秒及以上才显示**。
- 缩进的那块是预览：默认显示前 `previewLines` 行（默认 5 行）。
  `read` 的预览带**真实行号**，从请求的 `offset` 开始编号。
- `… 37 more lines (ctrl+o to expand)` 是展开提示。`bash` 会显示
  `… 17 earlier lines`，因为它预览的是输出的**尾部**。
- `ctrl+o` 是从 Pi 的按键表里查出来的，所以你如果重绑了
  `app.tools.expand`，这里显示的会是你的按键。

按 `ctrl+o`（或点击该行）后，`⏺` 以下的全部内容会换成 Pi 原本那份完整结果——就是不带扩展
时 Pi 自己会画的那个组件。展开状态下，`⏺` 标记本身会变成 `▾` 三角形，并保留同样的状态色
（红＝失败、accent＝执行中、绿＝成功），一眼就能看出当前是展开态。

### 各工具的汇总对照表

| 工具 | 汇总 | 预览 |
|---|---|---|
| `read` | `N lines`（截断时附 `truncated`） | 头部，带从 `offset` 起的行号槽 |
| `write` | `wrote N lines` | 无——调用行已经显示了内容 |
| `edit` | `+新增 -删除` | 无——调用行已经显示了 diff |
| `bash`、`powershell` | `exit N · M lines` | 尾部（输出里有价值的那端） |
| `grep` | `N matches` / `no matches` | 头部 |
| `find` | `N files` / `no files` | 头部 |
| `ls` | `N entries` / `empty` | 头部 |
| 其它任何工具 | 输出的第一行 | 头部 |
| 任何失败 | 错误文本；shell 则显示 `exit N` | shell 保留预览 |

几点说明：

- `read` 读到图片时显示 `image`，不给预览。
- `write` 统计的是"被要求写入的行数"，不是结果文本。
- shell 失败时保留有用的输出，同时隐藏 Pi 追加的 `Command exited with code N`
  那行——因为 `exit N` 已经表达了同样的信息。
- `no matches` / `no files` / `empty` 被识别为空结果，所以不会出现一行误导性的预览。

### 思考行

```
✻ Thinking…              ← 这段思考还在流式输出
✻ Thought for 3.2s       ← 已结束，耗时至少 0.5 秒
✻ Thought                ← 已结束，不足 0.5 秒，或从会话里恢复出来的
```

思考块隐藏时，这个标签会替换掉 Pi 的 `Thinking...` 占位符。耗时只对**实时观察到**的思考段
计算，所以恢复一个历史会话时，不会凭空给出一个它没有测量过的时长。

`ctrl+t`（Pi 的 `app.thinking.toggle`）会显示完整的思考 Markdown，和 Pi 原本渲染的一模一样
——扩展不去碰展开态。

### 轮次汇总

```
✻ Worked for 12.3s · 3 tools · thought 4.1s
```

每一轮结束后追加（仅 TUI 模式）。几种变体：

- `Stopped after …`：这一轮被你中断了。
- `Failed after …`：这一轮以错误结束。
- `· 3 tools (1 failed)`：有工具调用失败。
- `· thought 4.1s`：仅当思考耗时达到 0.5 秒。

按 `ctrl+o` 会展开成每个工具一行：

```
✻ Worked for 12.3s · 2 tools
  ✓ read 1.2s
  ✗ bash 0.8s
```

没有任何工具调用、且思考不足半秒的轮次不会产生汇总。这条记录属于会话数据而非上下文：
**永远不会发给模型。**

## 按键

pi-fold 不新增任何按键，只复用 Pi 的：

| 按键 | 作用 | Pi 的动作名 |
|---|---|---|
| `ctrl+o` | 展开/收起工具输出和轮次汇总 | `app.tools.expand` |
| `ctrl+t` | 显示/隐藏思考块 | `app.thinking.toggle` |
| 鼠标点击 | 切换某个工具行或思考行 | — |

按 Pi 的常规方式重绑即可，提示文字会跟着你的绑定走。

## 命令

全部挂在 `/fold` 下。

| 命令 | 作用 |
|---|---|
| `/fold` | 总开关取反（等同 `/fold toggle`） |
| `/fold on` · `/fold off` | 全开 / 全关 |
| `/fold tools` | 切换工具折叠 |
| `/fold compact` | 切换单行工具行（`● 工具 参数 · 结果`） |
| `/fold diff` | 切换 compact `edit` 行下方的 diff 预览 |
| `/fold thinking` | 切换思考折叠 |
| `/fold summary` | 切换 `⎿ summary` 汇总行 |
| `/fold preview` | 切换截断预览 |
| `/fold turn` | 切换每轮的 `✻ Worked for …` 汇总 |
| `/fold hints` | 切换 `(ctrl+o to expand)` 提示 |
| `/fold init` | 把 `hideThinkingBlock: true` 写进 Pi 设置并重载 |
| `/fold status` | 显示当前设置和补丁状态 |

示例：

```
/fold off            # 暂时停止折叠，扩展仍加载着
/fold preview        # 保留汇总，去掉预览块
/fold turn           # 不要再追加每轮的页脚
/fold status         # 现在到底开了什么？
```

改动**立即生效**于新产生的行，已经渲染好的行也会针对你改动的那部分重绘。设置持久化到
`fold.json`（见下）并在重启后保留。`/fold` 的总开关也会被保存，所以 `/fold init`
只用于一次性设置 `hideThinkingBlock`。

## 配置

### `fold.json`

`/fold` 会写到这里：

| 平台 | 路径 |
|---|---|
| 默认 | `~/.pi/agent/fold.json` |
| 自定义 agent 目录 | `$PI_CODING_AGENT_DIR/fold.json` |

路径来自 Pi 自己的 `getAgentDir()`，所以它会跟随你的 Pi 安装位置，而不是靠猜。

完整字段说明：

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关。`false` 会完全恢复 Pi 的原生渲染。 |
| `tools` | boolean | `true` | 把工具结果折叠成 `⎿ summary` 行。 |
| `compact` | boolean | `true` | 把每个折叠的工具收成一行 `● 工具 参数 · 结果`，而不是调用行 + 汇总行。 |
| `editDiff` | boolean | `true` | 在 compact `edit` 行下方显示改动行 diff 预览。 |
| `thinking` | boolean | `true` | 把隐藏的思考标签替换为 `✻ …`。 |
| `summary` | boolean | `true` | 是否绘制 `⎿ summary` 行。 |
| `preview` | boolean | `true` | 是否在汇总下方绘制截断预览。 |
| `previewLines` | number | `5` | 预览行数，钳制在 `0`–`50`；`0` 等价于 `preview: false`。 |
| `turnSummary` | boolean | `true` | 每轮追加 `✻ Worked for …` 记录。 |
| `hints` | boolean | `true` | 在截断行末尾追加 `(ctrl+o to expand)`。 |

未知键会被忽略，类型不对的值会退回默认值，所以手改坏了或残留旧字段的文件都不可能造成
无效状态。

示例：

```json
{
  "enabled": true,
  "tools": true,
  "compact": true,
  "thinking": true,
  "summary": true,
  "preview": true,
  "previewLines": 3,
  "turnSummary": true,
  "hints": false
}
```

这个文件只在扩展加载时读取一次。请在 Pi 停止时编辑，或者直接用 `/fold` 做实时修改。

### `hideThinkingBlock`

思考折叠需要 Pi 保持思考块处于折叠态。那是 Pi 自己的设置，存在
`~/.pi/agent/settings.json`：

```json
{ "hideThinkingBlock": true }
```

`/fold init` 会替你写好。`ctrl+t` 切换的也是同一个设置并且会持久化，所以你手动展开过一次思考
之后，折叠就会一直关着，直到你再隐藏回去。

### 命令行参数

```
pi --fold     # 启动时开启折叠，覆盖 fold.json
```

**没有** `--no-fold`：布尔参数无法从命令行取反（Pi 会报 unknown option）。要用 `/fold off`
或直接改 `fold.json`。

## 关掉某一部分

| 我想要… | 这么做 |
|---|---|
| 完全不要折叠，但扩展还留着 | `/fold off` |
| 要折叠，但不要预览 | `/fold preview` |
| 只要汇总，不要预览也不要提示 | `/fold preview` + `/fold hints` |
| 只折工具，不动思考 | `/fold thinking` |
| 不要每轮页脚 | `/fold turn` |
| 只折思考，不动工具 | `/fold tools` |

`/fold off` 会让扩展保持加载并继续响应 `/fold`，方便和 Pi 的原生渲染来回对比。
要彻底移除扩展，见[卸载](#卸载)。

## 疑难排查

**思考块没有折叠 / 还是 Pi 的 `Thinking...`。**

运行 `/fold init`（如果提示了再重载一次）。Pi 必须处于 `hideThinkingBlock: true`，而它只在启动
时读一次。`ctrl+t` 也会翻转这个设置，所以如果你手动展开过思考，再隐藏回去即可。

**`/fold status` 显示 `patch=no`。**

用于装饰思考标签的私有钩子（`AssistantMessageComponent.prototype.updateContent`）
在你这个 Pi 版本里已经找不到了。思考会退回 Pi 的原生渲染，其它功能照常工作。请带上你的 Pi
版本提个 issue。

**改完 `fold.json` 没反应。**

这个文件在加载时读取。实时修改请用 `/fold …`，或者重启 Pi。

**显示错乱 / 在两种排版之间来回跳。**

有别的扩展也在注册工具渲染器。最常见的是 `transcript-blocks.ts`：它同样给 assistant 渲染器打
补丁并注册自己的工具渲染器，两者会互相包裹。**只启用其中一个。**

**窄终端下预览被截得奇怪。**

预览会按可见宽度截断，汇总行和提示行都用 `visibleWidth` 计量，因此 emoji 宽度的终端里也能对齐。
如果仍有错位，请附上终端类型和宽度反馈。

**`/fold init` 提示写不了设置。**

agent 目录不可写。修一下 `~/.pi/agent` 的权限，或者把 `PI_CODING_AGENT_DIR` 指到一个可写目录。

## 兼容性与平台

**宿主 API。** 工具折叠和轮次汇总只用公开的扩展 API。思考折叠是唯一的私有钩子：它包裹
`AssistantMessageComponent.prototype.updateContent`。这个导出以前就从公开入口消失过，所以扩展
通过一个小的兼容层（`host.ts`）去解析它，并且是**软失败**的。钩子找不到只会让思考折叠失效，
别的功能不受影响，会话也绝不会因此崩掉。

**Pi 升级之后。** 工具折叠和轮次汇总应当继续工作。如果私有钩子挪了位置，`/fold status` 会变成
`patch=no`，思考退回原生渲染。

**平台。** 纯 Node API，没有 shell 调用，也没有平台相关代码。配置目录来自 `getAgentDir()`，
所以 macOS、Linux、Windows（包括自定义 `PI_CODING_AGENT_DIR`）都能正确解析。

**其它 Pi 发行版。** 扩展导入的是 `@earendil-works/pi-coding-agent`。如果某个 fork 用了不同的
包名，需要一层包名解析适配，而且它的私有组件内部结构可能不同。

实现细节、兼容层设计和基准测试见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（英文）。

## 卸载

```bash
pi remove /path/to/pi-ext
```

或者删掉 `~/.pi/agent/extensions/` 下的软链/副本，再删除 `~/.pi/agent/fold.json`。
若要同时恢复 Pi 对思考的默认行为，要么停用扩展，要么在 `~/.pi/agent/settings.json`
里设置 `hideThinkingBlock: false`。

## 开发

```bash
npm run typecheck    # tsc --noEmit
npm test             # 87 条断言：折叠、思考、汇总、配置（失败时 exit 1）
npm run smoke        # 人读的渲染 dump（无需 TUI、无需模型）
npm run bench        # 折叠渲染 vs 原生的耗时
npm run verify:host  # 在 Pi 真实的 virtualModules 加载路径下验证兼容层
```

这些断言经过变异测试：把某个修复回退掉（shell 退出码匹配、`write` 行数、`isPartial` 短路、
settle 守卫……）测试就会变红。基准测试显示：折叠行的开销基本不随输出增长，而 Pi 原生展开渲染
会随输出规模线性增长。

## 许可证

MIT — 见 [LICENSE](LICENSE)。
