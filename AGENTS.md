# AGENTS.md

**pi-yancy-ui** 的项目记忆 —— 一个把 Pi 的 TUI 转录区渲染成 Claude Code 风格的扩展。
本文件是本仓库的工作准则；保持简短，细节写进 `docs/ARCHITECTURE.md` 并链接，不要重复。

## 项目是什么

一个 Pi 扩展（包名 `pi-yancy-ui`），通过 `package.json` → `pi.extensions` →
`extensions/fold/index.ts` 注册。它**只改渲染**：

- **M1 工具折叠** —— 工具调用 + 结果收成 `● 调用` / `⎿ 汇总`（外加几行预览），
  用 Pi 自带的 `ctrl+o` 展开。
- **M2 思考折叠** —— 隐藏的思考段收成 `✻ Thought for 3.2s`，用 Pi 自带的 `ctrl+t` 展开。
- **M3 轮次汇总** —— 每轮追加一条 `✻ Worked for 12.3s · 3 tools · thought 4.1s`。

助手正文**永不**折叠。工具执行、模型上下文、会话文件都不受影响。无运行时依赖 ——
只有对 `@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-tui` 的
`peerDependencies`。

## 本机环境

- Windows，仓库在 `D:\code\vibe_coding\pi-ext`。Bash（MSYS）的当前目录就是它。
- Node v24 位于 `/mnt/d/program2/nvm/nodejs/node.exe`。**`node` 不在 bash 的 PATH 上** ——
  用完整路径，或设 `PATH="$PATH:/mnt/d/program2/nvm/nodejs"`。下文的 `npm run …`
  是可移植写法。

## 命令

| 命令 | 用途 |
|---|---|
| `npm run typecheck` | `tsc --noEmit`。必须零报错。 |
| `npm test` | 87 条断言，覆盖折叠、思考、轮次汇总、配置、命令接线。任何回归退出码 1。 |
| `npm run smoke` | 人类可读的渲染输出，不需要 TUI / 模型。改动可见输出时用。 |
| `npm run bench` | 折叠渲染 vs 原生的开销。动渲染热路径时用。 |
| `npm run verify:host` | 走 Pi 真实的 `virtualModules` 映射加载 `host.ts`，而非普通 Node 解析。 |
| `npm run dev` | `pi --no-extensions -e ./extensions/fold/index.ts`，实机试跑。 |

**改完必须跑 `npm run typecheck && npm test` 才算完成。** 动了 host API 还要跑
`verify:host`；动了渲染输出还要跑 `smoke`。

## 目录结构

```
extensions/fold/
  index.ts           入口：加载配置、/fold 命令、生命周期接线
  config.ts          fold.json 读写 + 校验，写入 settings.json
  host.ts            唯一读取私有/半私有 host API 的模块
  palette.ts         主题查询、fg/bg/bold/italic、按键名、宽度工具
  patch.ts           幂等、可链式回退的原型补丁
  recycle.ts         组件回收、Row 包装、安全宽度/截断
  tool-fold.ts       M1：registerToolRenderer 包装 + 折叠行构造
  thinking-fold.ts   M2：updateContent 补丁 + 思考标签与计时
  turn-summary.ts    M3：appendEntry + entry 渲染器
```

测试是纯 Node 脚本（`test.mjs`、`smoke.mjs`、`bench.mjs`、`verify-host.mjs`），
通过 **jiti** 加载 TypeScript 源码。它们在无头模式下运行，并做了两件事：
(a) 把 `PI_CODING_AGENT_DIR` 指向临时目录；(b) 在全局主题 symbol 上装一个恒等主题。
复用这套 harness，不要引入测试框架。

## 硬约束（不可破坏）

1. **只改渲染。** 绝不重跑工具、重读文件，或改变模型看到的内容。折叠行只能用 Pi
   已经交给渲染器的数据（`result.content`、`result.details`、`context.args`、
   `context.durationMs`、`context.isError`）。
2. **不引入新按键。** 展开永远走 Pi 原生的 `ctrl+o` / `ctrl+t` / 鼠标点击。
   任何内容都不能被永久隐藏。
3. **绝不把 wrapper 当 `lastComponent` 返回。** 内置渲染器会回收它自己持有的组件
   （`context.lastComponent ?? new Text(...)` 然后就地 mutate）。必须把手回存在
   `Symbol.for("pi-yancy-ui.inner")` 下的内置组件（`recycle.ts` 的 `innerOf` /
   `callBaseRenderer`）。搞错这一点会让行在两种布局间逐帧闪烁。
4. **先切片再高亮。** 预览最多 `previewLines` 行：先切分行、切片，**然后**对切片跑
   `highlightCode`。绝不高亮整个文件。
5. **一切 fail soft。** 可选 host API 和渲染器调用都要包 `try/catch`；一个导出缺失或
   方法改名只能让某个功能降级，绝不能弄挂扩展加载、也不能把异常抛进 Pi 的渲染循环。
6. **`host.ts` 是唯一**接触私有/半私有 host 接口的地方。在那里加带守卫的访问器，
   不要在别处 import 这类 API。新访问器要有 `verify-host.mjs` 覆盖。
7. **配置按引用实时读取。** `/fold` 修改的是同一个 `FoldConfig` 对象；渲染器必须在渲染
   时读取（并把 `configGeneration()` 纳入 memo key），绝不能在建补丁时快照。
8. **原型补丁必须走 `patch.ts`。** 它以 `Symbol.for("pi-yancy-ui.prototype-patches")` 在
   目标上注册，reload 时复用真正的 predecessor，被顶替时转发，`restore()` 还原原始
   descriptor。`session_shutdown` 还原，`session_start` 重装。
9. **轮次边界用 `agent_settled`，不用 `agent_end`**（自动重试/续写会导致过早写入错误的
   汇总）。忽略带 `parentToolCallId` 的事件，免得子代理的工具混进父级汇总。思考耗时必须
   无条件 drain，否则会泄漏到下一轮。

## 约定

- TypeScript ESM，`strict`、`noEmit`、`verbatimModuleSyntax` —— 纯类型导入必须写
  `import type`。
- 无运行时依赖。几行代码能做的事不要加依赖。
- 注释解释**为什么**（在绕开什么 bug 或 host 怪癖），用英文，与周围风格一致。
- commit 用约定式前缀：`docs: …`、`feat: …`、`fix: …`（见 `git log`）。
- 用户可见行为变化要同步文档：`README.md` 与 `README.zh-CN.md`（两份都在维护，
  中文版不是占位）+ `docs/ARCHITECTURE.md` 记录内部实现。
- 变异测试思维：修 bug 时补一条「去掉修复就失败」的断言。优先扩展现有测试文件，
  而不是新建。

## 文档地图

- `README.md` / `README.zh-CN.md` —— 面向用户：按键、`/fold` 命令、配置、
  各工具汇总对照表、疑难排查。
- `docs/ARCHITECTURE.md` —— 数据流、回收与补丁设计、host shim 对照表、
  基准数据、测试策略、已知限制。
