// 列出 bundle 注册的全部槽位，确认队列翻译器已挂上且没有重复。
const fs = require('node:fs')
const path = require('node:path')
const file = path.resolve(process.argv[2] || 'lib/client.js')

const docListeners = []
const doc = {
  activeElement: null,
  head: { appendChild() {} }, body: { appendChild() {} }, documentElement: {},
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  addEventListener: (t, f) => docListeners.push([t, f]),
  removeEventListener: () => {},
}
const store = new Map()
const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }
const g = globalThis
for (const [k, v] of Object.entries({ window: g, document: doc, localStorage: storage, sessionStorage: storage,
  navigator: { language: 'zh-CN' }, location: { href: 'http://127.0.0.1:55443/' },
  MutationObserver: class { observe() {} disconnect() {} },
  addEventListener: () => {}, removeEventListener: () => {}, devicePixelRatio: 1 })) {
  try { Object.defineProperty(g, k, { value: v, writable: true, configurable: true }) } catch {}
}
g.Event = function (t, o) { this.type = t; this.bubbles = !!(o && o.bubbles) }
g.HTMLTextAreaElement = function () {}; g.HTMLTextAreaElement.prototype = {}
g.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') })
let loaded = []
g.__ModuleLoader__ = { load: (d) => loaded.push(d) }

const React = {
  Fragment: 'Fragment',
  Component: class { constructor(p) { this.props = p || {} } setState() {} render() { return null } },
  createElement: (t, p, ...k) => ({ type: t, props: p, kids: k }),
  useState: (i) => [typeof i === 'function' ? i() : i, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }),
  useMemo: (f) => f(), useCallback: (f) => f, useSyncExternalStore: () => undefined,
  useReducer: (r, i) => [typeof i === 'function' ? i() : i, () => {}],
  memo: (f) => f, forwardRef: (f) => f,
  createContext: (v) => ({ Provider: 'P', _v: v }), useContext: () => ({}),
}
const primitives = Object.assign((t, p, ...c) => ({ type: t, props: p, kids: c }), {
  MarkdownText: (p) => ({ type: 'MarkdownText', props: p }),
  JsonBlock: (p) => ({ type: 'JsonBlock', props: p }),
  Button: (p) => ({ type: 'Button', props: p }),
})
const requireFn = (id) => {
  if (id === 'react') return React
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error('unexpected require: ' + id)
}
new Function('window','document','localStorage','sessionStorage','fetch','MutationObserver','setTimeout','clearTimeout','navigator','location','React',
  fs.readFileSync(file, 'utf8'))(g, doc, storage, storage, g.fetch, g.MutationObserver, setTimeout, clearTimeout, g.navigator, g.location, React)

const exported = loaded[0].factory(requireFn)
const slots = []
const ctx = {
  slots: { inject: (n, f) => f(), register: (d, c) => { slots.push({ decl: d, comp: c }); return () => {} } },
  effect: (f) => { const d = f(); return typeof d === 'function' ? d : () => {} },
  on: () => () => {}, get: () => undefined, logger: { info() {}, warn() {}, error() {} },
}
exported.apply(ctx)

console.log('plugin:', exported.name, '| inject:', JSON.stringify(exported.inject))
console.log('')
for (const { decl } of slots) {
  const id = decl.id ? ' id=' + decl.id : ''
  const key = decl.key ? ' key=' + decl.key : ''
  const order = decl.order !== undefined ? ' order=' + decl.order : ''
  console.log('  ' + decl.name + id + key + order)
}
console.log('')
console.log('document listeners:', docListeners.map((e) => e[0]).join(', '))
