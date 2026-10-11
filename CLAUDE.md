# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 规则写在哪

`AGENTS.md` 是本仓库的权威项目记忆，已作为项目指令自动载入上下文。它记录了全部硬约束
（只改渲染、不加按键、绝不把 wrapper 当 `lastComponent` 返回、先切片再高亮、一切 fail soft、
`host.ts` 是唯一私有 API 边界、配置按引用实时读取、原型补丁必须走 `patch.ts`、
轮次边界用 `agent_settled`）。

**不要在这里复述或另立一套规则** —— 要改规则就改 `AGENTS.md`。

本文件只补 `AGENTS.md` 没有的两样东西：命令面，以及需要跨多个文件才能拼出来的架构全貌。

## 命令

所有脚本都是纯 Node ESM，通过 **jiti** 直接加载 TypeScript（无构建、无测试框架）。它们把
`PI_CODING_AGENT_DIR` 指向临时目录，并在全局主题 symbol 上装一个恒等主题，因此可在无头模式下
运行，不需要 TUI，也不需要模型。

| 命令 | 用途 |
|---|---|
| `npm run typecheck` | `tsc --noEmit`（`strict` + `verbatimModuleSyntax`）。必须零报错。 |
| `npm test` | 99 条断言，覆盖折叠、思考、轮次汇总、配置、命令接线。 |
| `npm run smoke` | 人类可读的渲染输出。改动可见输出时用。 |
| `npm run bench` | 折叠渲染 vs Pi 原生展开渲染的开销。 |
| `npm run verify:host` | 走 Pi 真实的 `virtualModules` 映射加载 `host.ts`，而非普通 Node 解析。 |
| `npm run dev` | 实机试跑：`pi --no-extensions -e ./extensions/yancy-ui/index.ts`。 |

**改完必须跑 `npm run typecheck && npm test` 才算完成。**动了 host 访问器还要跑 `verify:host`；
动了渲染输出还要跑 `smoke`。

本机的 `node` 不在 bash 的 `PATH` 上；先 `PATH="$PATH:/mnt/d/program2/nvm/nodejs"`，
或用 `node.exe` 的完整路径。

**没有单条测试的开关。** `test.mjs` 把 `test(name, fn)` 收进一个数组，文件末尾的 runner 依次跑完
全部（任一失败即退出码 1）。要单独跑一条，就在那个末尾循环上加个临时的名字过滤，别为此引入
测试框架。修 bug 时补一条「去掉修复就失败」的断言（本套件按变异测试维护）。

## 架构

`pi-yancy-ui` 是一个 Pi 扩展，通过 `package.json` → `pi.extensions` → `extensions/yancy-ui/index.ts`
注册。它**只改渲染** —— 工具执行、模型上下文、会话文件都不动。只有 peerDependencies，
无运行时依赖。

三套彼此独立的机制，都在 `index.ts` 里接线：

- **M1 工具折叠**（`tool-fold.ts`）—— 包装 `registerToolRenderer` 交来的渲染器，并强制
  `renderShell: "self"`。折叠的结果渲染成 `Text(汇总 + 预览 + 提示)`；展开时把行交给此前存下的
  内置组件，而那个组件是唯一跨帧存活的状态。
- **M2 思考折叠**（`thinking-fold.ts`）—— 唯一的私有钩子。Pi 没有助手消息的渲染器 API，
  所以补丁打在 `AssistantMessageComponent.prototype.updateContent` 上：先调真正的前任，再给隐藏的
  思考 `Text` 子节点换标签。计时存在按组件索引的 `WeakMap` 里，并无条件 drain 进轮次计数。
- **M3 轮次汇总**（`turn-summary.ts`）—— 追加一个自定义 entry
  `pi.appendEntry("yancyui-turn", …)`，用官方 `registerEntryRenderer` 画出来。在 `agent_settled`
  上结算，而不是 `agent_end`。

### 跨文件不变量

- **两个 symbol 就是持久化契约。** `Symbol.for("pi-yancy-ui.inner")` 在每个 wrapper 里存内置组件
  （`recycle.ts` 的 `innerOf` / `callBaseRenderer`）；`Symbol.for("pi-yancy-ui.prototype-patches")`
  把补丁状态注册在目标方法上（`patch.ts`）。reload、组件回收、卸载还原全都依赖这两个查找点
  是**唯一**的。
- **配置按引用在渲染时读取。** `/yancyui` 改的是 `index.ts` 里创建的那个唯一 `YancyUiConfig` 对象；
  渲染器必须在渲染时读取它（并把 `config.ts` 的 `configGeneration()` 纳入 memo key），
  绝不能在建补丁时把配置快照进去。
- **失败永远是局部的。** 可选 host API 只能经 `host.ts` 的访问器拿到，每个访问器都自校验并吞异常。
  一个导出缺失只让某个功能降级；任何异常都不许抛进 Pi 的渲染循环。

### 继续深入前先读

- `docs/ARCHITECTURE.md` —— 数据流、回收与补丁设计、host shim 对照表、基准数据、已知限制。
- `README.md` / `README.zh-CN.md` —— 面向用户的行为；两份都在维护，行为变化要同步。
