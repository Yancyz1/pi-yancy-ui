# pi-fold

**English** · [中文](README.zh-CN.md)

Claude Code–style folding for [Pi](https://pi.dev): thinking blocks and tool output
collapse to one line each, and expand again with Pi's own keys.

```
● read src/injector.ts · 42 lines · 0.3s
● bash npm test · exit 0 · 18 lines · 4.2s
✻ Thought for 3.2s
✻ Worked for 12.3s · 3 tools · thought 4.1s
```

Each finished tool call is a single status line (compact mode, the default).
`/fold compact` switches back to the two-line layout:

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

- **Assistant text is never folded.** Only thinking blocks and tool results are.
- **Nothing is hidden permanently.** Every folded row expands with Pi's native
  `ctrl+o` / `ctrl+t` or a click. No new keybindings are introduced.
- **Tool execution is untouched.** Only rendering changes; the model sees the same
  output it always did.

---

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [First run](#first-run)
- [Reading the transcript](#reading-the-transcript)
  - [Tool call row](#tool-call-row)
  - [Collapsed result row](#collapsed-result-row)
  - [Per-tool summary reference](#per-tool-summary-reference)
  - [Thinking row](#thinking-row)
  - [Turn summary](#turn-summary)
- [Keys](#keys)
- [Commands](#commands)
- [Configuration](#configuration)
- [Turning parts off](#turning-parts-off)
- [Troubleshooting](#troubleshooting)
- [Compatibility and platforms](#compatibility-and-platforms)
- [Uninstall](#uninstall)
- [Development](#development)

---

## Requirements

- A Pi build with the extension API: `registerToolRenderer`, `registerEntryRenderer`,
  `appendEntry`, and the `tool_execution_*` / `agent_*` events. Every current Pi
  release has these.
- Thinking folding additionally depends on Pi's `hideThinkingBlock` setting (see
  [First run](#first-run)).

## Install

### Recommended: install as a Pi package

From the package directory:

```bash
pi install /path/to/pi-ext
```

`pi` reads the `pi.extensions` field in `package.json` and adds the extension to
your settings, so it loads on every start.

```bash
pi list              # confirm it is registered
pi remove /path/to/pi-ext   # remove it again
```

### Alternative: symlink into the extensions folder

macOS / Linux:

```bash
ln -s "/path/to/pi-ext/extensions/fold" ~/.pi/agent/extensions/fold
```

Windows (PowerShell):

```powershell
New-Item -ItemType SymbolicLink `
  -Path "$env:USERPROFILE\.pi\agent\extensions\fold" `
  -Target "C:\path\to\pi-ext\extensions\fold"
```

Copying the `extensions/fold` folder there works too; a symlink just keeps it in
sync with this repo.

### Try it for one session

```bash
pi --no-extensions -e /path/to/pi-ext/extensions/fold/index.ts
```

`--no-extensions` disables other discovered extensions; explicit `-e` paths still
load. This is the safest first run because it avoids clashing with another folding
extension — see [Troubleshooting](#troubleshooting).

## First run

1. Start Pi and check that the extension is live:

   ```
   /fold status
   ```

   You should see something like
   `fold: enabled=true tools=true compact=true thinking=true summary=true preview=true/5 turn=true hints=true | patch=yes …`.

2. Enable thinking folding **once**:

   ```
   /fold init
   ```

   Pi only collapses thinking blocks when its own `hideThinkingBlock` setting is on,
   and it reads that setting at startup. `/fold init` writes it to
   `~/.pi/agent/settings.json` and reloads automatically when the session is idle.
   Without this step, thinking blocks render in full and the extension leaves them
   alone.

3. Send a prompt that uses a tool. Results start collapsed.

## Reading the transcript

### Compact tool line (default)

```
● read src/injector.ts · 42 lines · 0.3s
```

- The leading `●` is a status light: accent while the tool is running (the line reads
  `● bash npm test · running…`), green once it succeeded, red when it failed.
- After the tool name comes a short digest of the arguments: the basename for
  `read`/`write`/`edit`, the first command line for `bash`, the pattern for `grep`, and
  so on.
- The rest is the same tool-specific summary as the classic mode (see the table
  below). For a failed shell command the first output line is appended as the failure
  reason.
- While the tool runs and has not produced any output yet, the same line shows
  `running…` in place of the summary.
- Pressing `ctrl+o` (or clicking the row) expands to Pi's original call row and
  complete result, exactly like the classic mode.

### Tool call row (classic mode)

```
⏺ read  src/injector.ts
```

`⏺` is the pi-fold marker. Its colour tracks the tool state: accent while the tool is
running, error red when it failed, muted otherwise. The rest of the line is Pi's own
call renderer, unchanged.

### Collapsed result row (classic mode)

```
  ⎿  42 lines · 0.3s
     12  import { createInjector } from "./injector";
     13  return createInjector(options);
     … 37 more lines (ctrl+o to expand)
```

- `⎿` starts the summary line. It is optional (`/fold summary`).
- `42 lines` is the summary, tool-specific — see the table below.
- `0.3s` is the tool duration. It only appears for tools that took **1 second or
  longer**.
- The indented block is the preview: the first `previewLines` lines (5 by default).
  `read` previews carry **real line numbers**, starting from the requested `offset`.
- `… 37 more lines (ctrl+o to expand)` is the hint. `bash` says
  `… 17 earlier lines` because it previews the **tail** of its output.
- `ctrl+o` is rendered from Pi's keybinding table, so a user who rebinds
  `app.tools.expand` sees their own key.

Pressing `ctrl+o` (or clicking the row) replaces everything below `⏺` with Pi's
original, complete result — same component Pi would have drawn without the extension.
While expanded, the `⏺` marker itself becomes a `▾` triangle in the same status
colours (red failed, accent running, green done), so the toggle state is visible at
a glance.

### Per-tool summary reference

| Tool | Summary | Preview |
|---|---|---|
| `read` | `N lines` (plus `truncated`) | head, with a line-number gutter from `offset` |
| `write` | `wrote N lines` | none — the call row already shows the content |
| `edit` | `+added -removed` | none — the call row already shows the diff |
| `bash`, `powershell` | `exit N · M lines` | tail (the interesting end of the output) |
| `grep` | `N matches` / `no matches` | head |
| `find` | `N files` / `no files` | head |
| `ls` | `N entries` / `empty` | head |
| anything else | its first output line | head |
| any failure | the error text, or `exit N` for shells | shells keep their preview |

Notes:

- `read` on an image shows `image` and no preview.
- `write` counts the lines it was asked to write, not the result text.
- Shell failures keep the useful output visible and hide Pi's trailing
  `Command exited with code N` line, which is already reflected in `exit N`.
- `no matches` / `no files` / `empty` are recognised as empty results, so no
  misleading preview line is shown.

### Thinking row

```
✻ Thinking…              ← the run is still streaming
✻ Thought for 3.2s       ← finished, took at least 0.5s
✻ Thought                ← finished, shorter than 0.5s, or restored from a session
```

The label replaces Pi's `Thinking...` placeholder while the block is hidden. It is
only computed for runs watched live, so a session you resume never claims a duration
it did not measure.

`ctrl+t` (Pi's `app.thinking.toggle`) reveals the full thinking Markdown, exactly as
Pi renders it — the extension leaves the expanded view untouched.

### Turn summary

```
✻ Worked for 12.3s · 3 tools · thought 4.1s
```

Appended after each turn (in the TUI only). Variants:

- `Stopped after …` when you interrupted the turn.
- `Failed after …` when the turn ended in an error.
- `· 3 tools (1 failed)` when some tool calls failed.
- `· thought 4.1s` only when thinking took at least 0.5s.

`ctrl+o` expands it into one line per tool:

```
✻ Worked for 12.3s · 2 tools
  ✓ read 1.2s
  ✗ bash 0.8s
```

A turn with no tool calls and less than half a second of thinking produces no
summary. The entry is session data, not context: **it is never sent to the model.**

## Keys

pi-fold adds no keybindings. It reuses Pi's:

| Key | Action | Pi action name |
|---|---|---|
| `ctrl+o` | Expand/collapse tool output and the turn summary | `app.tools.expand` |
| `ctrl+t` | Show/hide thinking blocks | `app.thinking.toggle` |
| click | Toggle a tool row or thinking row | — |

Rebind them in Pi's keybindings as usual; the hints follow your binding.

## Commands

Everything lives under `/fold`.

| Command | Effect |
|---|---|
| `/fold` | Toggle folding on/off (same as `/fold toggle`) |
| `/fold on` · `/fold off` | Enable / disable everything |
| `/fold tools` | Toggle tool folding |
| `/fold compact` | Toggle single-line tool rows (`● tool args · outcome`) |
| `/fold thinking` | Toggle thinking folding |
| `/fold summary` | Toggle the `⎿ summary` row |
| `/fold preview` | Toggle the truncated preview |
| `/fold turn` | Toggle the per-turn `✻ Worked for …` summary |
| `/fold hints` | Toggle the `(ctrl+o to expand)` hint |
| `/fold init` | Write `hideThinkingBlock: true` to Pi's settings and reload |
| `/fold status` | Show the current settings and patch state |

Examples:

```
/fold off            # temporarily stop folding, keep the extension loaded
/fold preview        # keep summaries, drop the preview block
/fold turn           # stop the per-turn footer
/fold status         # what is on right now?
```

Changes apply **immediately** to new rows, and already-rendered rows are repainted
for the part you changed. Settings persist to `fold.json` (see below) and survive a
restart. `Folding on/off` via `/fold` is saved too, so use `/fold init` only for the
one-time `hideThinkingBlock` setup.

## Configuration

### `fold.json`

`/fold` writes here:

| Platform | Path |
|---|---|
| Default | `~/.pi/agent/fold.json` |
| Custom agent dir | `$PI_CODING_AGENT_DIR/fold.json` |

The path comes from Pi's own `getAgentDir()`, so it follows your Pi installation
instead of guessing.

Full field reference:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch. `false` restores Pi's stock rendering completely. |
| `tools` | boolean | `true` | Fold tool results into `⎿ summary` rows. |
| `compact` | boolean | `true` | Render each collapsed tool as one `● tool args · outcome` line instead of call + summary rows. |
| `thinking` | boolean | `true` | Replace the hidden thinking label with `✻ …`. |
| `summary` | boolean | `true` | Draw the `⎿ summary` line. |
| `preview` | boolean | `true` | Draw the truncated preview under the summary. |
| `previewLines` | number | `5` | Preview rows, clamped to `0`–`50`. `0` behaves like `preview: false`. |
| `turnSummary` | boolean | `true` | Append the `✻ Worked for …` entry per turn. |
| `hints` | boolean | `true` | Append `(ctrl+o to expand)` to truncated rows. |

Unknown keys are ignored, and values of the wrong type fall back to the default, so a
hand-edited or stale file can never produce a broken state.

Example:

```json
{
  "enabled": true,
  "tools": true,
  "thinking": true,
  "summary": true,
  "preview": true,
  "previewLines": 3,
  "turnSummary": true,
  "hints": false
}
```

The file is read once when the extension loads. Edit it while Pi is stopped, or use
`/fold` to change things live.

### `hideThinkingBlock`

Thinking folding needs Pi to keep thinking blocks collapsed. That is Pi's own
setting, stored in `~/.pi/agent/settings.json`:

```json
{ "hideThinkingBlock": true }
```

`/fold init` sets it for you. `ctrl+t` toggles the same setting and persists it, so
revealing thinking once will turn folding off until you hide it again.

### CLI flag

```
pi --fold     # start with folding enabled, overriding fold.json
```

There is no `--no-fold`; a boolean flag cannot be negated from the command line (Pi
reports it as an unknown option). Use `/fold off` or edit `fold.json`.

## Turning parts off

| I want… | Do this |
|---|---|
| No folding at all, extension still loaded | `/fold off` |
| Folding, but no previews | `/fold preview` |
| Summaries only, no preview and no hint | `/fold preview` + `/fold hints` |
| Tools folded, thinking left alone | `/fold thinking` |
| No per-turn footer | `/fold turn` |
| Thinking folded, tools left alone | `/fold tools` |

`/fold off` keeps the extension loaded and responsive to `/fold`, which makes it easy
to compare against Pi's stock rendering. To remove the extension entirely, see
[Uninstall](#uninstall).

## Troubleshooting

**Thinking blocks are not folded / I see Pi's `Thinking...`.**

Run `/fold init` (and reload if asked). Pi must have `hideThinkingBlock: true`, which
it only reads at startup. `ctrl+t` also flips this setting, so if you revealed
thinking manually, hide it again.

**`/fold status` reports `patch=no`.**

The private hook that decorates thinking labels (`AssistantMessageComponent.prototype.updateContent`)
is no longer reachable in your Pi build. Thinking falls back to Pi's native rendering
and everything else keeps working. Please open an issue with your Pi version.

**Nothing changed after I edited `fold.json`.**

The file is read at load time. Use `/fold …` for live changes, or restart Pi.

**Rows look wrong / flip between two layouts.**

Another extension is also registering tool renderers. Most commonly
`transcript-blocks.ts`: it patches the same assistant renderer and installs its own
tool renderer, and the two wrap each other. Run only one of them.

**The preview is cut oddly on a narrow terminal.**

Previews are truncated to the visible width, and the summary/hint lines are measured
with `visibleWidth`, so emoji-width cells stay aligned. If a glyph still misaligns,
please report the terminal and width.

**`/fold init` says it could not write settings.**

The agent directory is not writable. Fix permissions on `~/.pi/agent`, or set
`PI_CODING_AGENT_DIR` to a writable directory.

## Compatibility and platforms

**Host APIs.** Tool folding and the turn summary use only public extension APIs.
Thinking folding is the single private hook: it wraps
`AssistantMessageComponent.prototype.updateContent`. That name has left Pi's public
entrypoints before, so the extension resolves it through a small compatibility shim
(`host.ts`) that fails soft. A missing hook disables thinking folding and nothing
else — the session never breaks.

**After a Pi update.** Tool folding and the turn summary should keep working
unchanged. If the private hook moves, `/fold status` flips to `patch=no` and thinking
renders natively.

**Platforms.** Pure Node APIs, no shell commands and no OS-specific code. The config
directory comes from `getAgentDir()`, so macOS, Linux, and Windows (including a custom
`PI_CODING_AGENT_DIR`) all resolve correctly.

**Other Pi distributions.** The extension imports `@earendil-works/pi-coding-agent`.
A fork that publishes under a different package name would need a package-resolution
shim, and its private component internals may differ.

Implementation details, the compatibility shim, and the benchmark live in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Uninstall

```bash
pi remove /path/to/pi-ext
```

Or delete the symlink/copy from `~/.pi/agent/extensions/`, and remove
`~/.pi/agent/fold.json`. To also restore Pi's defaults for thinking, either run
`/fold` and stop using the extension, or set `hideThinkingBlock: false` in
`~/.pi/agent/settings.json`.

## Development

```bash
npm run typecheck    # tsc --noEmit
npm test             # 87 assertions: folding, thinking, summary, config (exit 1 on failure)
npm run smoke        # human-readable render dump (no TUI, no model)
npm run bench        # collapsed-render cost vs native
npm run verify:host  # host shim under Pi's real virtualModules loader
```

The assertions are mutation-tested: reverting a fix (the shell exit-code match, the
`write` line count, the `isPartial` short-circuit, the settlement guard, …) makes the
suite fail. The benchmark shows collapsed rows staying flat in cost while Pi's native
expanded rendering grows with output size.

## License

MIT — see [LICENSE](LICENSE).
