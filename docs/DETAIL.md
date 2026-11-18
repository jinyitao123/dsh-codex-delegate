# Codex delegate

Registers one tool, `codex_delegate`, that hands a self-contained coding task to the local
Codex CLI (`codex exec`) and waits for its final report.

## Usage

Call `codex_delegate` with a complete, self-contained `prompt` — Codex runs in its own
session and cannot see this conversation. Include goals, relevant file paths, and
constraints in the prompt. Optional parameters:

- `cwd`: working directory for the Codex run (defaults to the configured `defaultCwd`,
  or the Host process cwd when both are empty).
- `timeoutMs`: per-call timeout (defaults to the configured `defaultTimeoutMs`, 10 min).
- `model`: per-call model override, passed as `-m` (defaults to the configured
  `model`, or the CLI's configured model when empty).
- `reasoningEffort`: per-call reasoning effort (`minimal`, `low`, `medium`,
  `high`, `xhigh`), passed as `-c model_reasoning_effort=...` (defaults to the
  configured `reasoningEffort`, or the CLI's configured effort when empty).

The tool returns Codex's final message plus the CLI exit code. The CLI also streams its
session to its own log; this tool only returns the final report.

## Configuration

Defaults shown; all fields are optional:

```yaml
config:
  command: codex            # CLI command or absolute path
  defaultTimeoutMs: 600000  # 10 minutes
  defaultCwd: ''            # empty = inherit the Host cwd
  extraArgs: []             # extra flags appended to every `codex exec`
  model: ''                 # passed as -m when non-empty
  reasoningEffort: ''       # minimal/low/medium/high/xhigh; -c model_reasoning_effort=... when non-empty
  sandbox: ''               # passed as -s when non-empty
```

## Limitations

- The Codex child process is spawned from the Host and runs with the Host's privileges;
  DSH's file sandbox does not wrap it. Codex applies its own sandbox/approval policy.
- Long tasks block the calling agent's step until the CLI exits, times out, or is aborted.
- On Windows, `command` is resolved against `PATH`; `.cmd`/`.bat` shims run via
  `cmd.exe`.
