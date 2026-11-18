/**
 * `codex_delegate` — hand a self-contained task to the local Codex CLI
 * (`codex exec`) and return its final message. The child process is spawned
 * from the Host, so it runs with the Host's privileges and cwd, subject to
 * Codex's own sandbox policy; DSH's file sandbox does not wrap it.
 * @module @local/codex-delegate
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

/**
 * This bundle intentionally imports no `@deepseek-ai/*` packages: a workspace
 * directory bundle resolves modules from its own location, not from the dsh
 * installation. The tool definition below is a plain `ToolDefinition` object
 * (the same shape `defineTool` produces).
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'codex-delegate'

/** Services required by this plugin. */
export const inject = ['tools']

/** Default per-call timeout when config does not set one. */
const DEFAULT_TIMEOUT_MS = 600000

const EXEC_SUBCOMMAND = 'exec'

/** Windows executable extensions tried when the command has no extension. */
const WIN_EXTENSIONS = ['.cmd', '.exe', '.bat']

/**
 * Resolve the configured command against `PATH` so that npm shims like
 * `codex.cmd` work without a shell. Returns `{ file, args }` where `args`
 * replaces the requested argv: `.cmd`/`.bat` files run through
 * `cmd.exe /d /s /c`. The argv elements are passed unquoted — Node quotes
 * each element that contains spaces when building the command line, and
 * `cmd /s` then preserves those quotes for the shim's `%*`.
 */
function resolveCommand(command, args) {
  if (process.platform !== 'win32' || /\.[a-z]+$/i.test(command)) {
    return { file: command, args }
  }
  const pathExt = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
  const candidates = [...WIN_EXTENSIONS, ...pathExt.map(ext => ext.toLowerCase())]
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const ext of candidates) {
      const full = join(dir, command.toLowerCase().endsWith(ext) ? command : command + ext)
      if (existsSync(full)) {
        if (/\.(cmd|bat)$/i.test(full)) {
          return { file: 'cmd.exe', args: ['/d', '/s', '/c', full, ...args] }
        }
        return { file: full, args }
      }
    }
  }
  return { file: command, args }
}

/** Parse `--json` JSONL event stream output and return the last agent message, if any. */
function lastAgentMessageFromJsonl(stdout) {
  let last
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let event
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (event?.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
      last = event.item.text
    }
  }
  return last
}

/** Tail of a possibly long string, for error messages. */
function tail(text, maxChars) {
  const trimmed = text.trim()
  return trimmed.length <= maxChars ? trimmed : `…${trimmed.slice(-maxChars)}`
}

/** Run one `codex exec` invocation to completion. */
function runCodex(command, args, cwd, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const { file, args: argv } = resolveCommand(command, args)
    const child = spawn(file, argv, {
      cwd,
      windowsHide: true,
      env: { ...process.env },
      // A piped stdin makes codex read extra instructions from it and stall.
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', chunk => {
      stderr += chunk.toString()
    })
    const onAbort = () => {
      child.kill('SIGTERM')
      rejectPromise(signal.reason instanceof Error ? signal.reason : new Error('codex_delegate: aborted'))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    child.on('error', error => {
      signal.removeEventListener('abort', onAbort)
      rejectPromise(error)
    })
    child.on('close', code => {
      signal.removeEventListener('abort', onAbort)
      resolvePromise({ code, stdout, stderr })
    })
  })
}

