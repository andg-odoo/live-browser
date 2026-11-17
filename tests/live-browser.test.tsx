import type { PromptAutocompleteInput, PromptAutocompleteResult } from 'claude-code'
import { expect, test } from 'claude-code/testing'

declare const setTimeout: (fn: () => void, ms: number) => void

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const TARGET = { env: 'ecwth20', root: '/w/ecwth20', url: 'http://localhost:8902', port: 8902, db: 'oes_ecwth20', sock_dir: '/run/x' }
type Autocomplete = (e: PromptAutocompleteInput) => Promise<PromptAutocompleteResult>
// The kit's $ does not type prompt.autocomplete, which only the engine raises
const autocomplete = ($: unknown) => ($ as { prompt: { autocomplete: Autocomplete } }).prompt.autocomplete
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const PANE = {
  plugin: 'live-browser',
  component: 'Pane',
  requestId: 'live-browser',
  surface: 'terminal',
  props: {
    title: 'Live browser',
    isFocused: false,
    bodyColumns: 120,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('the pane says how to start before any run', async ($, on) => {
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /not running/ }))?.text).toContain('/live-browser')
  await ui.unmount()
})

test('a target error is shown and no browser is spawned', async ($, on) => {
  let spawned = 0
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 2, stdout: '{"error": "no Odoo answering on :8924 (kueski)"}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', () => ({ value: undefined }))
  on('process.spawn', async function* () {
    spawned += 1
    return { value: { code: 0, signal: null } }
  })
  await $.command.run({ command: 'live-browser', args: '@kueski' } as never)
  await sleep(50)
  expect(spawned).toBe(0)
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /no Odoo answering/ }))?.text).toContain(':8924')
  await ui.unmount()
})

test('status and FRAME lines split across pieces drive the pane, env var and the run', async ($, on) => {
  const blits: string[] = []
  const env: (string | undefined)[] = []
  const fetches: { url: string; socketPath?: string; body?: unknown }[] = []
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('env.get', () => ({ value: env.at(-1) }))
  on('env.set', (_, e) => {
    env.push(e.value)
    return { value: {} }
  })
  on('http.fetch', (_, e) => {
    fetches.push({ url: e.url, socketPath: e.init?.socketPath, body: e.init?.body })
    return { value: { status: 200, ok: true, headers: {}, text: '{"ok": true, "printed": ["/tmp/odoo-live/a.png"]}' } }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(TARGET), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.blit', (_, e) => {
    blits.push('source' in e && 'png' in e.source ? e.source.png : '')
    return { value: {} }
  })
  on('process.spawn', async function* () {
    yield { stream: 'stderr' as const, text: 'TARGET ecwth20 · oes_ecwth20 · :8902\nREA' }
    yield { stream: 'stderr' as const, text: 'DY /run/x/s1.sock\nPAGE http://localhost:8902/odoo/account.move/4170\n' }
    yield { stream: 'stdout' as const, text: `FRAME ${PNG.slice(0, 9)}` }
    yield { stream: 'stdout' as const, text: `${PNG.slice(9)}\nFRAME not-a-png\nFRAME ${PNG}\n` }
    yield { stream: 'stderr' as const, text: 'STEP click Pay (shoot)\n' }
    await sleep(300)
    return { value: { code: 0, signal: null } }
  })
  await $.command.run({ command: 'live-browser', args: '@ecwth20 open account.move 4170; click Pay' } as never)
  await sleep(100)
  expect(blits.at(-1)).toBe(PNG)
  expect(env.at(-1)).toMatch(/^\/run\/x\/s.+\.sock$/)
  const run = fetches.find(one => one.url === 'http://live/run')
  expect(run?.socketPath).toBe(env.at(-1))
  expect(JSON.parse(String(run?.body)).steps).toEqual(['open account.move 4170', 'click Pay'])
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /ecwth20 · oes_ecwth20/ }))?.text).toContain(':8902 · /odoo/account.move/4170')
  expect((await ui.find({ type: 'Text', text: /fps/ }))?.text).toMatch(/click Pay \(shoot\) · \d+ fps · 0 KiB\/frame · 0 denied/)
  await ui.unmount()
  await sleep(300)
  expect(env.at(-1)).toBe(undefined)
})

test('list shows the running servers without starting a browser', async ($, on) => {
  let spawned = 0
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ running: [{ env: 'ecwth20', db: 'oes_ecwth20', port: 8902, root: '/w' }], envs: [] }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', () => ({ value: undefined }))
  on('process.spawn', async function* () {
    spawned += 1
    return { value: { code: 0, signal: null } }
  })
  const result = await $.command.run({ command: 'live-browser', args: 'list' } as never)
  expect(JSON.stringify(result)).toContain('ecwth20 · oes_ecwth20 · :8902')
  expect(spawned).toBe(0)
})

