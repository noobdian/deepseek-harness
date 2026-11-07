/** Opt-in subscription-backed test of the Web Host's model picker API and cold Session resume. */
import { cp, mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { chromium, type Browser } from 'playwright'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'
import { expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { launchWebScaffold, readPersistedEvents, type WebScaffold } from './scaffold.ts'

const bundle = fileURLToPath(new URL('../../../packages/subagent/subagent-codex/', import.meta.url))
const options = {
  extraInstallAnchors: [join(bundle, 'package.json')],
  extraOverlayPath: fileURLToPath(new URL('../../cli/config/examples/codex-session.yml', import.meta.url)),
}

it.skipIf(process.env.DSH_TEST_CODEX_SESSION !== '1')('selects two Codex models and resumes the same thread after a Web Host restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codex-roundtrip-'))
  const cwd = join(root, 'work')
  const marker = randomUUID()
  let app: WebScaffold | undefined
  let browser: Browser | undefined
  try {
    const accountHome = join(root, 'account')
    await mkdir(accountHome)
    await symlink(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'), join(accountHome, 'auth.json'))
    vi.stubEnv('CODEX_HOME', accountHome)
    await mkdir(cwd)
    app = await launchWebScaffold(options)
    const api = app.ctx.sessionController
    const defaults = app.ctx.agentDefaultModel.currentSelection()
    const native = await api.create({ cwd })

    const catalog = await api.modelCatalog()
    const group = catalog.groups.find(g => g.id === 'codex')
    expect(group, JSON.stringify(catalog.failures)).toBeDefined()
    const [a, b] = group!.models
    if (!a || !b) throw new Error('Two selectable models required')
    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    await page.goto(app.authenticatedUrl)
    await connectFreshWorkspace(page, cwd)
    const trigger = page.getByRole('button', { name: /^Select model/ })
    await trigger.click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    for (const model of group!.models) {
      await page.getByRole('menuitemradio', { name: model.name, exact: true }).waitFor()
    }
    await page.getByRole('menuitemradio', { name: a.name, exact: true }).click()
    await expect.poll(() => trigger.getAttribute('aria-label')).toContain(a.name)
    await trigger.click()
    await page.getByRole('menuitem', { name: /^Effort/ }).click()
    expect(await page.getByRole('menuitemradio').count()).toBeGreaterThanOrEqual(a.reasoning!.efforts.length)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    const selected = app.ctx.agents.list().find(agent => agent.model.current()?.provider === 'codex')
    if (!selected) throw new Error('Composer did not select Codex')
    const sessionId = selected.id
    const select = (model: typeof a) => api.selectModel({
      sessionId, provider: 'codex', model: model.id, reasoningEffort: model.reasoning!.defaultEffort!,
    })
    await expect(api.selectModel({ sessionId, provider: 'codex', model: a.id, reasoningEffort: 'invalid' })).rejects.toThrow()
    expect(app.ctx.agents.get(native.sessionId)!.model.current()).toMatchObject(defaults)
    expect(app.ctx.agentDefaultModel.currentSelection()).toEqual(defaults)

    async function prompt(host: WebScaffold, value: string) {
      await host.ctx.sessionController.prompt({
        sessionId, requestId: brandString<SessionRequestId>(randomUUID()),
        mode: 'queue', content: [{ type: 'text', text: value }],
      }, new AbortController().signal)
      const agent = host.ctx.agents.get(sessionId)!
      await agent.whenIdle()
      await host.ctx.sessions.flush(agent.session)
      const events = await readPersistedEvents(host, sessionId)
      const end = events.findLast(e => e.type === 'turn/end')
      expect(end?.data.reason).toEqual({ kind: 'completed' })
      const answer = events.findLast(e => e.type === 'assistant/message')
      expect(answer).toBeDefined()
      return { answer: answer!.data.message, binding: events.findLast(e => e.type === 'session/driver-bound')?.data }
    }
    const firstTurn = prompt(app, 'Remember the code ' + marker + '. Reply only OK. Do not use tools.')
    await expect.poll(() => selected.status).toBe('running')
    await select(b)
    const first = await firstTurn
    expect(first.answer.source).toMatchObject({ model: a.id })
    expect(first.binding?.threadId).toBeTruthy()
    await page.getByText('OK', { exact: true }).first().waitFor()
    const second = await prompt(app, 'Repeat only the earlier code. Do not use tools.')
    expect(second.answer.content).toContainEqual({ type: 'text', text: marker })
    expect(second.answer.source).toMatchObject({ model: b.id })
    expect(second.binding).toEqual(first.binding)
    await app.ctx.sessions.flush(app.ctx.sessions.get(sessionId)!)
    await cp(app.persistenceRoot, join(root, 'saved'), { recursive: true })
    await browser.close()
    browser = undefined
    await app.close()
    app = undefined
    app = await launchWebScaffold(options)
    await cp(join(root, 'saved'), app.persistenceRoot, { recursive: true })
    const resumed = await prompt(app, 'What code did I ask you to remember? Reply only with it, without tools.')
    expect(resumed.answer.content).toContainEqual({ type: 'text', text: marker })
    expect(resumed.binding).toEqual(first.binding)

    await app.close()
    app = undefined
    app = await launchWebScaffold()
    await cp(join(root, 'saved'), app.persistenceRoot, { recursive: true })
    const history = await readPersistedEvents(app, sessionId)
    expect(history.filter(event => event.type === 'assistant/message')).toHaveLength(2)
    await expect(app.ctx.sessionController.prompt({
      sessionId, requestId: brandString<SessionRequestId>(randomUUID()),
      mode: 'queue', content: [{ type: 'text', text: 'Continue' }],
    }, new AbortController().signal)).rejects.toThrow('Enable the Session runtime')
    expect((await readPersistedEvents(app, sessionId)).filter(event => event.type === 'turn/start')).toHaveLength(2)
  } finally {
    try {
      await browser?.close()
    } finally {
      try { await app?.close() } finally {
        vi.unstubAllEnvs()
        await rm(root, { recursive: true, force: true })
      }
    }
  }
})