/** Register the `codex_delegate` tool. */
export function apply(ctx, config) {
  const command = typeof config?.command === 'string' && config.command.trim() ? config.command.trim() : 'codex'
  const defaultTimeoutMs = typeof config?.defaultTimeoutMs === 'number' && config.defaultTimeoutMs > 0 ? config.defaultTimeoutMs : DEFAULT_TIMEOUT_MS
  const defaultCwd = typeof config?.defaultCwd === 'string' ? config.defaultCwd : ''
  const extraArgs = Array.isArray(config?.extraArgs) ? config.extraArgs.filter(arg => typeof arg === 'string') : []
  const model = typeof config?.model === 'string' ? config.model.trim() : ''
  const reasoningEffort = typeof config?.reasoningEffort === 'string' ? config.reasoningEffort.trim() : ''
  const sandbox = typeof config?.sandbox === 'string' ? config.sandbox.trim() : ''

  ctx.tools.register({
    name: 'codex_delegate',
    description: 'Delegate a self-contained coding task to the local Codex CLI (codex exec) and wait for its final report. Codex works in its own session with its own sandbox and approval policy; give it complete context in the prompt, including goals, relevant file paths, and constraints. Long tasks may take minutes.',
    parameters: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: {
          type: 'string',
          description: 'Complete, self-contained instructions for Codex, as you would write for a fresh agent without this conversation\'s context.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the Codex run. Defaults to the plugin-configured defaultCwd, or the Host process cwd when empty.',
        },
        timeoutMs: {
          type: 'number',
          description: `Per-call timeout in milliseconds. Defaults to ${defaultTimeoutMs}.`,
        },
        model: {
          type: 'string',
          description: `Model override passed as -m. Defaults to the plugin-configured model (${model || 'CLI default'}).`,
        },
        reasoningEffort: {
          type: 'string',
          enum: ['minimal', 'low', 'medium', 'high', 'xhigh'],
          description: `Reasoning effort override (passed as -c model_reasoning_effort=...). Defaults to the plugin-configured reasoningEffort (${reasoningEffort || 'CLI default'}).`,
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        required: ['text', 'exitCode'],
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: 'Codex\'s final message.' },
          exitCode: { type: 'number', description: 'Codex CLI process exit code.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }],
    },
    timeoutMs: defaultTimeoutMs,
    async execute(args, exec) {
      const prompt = typeof args?.prompt === 'string' ? args.prompt : ''
      if (!prompt.trim()) throw new Error('codex_delegate: prompt must be a non-empty string')
      const timeoutMs = typeof args?.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : defaultTimeoutMs
      const cwdArg = typeof args?.cwd === 'string' && args.cwd.trim() ? args.cwd : defaultCwd
      const cwd = cwdArg ? resolve(cwdArg) : undefined

      const outFile = join(tmpdir(), `dsh-codex-delegate-${randomUUID()}.txt`)
      const callModel = typeof args?.model === 'string' && args.model.trim() ? args.model.trim() : model
      const callEffort = typeof args?.reasoningEffort === 'string' && args.reasoningEffort.trim() ? args.reasoningEffort.trim() : reasoningEffort
      const cliArgs = [EXEC_SUBCOMMAND, '--skip-git-repo-check', '--ephemeral', '--json', '--output-last-message', outFile]
      if (callModel) cliArgs.push('-m', callModel)
      if (callEffort) cliArgs.push('-c', `model_reasoning_effort="${callEffort}"`)
      if (sandbox) cliArgs.push('-s', sandbox)
      cliArgs.push(...extraArgs)
      cliArgs.push('--', prompt)

      const controller = new AbortController()
      const timeout = setTimeout(() => {
        // runCodex rejects on abort; the CLI child is killed in onAbort.
        controller.abort(new Error(`codex_delegate: timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      const linkedSignal = exec.signal
      const onLinkedAbort = () => controller.abort(new Error('codex_delegate: aborted'))
      if (linkedSignal?.aborted) onLinkedAbort()
      else linkedSignal?.addEventListener('abort', onLinkedAbort, { once: true })

      try {
        const { code, stdout, stderr } = await runCodex(command, cliArgs, cwd, controller.signal)
        let text
        try {
          text = await readFile(outFile, 'utf8')
        } catch {
          text = undefined
        }
        if (!text?.trim()) {
          text = lastAgentMessageFromJsonl(stdout)
        }
        if (code !== 0) {
          const detail = tail(stderr || stdout || `exit code ${code}`, 2000)
          throw new Error(`codex_delegate: codex exited with code ${code}: ${detail}`)
        }
        if (text === undefined) {
          throw new Error(`codex_delegate: no final message produced; stderr: ${tail(stderr, 2000)}`)
        }
        return { text: text.trim(), exitCode: code ?? 0 }
      } finally {
        clearTimeout(timeout)
        linkedSignal?.removeEventListener('abort', onLinkedAbort)
        rm(outFile, { force: true }).catch(() => {})
      }
    },
  })
}
