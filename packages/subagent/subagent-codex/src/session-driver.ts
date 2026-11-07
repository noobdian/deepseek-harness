/** Persistent Codex conversations accessed through a short-lived stdio connection per turn. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ModelSelection, SessionDriver, SessionDriverModel } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { codexAppServerArgv } from './run.ts'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Codex protocol object')
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Invalid Codex protocol string')
  return value
}

/** Account catalog and read-only text conversation runtime for DSH Sessions. */
export class CodexSessionDriver extends Service implements SessionDriver {
  static inject = ['agents', 'sessions', 'subprocess']

  readonly provider = 'codex'
  readonly displayName = 'Codex'
  private readonly stopped = new AbortController()

  constructor(ctx: Context, private readonly graceMs: number) {
    super(ctx, 'sessionDriver')
    ctx.effect(() => () => this.stopped.abort())
  }

  private async connected<T>(cwd: string, signal: AbortSignal, action: (wire: JsonRpcLineTransport) => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    const child = this.ctx.subprocess.spawn({
      argv: codexAppServerArgv(), cwd, signal, graceMs: this.graceMs,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    })
    try {
      child.stderr?.resume()
      if (!child.stdout || !child.stdin) throw new Error('Codex stdio unavailable')
      const wire = new JsonRpcLineTransport(child.stdout, child.stdin)
      try {
        wire.start()
        await wire.request('initialize', { clientInfo: { name: 'dsh_session', version: '1' }, capabilities: {} }, signal)
        wire.notify('initialized')
        const account = record(await wire.request('account/read', { refreshToken: false }, signal)).account
        if (!account || record(account).type !== 'chatgpt') throw new Error('Sign in to Codex with ChatGPT to use this Session runtime.')
        return await Promise.race([
          action(wire),
          child.done.then(() => { throw new Error('Codex closed before completing the request') }),
        ])
      } finally { wire.close() }
    } finally {
      child.terminate()
      await child.waitForExit()
    }
  }

  async listModels(): Promise<SessionDriverModel[]> {
    return this.connected(process.cwd(), this.stopped.signal, async (wire) => {
      const models: SessionDriverModel[] = []
      const seen = new Set<string>()
      let cursor: string | undefined
      do {
        const page = record(await wire.request('model/list', { includeHidden: false, cursor }))
        if (!Array.isArray(page.data)) throw new Error('Invalid Codex model list')
        for (const entry of page.data) {
          const m = record(entry)
          if (!Array.isArray(m.supportedReasoningEfforts)) throw new Error('Invalid Codex reasoning efforts')
          models.push({
            id: text(m.model), name: text(m.displayName),
            reasoning: {
              defaultEffort: text(m.defaultReasoningEffort),
              efforts: m.supportedReasoningEfforts.map((value) => {
                const id = text(record(value).reasoningEffort)
                return { id, name: id }
              }),
            },
          })
        }
        cursor = page.nextCursor == null ? undefined : text(page.nextCursor)
        if (cursor && seen.has(cursor)) throw new Error('Repeated Codex model catalog cursor')
        if (cursor) seen.add(cursor)
      } while (cursor)
      return models
    })
  }

  async run(session: Session, selection: ModelSelection, input: string[], signal: AbortSignal): Promise<string> {
    signal = AbortSignal.any([signal, this.stopped.signal])
    const cwd = session.header.cwd
    if (!cwd) throw new Error('Codex requires a workspace directory')
    return this.connected(cwd, signal, async (wire) => {
      const bound = this.ctx.agents.driverBinding(session)
      const permissions = { cwd, sandbox: 'read-only', approvalPolicy: 'never' }
      const opened = bound?.threadId
        ? await wire.request('thread/resume', { ...permissions, threadId: bound.threadId }, signal)
        : await wire.request('thread/start', { ...permissions, ephemeral: false, model: selection.model }, signal)
      const threadId = text(record(record(opened).thread).id)
      if (bound?.threadId && bound.threadId !== threadId) throw new Error('Codex resumed a different conversation')
      if (!bound?.threadId) session.append('session/driver-bound', { provider: this.provider, threadId })
      if (!await this.ctx.sessions.flush(session)) throw new Error('Cannot persist Codex conversation binding')
      const finished = Promise.withResolvers<Record<string, unknown>>()
      // A notification can precede the turn/start response.
      void finished.promise.catch(() => {})
      const answers = new Map<string, string>()
      wire.onNotification((method, params) => {
        if (params.threadId !== threadId) return
        try {
          if (method === 'item/completed') {
            const item = record(params.item)
            if (item.type === 'agentMessage' && (item.phase === 'final_answer' || item.phase == null)) {
              answers.set(text(params.turnId), text(item.text))
            }
          }
          if (method === 'turn/completed') finished.resolve(record(params.turn))
        } catch (error) {
          finished.reject(error)
        }
      })
      const effort = selection.reasoningEffort
        ?? (await this.listModels()).find(model => model.id === selection.model)?.reasoning.defaultEffort
      if (!effort) throw new Error('Selected Codex model has no available default reasoning effort')
      const response = await wire.request('turn/start', {
        threadId, model: selection.model,
        effort,
        input: input.map(value => ({ type: 'text', text: value, text_elements: [] })),
      }, signal)
      const turnId = text(record(record(response).turn).id)
      const terminal = await finished.promise
      if (terminal.id !== turnId || terminal.status !== 'completed') throw new Error('Codex did not complete the requested turn')
      return text(answers.get(turnId))
    })
  }
}