test('autocomplete suggests list, cached slugs and step verbs for /live-browser only', async ($, on) => {
  const running = [{ env: 'ecwth20', db: 'oes_ecwth20', port: 8902, root: '/w' }, { env: 'src', db: 'oes_src', port: 8869, root: '/s' }]
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ running, envs: [] }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', () => ({ value: undefined }))
  on('prompt.autocomplete', () => ({ suggestions: [] }))
  await $.command.run({ command: 'live-browser', args: 'list' } as never)
  const ask = async (text: string) => {
    const start = text.search(/\S*$/)
    const result = await autocomplete($)({ text, cursor: text.length, token: text.slice(start), start })
    return result.suggestions.map(row => row.text)
  }
  expect(await ask('/live-browser l')).toEqual(['list'])
  expect(await ask('/live-browser e')).toEqual(['ecwth20', 'expect'])
  expect(await ask('/live-browser @')).toEqual(['@ecwth20', '@src'])
  expect(await ask('/live-browser @ecwth20 cl')).toEqual(['click'])
  expect(await ask('/live-browser ecwth20 cl')).toEqual(['click'])
  expect(await ask('/live-browser open account.move 4170;cl')).toEqual(['4170;click'])
  expect(await ask('/live-browser open account.move 4170; ch')).toEqual(['check'])
  expect(await ask('/live-browser open sh')).toEqual([])
  expect(await ask('/other l')).toEqual([])
  expect(await ask('hello @')).toEqual([])
})

test('the step field filters verbs then live page targets, completes and posts the step', async ($, on) => {
  const HINTS = { dialog: 'Pay', click: ['Pay', 'Credit Note', 'Withhold Only'], fields: ['Memo'], dropdowns: ['Journal'], checks: [], page: '/odoo/account.move/4170' }
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.after', async (_, e) => {
    await sleep(e.ms)
    return { value: undefined }
  })
  on('env.get', () => ({ value: undefined }))
  on('env.set', () => ({ value: {} }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(TARGET), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('http.fetch', (_, e) => {
    const text = e.url.endsWith('/hints') ? JSON.stringify(HINTS)
      : e.url.endsWith('/options') ? JSON.stringify({ ok: true, field: 'Journal', options: ['Bank', 'Cash'] }) : '{"ok": true}'
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  on('process.spawn', async function* () {
    yield { stream: 'stderr' as const, text: 'READY /run/x/s1.sock\nSTEP open account.move 4170 (shoot)\n' }
    yield { stream: 'stderr' as const, text: 'PAGE http://localhost:8902/odoo/account.move/4170\n' }
    await sleep(200)
    return { value: { code: 0, signal: null } }
  })
  await $.command.run({ command: 'live-browser', args: '' } as never)
  await sleep(500)
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /ecwth20 · oes_ecwth20/ }))?.text).toContain(':8902 · /odoo/account.move/4170')
  const client = await ui.find({ type: 'Client' })
  const { maxRows, ...given } = client?.props.props as { maxRows: number }
  expect(maxRows).toBeGreaterThan(3)
  expect(given).toEqual({ hints: { click: HINTS.click, kinds: Object.fromEntries(HINTS.click.map(label => [label, ''])), fields: HINTS.fields, dropdowns: HINTS.dropdowns, checks: [], page: HINTS.page }, history: ['open account.move 4170'], records: ['account.move 4170'], options: { field: '', list: [] } })
  const shown = async () => (await ui.findAll({ type: 'Text', in: 'steps' })).map(found => found.text).join('|')
  const type = async (text: string) => {
    for (const key of text) {
      await ui.key({ key, in: 'steps' })
    }
  }
  await type('c')
  expect(await shown()).toMatch(/click LABEL.*check LABEL/)
  expect(await shown()).not.toContain('open MODEL')
  await type('lick ')
  expect(await shown()).toMatch(/Pay.*Credit Note.*Withhold Only/)
  await type('w')
  expect(await shown()).not.toContain('Credit Note')
  await ui.key({ key: 'backspace', in: 'steps' })
  await type('p')
  await ui.key({ key: 'return', in: 'steps' })
  expect(await shown()).toContain('› click Pay')
  await ui.key({ key: 'return', in: 'steps' })
  expect((await ui.find({ type: 'Text', text: /live browser ended/ }))?.text).toContain('run /live-browser again')
  expect(await shown()).not.toContain('click Pay')
  await type('fill m')
  await ui.key({ key: 'tab', in: 'steps' })
  expect(await shown()).toContain('› fill Memo=')
  await ui.key({ key: 'u', ctrl: true, in: 'steps' })
  await ui.key({ key: 'down', in: 'steps' })
  await ui.key({ key: 'up', in: 'steps' })
  expect(await shown()).not.toContain('› open account.move 4170')
  await ui.key({ key: 'up', in: 'steps' })
  expect(await shown()).toContain('› open account.move 4170')
  await type('x')
  await ui.key({ key: 'u', ctrl: true, in: 'steps' })
  await type('open ')
  expect(await shown()).toMatch(/account\.move 4170\|record/)
  await ui.key({ key: 'u', ctrl: true, in: 'steps' })
  await type('select m')
  expect(await shown()).not.toContain('Memo')
  await ui.key({ key: 'u', ctrl: true, in: 'steps' })
  await type('select j')
  await ui.key({ key: 'tab', in: 'steps' })
  await sleep(100)
  expect(await shown()).toMatch(/› select Journal=.*Bank\|option.*Cash\|option/)
  await type('c')
  expect(await shown()).not.toContain('Bank')
  await ui.key({ key: 'tab', in: 'steps' })
  expect(await shown()).toContain('› select Journal=Cash')
  await ui.unmount()
})
