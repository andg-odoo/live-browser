import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'

const PANE = 'live-browser'
const KEY = 'view'
const STEPS_KEY = 'steps'
const LIVE = ['uv', 'run', '-q', '--no-config', '--no-project', '--with', 'playwright', 'python', '-I']
const OUT = '/tmp/odoo-live'
const ASPECT = 600 / 960
const COMMAND = '/live-browser '
const VERBS = ['goto', 'open', 'click', 'fill', 'select', 'check', 'uncheck', 'expect', 'wait', 'shot']

type Target = { env: string; root: string; url: string; port: number; db: string; sock_dir: string }
type Server = { env: string; db: string; port: number; root: string }
type Hints = { click: string[]; kinds: Record<string, string>; fields: string[]; dropdowns: string[]; checks: string[]; page: string }
type RunResult = { ok?: boolean; error?: string; step?: string; printed?: string[]; failure?: { lines: string[] } }

type Run = {
  target: Target | undefined
  sock: string
  child: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | undefined
  isReady: boolean
  wasReady: boolean
  isEnded: boolean
  page: string
  status: string
  error: string
  received: number
  denied: number
  lastDeny: string
  bytes: number
  latest: string
  pending: string | undefined
  isBlitting: boolean
  windowFrames: number
  fps: number
  hints: Hints
  history: string[]
  hintsTimer: { cancel: () => void } | undefined
  options: { field: string; list: string[]; error?: string }
}

const fresh = (): Run => ({
  target: undefined, sock: '', child: undefined, isReady: false, wasReady: false, isEnded: false, page: '', status: 'resolving the target…',
  error: '', received: 0, denied: 0, lastDeny: '', bytes: 0, latest: '', pending: undefined, isBlitting: false,
  windowFrames: 0, fps: 0, hints: { click: [], kinds: {}, fields: [], dropdowns: [], checks: [], page: '' }, history: [], hintsTimer: undefined, options: { field: '', list: [] },
})

let run: Run | undefined
let ticker: { cancel: () => void } | undefined
let servers: Server[] = []
let refresher: { cancel: () => void } | undefined

const pathOf = (url: string) => url.replace(/^https?:\/\/[^/]+/, '') || '/'

function records(own: Run): string[] {
  const current = own.hints.page.match(/\/([a-z_]+(?:\.[a-z_]+)+)\/(\d+)(?:[/?]|$)/)
  const opened = own.history.filter(step => step.startsWith('open ')).map(step => step.slice(5))
  return [...new Set([...(current ? [`${current[1]} ${current[2]}`] : []), ...opened])].slice(0, 8)
}

function remember(own: Run, steps: string[]) {
  own.history = [...new Set([...[...steps].reverse(), ...own.history])].slice(0, 6)
}

function scheduleHints($: EngineInterface, own: Run) {
  own.hintsTimer?.cancel()
  own.hintsTimer = $.clock.after(300, () => void fetchHints($, own))
}

async function fetchHints($: EngineInterface, own: Run) {
  const response = await $.http.fetch('http://live/hints', { socketPath: own.sock }).catch(() => undefined)
  if (!response?.ok) {
    return
  }
  try {
    const hints = JSON.parse(response.text) as Hints
    const cap = (list: unknown) => (Array.isArray(list) ? list.filter(item => typeof item === 'string').slice(0, 50).map(item => item.slice(0, 80)) : [])
    const click = cap(hints.click)
    const kinds = Object.fromEntries(click.map(label => [label, String(hints.kinds?.[label] ?? '').slice(0, 20)]))
    own.hints = { click, kinds, fields: cap(hints.fields), dropdowns: cap(hints.dropdowns), checks: cap(hints.checks), page: String(hints.page ?? '').slice(0, 500) }
  } catch {
    return
  }
  redraw($)
}

const splitSteps = (text: string) => text.split(/[;\n]/).map(step => step.trim()).filter(Boolean)
const slugOf = (word: string) => word.startsWith('@') || (/^[\w.-]+$/.test(word) && word !== 'list' && !VERBS.includes(word))
  ? word.replace(/^@/, '')
  : undefined

function parseArgs(args: string): { isList: boolean; slug: string | undefined; steps: string[] } {
  const rest = args.trim()
  if (rest === 'list') {
    return { isList: true, slug: undefined, steps: [] }
  }
  const first = rest.split(/\s+/, 1)[0] ?? ''
  const slug = slugOf(first)
  return { isList: false, slug: slug && `@${slug}`, steps: splitSteps(slug ? rest.slice(first.length) : rest) }
}

function lines(buffer: string, text: string): [string[], string] {
  const parts = (buffer + text).split('\n')
  return [parts.slice(0, -1), parts.at(-1) ?? '']
}

