# Architecture

How pi-yancy-ui draws folded rows, why it patches one prototype method, and how it stays
alive across Pi releases. For user-facing behaviour see [../README.md](../README.md).

## Layout

```
extensions/yancy-ui/
  index.ts           entry point: config load, /yancyui command, lifecycle wiring
  config.ts          yancy-ui.json read/write + validation, settings.json write
  host.ts            compatibility shim over @earendil-works/pi-coding-agent
  palette.ts         theme lookup, fg/bg/bold/italic, key labels, width helpers
  patch.ts           idempotent, chain-aware prototype patching
  recycle.ts         component recycling, Row wrapper, safe width/truncation
  tool-fold.ts       M1: registerToolRenderer wrapper + collapsed row builder
  thinking-fold.ts   M2: updateContent patch + thinking labels and timing
  turn-summary.ts    M3: per-turn entry via appendEntry + entry renderer
```

## Data flow

```
Pi tool_execution
      │
      ├─ renderCall   ──▶ tool-fold wrapper ──▶ Row(prefix "● ", padding) ──▶ built-in renderer
      │
      └─ renderResult ──▶ collapsed? ── yes ──▶ Text(summary + preview + hint)
                                    └─ no  ──▶ Row(built-in renderer's own component)

AssistantMessageComponent.updateContent
      └─▶ patched ──▶ built-in updateContent ──▶ decorate hidden thinking Text

agent_settled
      └─▶ turn-summary ──▶ pi.appendEntry("yancyui-turn", data)
                                └─▶ registerEntryRenderer("yancyui-turn") draws it
```

Everything in the collapsed path is derived from data Pi already gives the renderer:
`result.content`, `result.details`, `context.args`, `context.durationMs`,
`context.isError`. Nothing is re-executed or re-read.

## Tool folding (M1)

`registerToolRenderer` hands us the built-in renderers. We wrap them and force
`renderShell: "self"` so rows are flat and uniformly padded.

### Compact mode (default)

When `config.compact` is set, a finished tool renders as a single
`● tool args · outcome` line: the leading dot is a status light (accent running,
green success, red failure), the title carries a short argument digest
(basename for file tools, first command line for shells), and the tail reuses
`summarizeParts`. Two things make this safe without touching Pi's components:

- `ToolRenderContext.expanded` is available to **both** renderers, so `renderCall`
  returns an empty component only while collapsed and hands back Pi's native row the
  moment the user expands.
- `edit` is carved out: under the compact status line it appends a diff preview
  sliced **directly from `details.diff` before any colouring** — changed lines
  (`-`/`+`) first with one context line on each side, budget `previewLines + 2`,
  hint `… N more diff lines` (`previewLines: 0` disables). Slicing before colouring
  keeps constraint 4 intact and avoids the failure mode of capping Pi's rendered
  diff from the top, where the budget is spent on leading context lines. The call
  row stays hidden; the previous `Capped`-wrapper approach was removed. Gated by
  `config.editDiff` (`/yancyui diff`).
  Compact rows indent by `outputPad` regardless of the tool's own shell mode, so a
  self-padded tool (`edit`) lines up with everything else.
  `write` stays a single line — its call-row preview is content, which the summary
  (`wrote N lines`) covers well enough.
- Before the first result arrives (`isPartial` is `true` from construction), the call
  slot shows `● tool args · running…`. `compactResultRow` flips a shared-state flag
  (`Symbol.for("pi-yancy-ui.has-result")` on `context.state`, which Pi shares between the
  call and result slots of one tool row) and defers a `context.invalidate()` via
  `queueMicrotask` — invalidating synchronously would re-enter `updateDisplay` while
  Pi is mid-rebuild. One extra pass per tool stands the call row down.

The built-in call component stays reachable through `withInner`, so expanding still
recycles it instead of leaking a new component per toggle.

### Classic mode

Two details matter:

1. **Recycling.** Built-in renderers do `const text = context.lastComponent ?? new Text(...)`
   and then mutate it. If we handed back our wrapper, the next refresh would call
   `setText`/`clear` on the wrapper and throw, making rows flip between layouts. So
   every wrapper stores the built-in component under
   `Symbol.for("pi-yancy-ui.inner")`, and the next call passes that component back as
   `lastComponent`. `callBaseRenderer` also retries once without a `lastComponent` if
   a stale or foreign component is supplied, so a row can never be lost. Expanded call
   rows additionally swap the `●` marker for a `▾` triangle in the same status colours
   (`context.expanded`), so the toggle state is visible without changing anything the
   built-in renderer drew.

2. **Slice before highlight.** A preview takes at most `previewLines` rows. We split
   the text, slice it, and only then run `highlightCode` on the slice, so a 10,000-line
   `read` highlights five lines instead of the whole file. `read` previews also render
   a real line-number gutter derived from `args.offset`.

Summary text is tool-aware and recognises the empty-result strings Pi returns
(`No matches found`, `No files found …`, `(empty directory)`), plus Pi's shell failure
status line (`Command exited with code N`), which is stripped before counting and
previewing so it is not shown twice.

## Thinking folding (M2)

Pi exposes no renderer hook for assistant messages, so the only way to relabel a
collapsed thinking run is to wrap `AssistantMessageComponent.prototype.updateContent`.

The wrapper calls the predecessor first — Pi always produces the full, correct row —
then walks the newly built `contentContainer.children`, finds `MouseRegion`-wrapped
`Text` nodes (the hidden thinking rows), and replaces their text with a label. The
expanded `Markdown` nodes are never touched, so `ctrl+t` still shows Pi's own output.

