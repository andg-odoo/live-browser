import type { ClientKeyEvent, ClientModule } from 'claude-code'

type Hints = { click: string[]; kinds: Record<string, string>; fields: string[]; dropdowns: string[]; checks: string[]; page: string }
type Options = { field: string; list: string[]; error?: string }
type Props = { hints: Hints; history: string[]; records: string[]; options?: Options; maxRows?: number }
type State = { text: string; index: number; recall: number; asked?: string }
type Row = { key: string; desc: string; fill: string }

const STEPS: [string, string, string][] = [
  ['open', 'MODEL ID', 'open a record form'],
  ['goto', 'PATH', 'open a URL path'],
  ['click', 'LABEL', 'press a button, link, tab or text'],
  ['fill', 'LABEL=VALUE', 'type into a field'],
  ['select', 'LABEL=OPTION', 'pick a value in a field'],
  ['check', 'LABEL', 'tick a checkbox'],
  ['uncheck', 'LABEL', 'untick a checkbox'],
  ['expect', 'TEXT', 'fail unless TEXT is visible'],
  ['wait', 'MS|SELECTOR', 'pause, or wait for an element'],
  ['shot', 'NAME', 'save a screenshot'],
]
const HELP = 'Tab completes · ↑↓ pick · Enter runs a full step · Esc leaves'
const START: State = { text: '', index: 0, recall: -1 }

let props: Props = { hints: { click: [], kinds: {}, fields: [], dropdowns: [], checks: [], page: '' }, history: [], records: [] }

const selectField = (text: string) => split(text)[1].match(/^select (.+?)=/)?.[1]

function targets(verb: string): [string[], string] {
  const { hints, records } = props
  if (verb === 'click') {
    return [hints.click, 'on this page']
  }
  if (verb === 'fill') {
    return [hints.fields, 'field']
  }
  if (verb === 'select') {
    return [hints.dropdowns, 'dropdown']
  }
  if (verb === 'check' || verb === 'uncheck') {
    return [hints.checks, 'checkbox']
  }
  if (verb === 'open') {
    return [records, 'record']
  }
  if (verb === 'goto') {
    return [hints.page ? [hints.page] : [], 'this page']
  }
  return [[], '']
}

function split(text: string): [string, string] {
  const cut = text.lastIndexOf(';') + 1
  const head = cut ? `${text.slice(0, cut)} ` : ''
  return [head, text.slice(cut).trimStart()]
}

function rowsFor(text: string): Row[] {
  const [head, step] = split(text)
  const [verb = '', ...rest] = step.split(' ')
  const isVerb = rest.length > 0 && STEPS.some(([name]) => name === verb)
  if (!isVerb) {
    return STEPS.filter(([name]) => name.startsWith(verb)).map(([name, syntax, purpose]) => ({ key: `${name} ${syntax}`, desc: purpose, fill: `${head}${name} ` }))
  }
  const typed = rest.join(' ').toLowerCase()
  const field = verb === 'select' ? selectField(text) : undefined
  if (field !== undefined) {
    const options = props.options?.field === field ? props.options : undefined
    if (!options) {
      return [{ key: 'reading the options…', desc: '', fill: text }]
    }
    const partial = typed.slice(field.length + 1)
    const rows = options.list.filter(option => option.toLowerCase().startsWith(partial)).map(option => ({ key: option, desc: 'option', fill: `${head}select ${field}=${option}` }))
    return rows.length || !options.error ? rows : [{ key: options.error, desc: 'could not read the options', fill: text }]
  }
  const [names, desc] = targets(verb)
  const suffix = verb === 'fill' || verb === 'select' ? '=' : ''
  const descOf = (name: string) => (verb === 'click' && props.hints.kinds[name]) || desc
  return names.filter(name => name.toLowerCase().startsWith(typed)).map(name => ({ key: name, desc: descOf(name), fill: `${head}${verb} ${name}${suffix}` }))
}

function isComplete(text: string) {
  const step = split(text)[1]
  return step.includes(' ') && !step.endsWith(' ') && !step.endsWith('=')
}

function onKey(event: ClientKeyEvent, state: State, post: (data: { run: string }) => void): State {
  const rows = rowsFor(state.text)
  const pick = rows[Math.min(state.index, rows.length - 1)]
  const { key } = event
  if (key === 'up' && (state.recall >= 0 || (!state.text && state.index === 0))) {
    const recall = Math.min(state.recall + 1, props.history.length - 1)
    return recall < 0 ? state : { text: props.history[recall] ?? '', index: 0, recall }
  }
  if (key === 'down' && state.recall >= 0) {
    const recall = state.recall - 1
    return { text: recall < 0 ? '' : props.history[recall] ?? '', index: 0, recall }
  }
  if (key === 'up' || key === 'down') {
    return { ...state, index: Math.max(0, Math.min(state.index + (key === 'up' ? -1 : 1), rows.length - 1)) }
  }
  if (key === 'tab') {
    return pick ? { text: pick.fill, index: 0, recall: -1 } : state
  }
  if (key === 'return') {
    if (isComplete(state.text) && (!pick || pick.fill.trim() === state.text.trim())) {
      post({ run: state.text })
      return START
    }
    return pick ? { text: pick.fill, index: 0, recall: -1 } : state
  }
  if (key === 'backspace' || key === 'delete') {
    return { text: state.text.slice(0, -1), index: 0, recall: -1 }
  }
  if (key === 'u' && event.ctrl) {
    return START
  }
  const char = key === 'space' ? ' ' : key
  if ([...char].length === 1 && !event.ctrl && !event.meta) {
    return { text: state.text + char, index: 0, recall: -1 }
  }
  return state
}

const Steps: ClientModule<Props, State> = (next, surface) => {
  props = next
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    surface.onKey(event => {
      const state = surface.state ?? START
      let after = onKey(event, state, data => surface.post(data))
      const field = selectField(after.text)
      if (field && field !== after.asked && props.options?.field !== field) {
        surface.post({ options: field })
        after = { ...after, asked: field }
      }
      if (after !== state) {
        surface.setState(after)
      }
    })
    surface.setState(START)
  }
  const state = surface.state ?? START
  const rows = rowsFor(state.text)
  const room = Math.max(1, props.maxRows ?? ((surface.rows || 6) - 2))
  const index = Math.min(state.index, Math.max(0, rows.length - 1))
  const first = Math.max(0, Math.min(index - room + 1, rows.length - room))
  const width = Math.min(36, Math.max(12, ...rows.map(row => row.key.length + 2)))
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-start">› {state.text}<Text inverse> </Text></Text>
      {rows.length
        ? rows.slice(first, first + room).map((row, at) => (
          <Box flexDirection="row">
            <Box width={width}><Text inverse={first + at === index} wrap="truncate-end">{row.key}</Text></Box>
            <Text dimColor wrap="truncate-end">{row.desc}</Text>
          </Box>
        ))
        : <Text dimColor>{state.text.trim() ? 'Enter runs it' : ''}</Text>}
      <Text dimColor wrap="truncate-end">{HELP}</Text>
    </Box>
  )
}

export default Steps