function redraw($: EngineInterface) {
  $.ui.invalidate('ui.render')
}

async function clearSocket($: EngineInterface, own: Run) {
  if (own.sock && (await $.env.get('ODOO_LIVE_SOCKET')) === own.sock) {
    await $.env.set('ODOO_LIVE_SOCKET', undefined)
  }
}

async function stop($: EngineInterface) {
  const own = run
  run = undefined
  ticker?.cancel()
  ticker = undefined
  if (!own) {
    return
  }
  own.hintsTimer?.cancel()
  if (own.child && own.isReady) {
    await $.http.fetch('http://live/stop', { method: 'POST', socketPath: own.sock }).catch(() => undefined)
  }
  void own.child?.return(undefined as never)
  own.child = undefined
  await clearSocket($, own)
}

async function pump($: EngineInterface, own: Run) {
  if (own.isBlitting || own.pending === undefined) {
    return
  }
  own.isBlitting = true
  const png = own.pending
  own.pending = undefined
  const result = await $.ui.blit({ requestId: PANE, key: KEY, source: { png } }).catch((error: unknown) => ({ deny: String(error) }))
  if (result.deny) {
    own.denied += 1
    own.lastDeny = result.deny
  } else {
    own.windowFrames += 1
  }
  own.isBlitting = false
  void pump($, own)
}

function onFrame($: EngineInterface, own: Run, png: string) {
  own.received += 1
  own.bytes = Math.floor((png.length * 3) / 4)
  const isFirst = !own.latest
  own.latest = png
  if (isFirst) {
    redraw($)
    return
  }
  own.pending = png
  void pump($, own)
}

async function onStatus($: EngineInterface, own: Run, line: string, steps: string[]) {
  const [kind = '', ...words] = line.split(' ')
  const text = words.join(' ')
  if (kind === 'READY') {
    own.isReady = true
    own.wasReady = true
    own.status = 'ready · shoot in this session attaches here'
    if (run === own) {
      await $.env.set('ODOO_LIVE_SOCKET', own.sock)
    }
    if (steps.length) {
      void send($, own, steps, true)
    }
    scheduleHints($, own)
  } else if (kind === 'PAGE') {
    own.page = text
    own.options = { field: '', list: [] }
    scheduleHints($, own)
  } else if (kind === 'HINTS') {
    scheduleHints($, own)
  } else if (kind === 'STEP') {
    own.status = `▶ ${text}`
    own.error = ''
    remember(own, [text.replace(/ \([\w-]+\)$/, '')])
  } else if (kind === 'DONE') {
    own.status = `done: ${text}`
    scheduleHints($, own)
  } else if (kind === 'FAILED' || kind === 'ERROR') {
    own.error = text
  } else if (kind !== 'TARGET' && kind !== 'ENDED' && line.trim()) {
    own.error = line.trim().slice(0, 300)
  }
  redraw($)
}

async function send($: EngineInterface, own: Run, steps: string[], reset: boolean) {
  if (!own.isReady) {
    own.error = own.isEnded ? 'the live browser ended: run /live-browser again' : 'the browser is not ready yet'
    redraw($)
    return
  }
  own.error = ''
  remember(own, steps)
  const body = JSON.stringify({ steps, out: OUT, reset, client: 'pane' })
  const init = { method: 'POST', socketPath: own.sock, body, headers: { 'Content-Type': 'application/json' } }
  const response = await $.http.fetch('http://live/run', init)
    .catch((error: unknown) => ({ status: 0, text: JSON.stringify({ error: String(error) }) }))
  let result: RunResult = {}
  try {
    result = JSON.parse(response.text) as RunResult
  } catch {
    result = { error: response.text.slice(0, 200) }
  }
  if (response.status === 409) {
    own.error = `busy: ${result.step ?? 'another run'}`
  } else if (result.ok) {
    own.status = `pane run ok${result.printed?.length ? ` · ${result.printed.join(' ')}` : ''}`
  } else {
    own.error = result.failure ? result.failure.lines.map(text => text.trim()).join(' · ') : result.error ?? 'run failed'
  }
  redraw($)
}

async function readOptions($: EngineInterface, own: Run, field: string) {
  const init = { method: 'POST', socketPath: own.sock, body: JSON.stringify({ field }), headers: { 'Content-Type': 'application/json' } }
  const response = await $.http.fetch('http://live/options', init).catch(() => undefined)
  let body: { options?: unknown; error?: unknown } = {}
  try {
    body = JSON.parse(response?.text ?? '{}') as typeof body
  } catch {
    body = { error: 'unreadable answer' }
  }
  const list = Array.isArray(body.options) ? body.options.filter(item => typeof item === 'string').slice(0, 40).map(item => item.slice(0, 80)) : []
  const error = response?.status === 409 ? 'the browser is busy' : typeof body.error === 'string' ? body.error.slice(0, 120) : undefined
  own.options = { field, list, ...(error ? { error } : {}) }
  redraw($)
}