Timing is per component, stored in a `WeakMap`. A run gets a start time only if it was
first seen while `isStreaming` was true, which is why a resumed session shows
`✻ Thought` with no fabricated duration. Completed time is accumulated into a module
level counter that the turn summary drains — and it is drained unconditionally, even
when the summary is disabled or the mode is not the TUI, so time can never leak into a
later turn.

`patch.ts` makes this safe:

- The patch registry lives on the prototype under
  `Symbol.for("pi-yancy-ui.prototype-patches")`, keyed by method, so a reloaded extension
  reuses the true predecessor instead of stacking wrappers.
- A wrapper that is no longer current forwards to the predecessor, so it cannot fold
  twice.
- `restore()` puts the original property descriptor back and is safe to call twice.
  `session_shutdown` restores, `session_start` reinstalls, so `/reload` and session
  switches stay consistent.

If the method is missing, or the node shapes no longer match, the wrapper quietly does
nothing and Pi's native rendering stays in place.

## Turn summary (M3)

Pi has no hook for inserting a transcript component, and reparenting the chat
container is fragile. Instead the extension appends a durable custom entry
(`pi.appendEntry("yancyui-turn", …)`) and renders it with the official
`registerEntryRenderer`. The entry is session data and never enters model context.

It finalises on `agent_settled` — which fires once per turn and carries `aborted` —
rather than `agent_end`, which fires once per agent loop and would let an auto-retry
or continuation append an early, wrong summary. `agent_end` only records the
outcome. `before_agent_start` resets per-turn state. Sub-agent tool events (those with
`parentToolCallId`) are ignored so a nested agent's tools do not appear in the parent
summary.

## Host compatibility shim

`host.ts` is the only module that decides whether a private or semi-private host API
exists. It imports the package as a namespace and exposes guarded accessors:

| Accessor | Host API | If missing |
|---|---|---|
| `hostKeyText` | `keyText` | hint falls back to a literal `ctrl+o` |
| `hostLanguageForPath` | `getLanguageFromPath` | preview renders unhighlighted |
| `hostHighlight` | `highlightCode` | preview falls back to `toolOutput` colour |
| `hostAgentDir` | `getAgentDir` | config falls back to `~/.pi/agent` |
| `hostAssistantMessagePrototype` | `AssistantMessageComponent` | thinking folding is skipped |

Each accessor validates the value before returning it and swallows errors, so a
renamed or removed export degrades one feature instead of breaking extension load.

Semi-public surfaces that are relied on but not shimmed (they are stable in practice,
and each is used defensively): `renderShell`, `context.lastComponent`, the renderer
context fields (`outputPad`, `durationMs`, `isError`, `executionStarted`, `state`),
`details.diff`, and `details.truncation.totalLines`.

## Performance

Collapsed rendering is constant-ish in output size, because the preview is sliced
before highlighting. Measured with `npm run bench`:

| Case | pi-yancy-ui collapsed | Pi native (expanded) |
|---|---|---|
| read, 50 lines | 0.10 ms | 0.04 ms |
| read, 500 lines | 0.10 ms | 0.24 ms |
| read, 2,000 lines | 0.14 ms | 0.89 ms |
| read, 10,000 lines | 0.39 ms | 4.39 ms |
| bash, 2,000 lines, streaming update | 0.002 ms | — |

Two optimisations keep it flat: `contentText`/`splitLines` run once per render (not
once per consumer), and `isPartial` short-circuits to a `running…` header before any
text processing, which matters while a shell streams.

The only case where collapsed costs more than native is a small `read`, because
native returns an empty string when collapsed while pi-yancy-ui renders a preview — at
0.14 ms for 2,000 lines.

## Testing

- `npm test` — 99 assertions across tool folding (including component recycling,
  every tool summary, error paths, partial results, compact single-line mode), thinking
  labels and timing, turn summary events and gating, config validation, and
  factory/command integration.
- `npm run smoke` — human-readable render dump for eyeballing changes.
- `npm run bench` — the table above.
- `npm run verify:host` — loads the extension through Pi's real bundled
  `virtualModules` map (not plain Node resolution) and asserts the host shim resolves
  `AssistantMessageComponent`, `getAgentDir`, `getLanguageFromPath`, and that the
  thinking patch installs.

The suite is mutation-tested: 10 of 11 deliberate regressions are caught. The one
survivor is the language-guard mutation, because `highlightCode` returns plain text in
a headless process, making highlighted and unhighlighted output identical; that path
is covered by `verify:host` instead.

## Distribution

The package is published to npm as `pi-yancy-ui`. The [Pi package
gallery](https://pi.dev/packages) indexes npm packages whose `keywords` contain
`pi-package` — there is no submission step, and git installs are never listed there.

- Host packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) live in
  `peerDependencies` with a `"*"` range, never in `dependencies`. Pi maps those modules
  itself; a bundled copy would bypass the mapping and create duplicate classes and
  registries.
- `files` ships `extensions/`, `docs/`, both READMEs, and the license. The test,
  smoke, benchmark, and host-verification scripts stay out of the tarball.
- Release flow: `npm version <patch|minor|major>` (which commits and tags), then
  `git push --follow-tags`, then `npm publish`. The gallery entry refreshes on its own.

## Known limitations

- **Flat rows, not one block per turn.** A true single collapsible block per turn
  would require reparenting Pi's chat container. The turn summary is the low-risk
  compromise.
- **Preview only, no custom expanded view.** Expanded rows hand off to the built-in
  renderer verbatim, so pi-yancy-ui never diverges from Pi's own output when open.
- **No package-name resolver for forks.** A Pi distribution published under a
  different package name needs a resolution shim.