let shotsDir: string | undefined

// odoo-shots checkout: $ODOO_SHOTS, else ~/Dev/scratch/odoo-shots
async function shots($: EngineInterface) {
  shotsDir ??= (await $.env.get('ODOO_SHOTS')) ?? `${(await $.env.get('HOME')) ?? ''}/Dev/scratch/odoo-shots`
  return shotsDir
}

async function target($: EngineInterface, args: string[]) {
  return $.process.run(['python3', '-I', `${await shots($)}/target.py`, ...args])
}

async function resolveTarget($: EngineInterface, slug: string | undefined): Promise<Target | string> {
  const result = await target($, ['--json', ...(slug ? [slug] : [])])
    .catch((error: unknown) => ({ stdout: '', stderr: String(error) }))
  try {
    const parsed = JSON.parse(result.stdout) as Target | { error: string }
    return 'error' in parsed ? parsed.error : parsed
  } catch {
    return (result.stderr || result.stdout || 'target.py failed').trim()
  }
}

async function start($: EngineInterface, slug: string | undefined, steps: string[]) {
  await stop($)
  void refresh($)
  const own = fresh()
  run = own
  redraw($)
  const found = await resolveTarget($, slug)
  if (run !== own) {
    return
  }
  if (typeof found === 'string') {
    own.error = found
    own.status = 'no browser started'
    own.isEnded = true
    redraw($)
    return
  }
  own.target = found
  own.sock = `${found.sock_dir}/s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.sock`
  own.status = 'starting Chrome…'
  const child = $.process.spawn({ argv: [...LIVE, `${await shots($)}/live.py`, 'serve', '--url', found.url, '--db', found.db, '--sock', own.sock] })
  own.child = child
  ticker = $.clock.every(1000, () => {
    own.fps = own.windowFrames
    own.windowFrames = 0
    redraw($)
  })
  let stdout = ''
  let stderr = ''
  try {
    for await (const { stream, text } of child) {
      if (stream === 'stderr') {
        const [done, rest] = lines(stderr, text)
        stderr = rest
        for (const line of done) {
          await onStatus($, own, line, steps)
        }
        continue
      }
      const [done, rest] = lines(stdout, text)
      stdout = rest
      for (const line of done) {
        if (line.startsWith('FRAME iVBORw0KGgo')) {
          onFrame($, own, line.slice(6))
        }
      }
    }
    const end = await child.result.catch(() => undefined)
    own.status = `ended: code ${end?.code ?? '?'}${end?.signal ? ` signal ${end.signal}` : ''}`
  } catch (error) {
    own.status = `ended: ${String(error).slice(0, 200)}`
  }
  own.isEnded = true
  own.isReady = false
  await clearSocket($, own)
  redraw($)
}

async function refresh($: EngineInterface): Promise<Server[] | string> {
  const result = await target($, ['--list', '--json']).catch(() => undefined)
  try {
    servers = (JSON.parse(result?.stdout ?? '') as { running: Server[] }).running
    return servers
  } catch {
    return `target.py --list failed: ${result?.stderr ?? ''}`.trim()
  }
}

function suggest(text: string, start: number, token: string) {
  const before = text.slice(COMMAND.length, start)
  const isFirst = !before.trim()
  const at = token.startsWith('@') ? '@' : ''
  const slugs = servers.map(server => ({ text: `${at}${server.env}`, description: `${server.db} · :${server.port}` }))
  if (at) {
    return isFirst ? slugs.filter(row => row.text.startsWith(token)) : []
  }
  const cut = token.lastIndexOf(';') + 1
  const [head, partial] = [token.slice(0, cut), token.slice(cut)]
  const firstWord = before.trim().split(/\s+/, 1)[0] ?? ''
  const afterSlug = slugOf(firstWord) ? before.trim().slice(firstWord.length) : before
  const isStepStart = cut > 0 || !afterSlug.trim() || before.trim().endsWith(';')
  const verbs = isStepStart && partial
    ? VERBS.filter(verb => verb.startsWith(partial)).map(verb => ({ text: `${head}${verb}`, description: 'shoot step' }))
    : []
  const first = isFirst ? [{ text: 'list', description: 'running Odoo servers' }, ...slugs].filter(row => row.text.startsWith(token)) : []
  return [...first, ...verbs]
}

async function list($: EngineInterface): Promise<string> {
  const running = await refresh($)
  if (typeof running === 'string') {
    return running
  }
  const mine = run?.target && !run.isEnded ? run.target : undefined
  const rows = running.map(server => {
    const isMine = mine?.port === server.port
    return `${isMine ? '▶' : ' '} ${server.env} · ${server.db} · :${server.port}${isMine ? "  (this session's browser)" : ''}`
  })
  const head = running.length ? 'Running Odoo servers:' : 'No Odoo server is running.'
  const tail = mine ? '' : '\nThis session has no live browser: /live-browser [env]'
  return [head, ...rows].join('\n') + tail
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'live-browser',
      description: "This session's live Odoo browser in a pane; args: [env] [';'-separated shoot steps] | list",
      argumentHint: '[list | env] [steps…]',
    })
    await $.env.set('ODOO_LIVE_SOCKET', undefined)
    void refresh($)
    refresher?.cancel()
    refresher = $.clock.every(30000, () => void refresh($))
    return next(e)
  })

  on('prompt.autocomplete', async ($, e, next) => {
    if (!e.text.startsWith(COMMAND) || e.start < COMMAND.length) {
      return next(e)
    }
    const rows = suggest(e.text, e.start, e.token)
    const result = await next(e)
    return rows.length ? { suggestions: [...result.suggestions, ...rows] } : result
  })

  on('command.run', { command: 'live-browser' }, async ($, e) => {
    const parsed = parseArgs(e.args)
    if (parsed.isList) {
      return { text: await list($) }
    }
    const opened = await $.ui.open({ id: PANE, title: 'Live browser' })
    void start($, parsed.slug, parsed.steps)
    return { text: opened.isPlaced ? 'Live browser pane opened.' : `Live browser pane waiting: ${opened.reason ?? ''}` }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      await stop($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.message', { requestId: PANE, element: STEPS_KEY }, async ($, e, next) => {
    const own = run
    const data = e.data as { run?: unknown; options?: unknown }
    if (own && typeof data.run === 'string' && data.run.trim()) {
      void send($, own, splitSteps(data.run), false)
    }
    if (own?.sock && typeof data.options === 'string' && data.options.trim()) {
      void readOptions($, own, data.options.trim().slice(0, 80))
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal') {
      return next(e)
    }
    const { Box, Text, Image, Client } = $.ui.resolve(e)
    const own = run
    const [errorHead = '', ...errorRest] = (own?.error ?? '').split('\n')
    const body = e.props.scroll.bodyRows
    const head = errorHead ? 3 : 2
    const controls = own?.wasReady ? 2 : 0
    let columns = Math.max(20, Math.min(e.props.bodyColumns, 200))
    let rows = Math.round(columns * ASPECT / 2)
    let listRows = own?.wasReady ? Math.min(14, Math.max(4, body - head - controls - rows)) : 0
    if (body - head - controls - listRows < rows) {
      rows = Math.max(4, body - head - controls - listRows)
      columns = Math.max(20, Math.min(columns, Math.round(rows * 2 / ASPECT)))
      listRows = own?.wasReady ? Math.max(1, Math.min(listRows, body - head - controls - rows)) : 0
    }
    const where = own?.target
      ? `${own.target.env} · ${own.target.db} · :${own.target.port} · ${own.page ? pathOf(own.page) : '…'}`
      : own ? 'resolving the target…' : 'not running: /live-browser [env] [steps]'
    const kb = own ? Math.round(own.bytes / 1024) : 0
    const stats = own?.received ? ` · ${own.fps} fps · ${kb} KiB/frame · ${own.denied} denied` : ''
    return (
      <Box flexDirection="column" height={e.props.scroll.bodyRows}>
        <Text bold wrap="truncate-end">{where}</Text>
        <Text dimColor wrap="truncate-end">{own ? `${own.status}${stats}` : ''}{own?.lastDeny ? ` · deny: ${own.lastDeny}` : ''}</Text>
        {errorHead ? <Text color="red" wrap="truncate-end">{errorHead}</Text> : null}
        {own?.wasReady
          ? <Client key={STEPS_KEY} module="./steps.tsx" props={{ hints: own.hints, history: own.history, records: records(own), options: own.options, maxRows: listRows }} />
          : null}
        <Box flexGrow={1} justifyContent="center" alignItems="center" flexDirection="column">
          {own?.latest
            ? <Image key={KEY} source={{ png: own.latest }} columns={columns} rows={rows} alt="[live browser]" />
            : own?.isEnded
              ? errorRest.map(text => <Text dimColor>{text}</Text>)
              : <Text dimColor>{own ? 'waiting for the first frame…' : ''}</Text>}
        </Box>
      </Box>
    )
  })
}
