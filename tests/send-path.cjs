// 发送链路单测：直接驱动拦截器的判定逻辑，不碰真实界面。
//
// 固化的规格（来自用户 m00794 的描述）：
//   1. 单次 Enter → 只提交一次（不能中英各发一条）
//   2. 翻译失败 / 超时 → 原文照发，不阻塞、不吞消息
//   3. 拿不到 inputActions → 不接管事件（否则吞掉又发不出去）
//   4. 锁不能永久卡住（卡住的表现就是「按回车没反应，草稿留在框里」）
const fs = require('node:fs')
const path = require('node:path')

const file = path.resolve(process.argv[2] || 'lib/client.js')
let failures = 0
let passed = 0
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log('  PASS  ' + name) }
  else { failures += 1; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------- DOM 模拟 ----------------
const docListeners = []
let activeEl = null

function makeEditable(text) {
  const el = {
    tagName: 'DIV',
    innerText: text,
    textContent: text,
    classList: { contains: () => false },
    getAttribute: () => null,
  }
  el.closest = (sel) => (sel === '[contenteditable="true"]' ? el : null)
  return el
}

const doc = {
  get activeElement() { return activeEl },
  head: { appendChild() {} },
  body: { appendChild() {} },
  documentElement: {},
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: (t, f) => docListeners.push([t, f]),
  removeEventListener: (t, f) => {
    const i = docListeners.findIndex((e) => e[0] === t && e[1] === f)
    if (i >= 0) docListeners.splice(i, 1)
  },
}

const store = new Map()
const storage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}

// ---------------- 可观察的 inputActions ----------------
let setDraftCalls = []
let submitCount = 0

function makeActions() {
  return {
    setDraft: (text) => { setDraftCalls.push(text) },
    submit: () => { submitCount += 1 },
    insertText: () => {},
    insertQuote: () => {},
    captureInsertion: () => null,
    persistDraft: () => {},
    addAttachments: () => {},
    removeAttachment: () => {},
    pruneAttachments: () => {},
  }
}

// ---------------- 加载 bundle ----------------
let loaded = []
const g = globalThis
g.window = g
g.document = doc
g.localStorage = storage
g.sessionStorage = storage
g.navigator = { language: 'zh-CN' }
g.location = { href: 'http://127.0.0.1:55443/' }
g.Event = function (type, opts) { this.type = type; this.bubbles = !!(opts && opts.bubbles) }
g.HTMLTextAreaElement = function () {}
g.HTMLTextAreaElement.prototype = {}
g.MutationObserver = class { observe() {} disconnect() {} }
g.addEventListener = () => {}
g.removeEventListener = () => {}
g.devicePixelRatio = 1
g.__ModuleLoader__ = { load: (def) => loaded.push(def) }

const effectCleanups = []
function runEffect(fn, deps) {
  // 记录上一次 deps，deps 变了才重跑（简化版）
  const key = deps ? JSON.stringify(deps.map((d) => (typeof d === 'function' ? 'fn' : d))) : 'always'
  const prev = runEffect.prev
  if (prev && prev.key === key) return
  runEffect.prev = { key }
  try {
    const cleanup = fn()
    if (typeof cleanup === 'function') effectCleanups.push(cleanup)
  } catch (e) { /* 组件副作用失败不应中断测试 */ }
}

const React = {
  Fragment: 'Fragment',
  Component: class { constructor(p) { this.props = p || {} } setState() {} render() { return null } },
  createElement: (type, props, ...kids) => ({ type, props, kids }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: (fn, deps) => { runEffect(fn, deps) },
  useLayoutEffect: (fn, deps) => { runEffect(fn, deps) },
  useRef: (v) => ({ current: v }),
  useMemo: (f) => f(),
  useCallback: (f) => f,
  useSyncExternalStore: () => ({ draft: '' }),
  useReducer: (r, i) => [typeof i === 'function' ? i() : i, () => {}],
  memo: (f) => f,
  forwardRef: (f) => f,
  createContext: (v) => ({ Provider: 'P', _v: v }),
  useContext: () => ({}),
}

let translateMode = 'ok'
let translateCalls = 0
let lastContext = ''
const fetchStub = (url, opts) => {
  if (String(url).indexOf('/translate') !== -1) {
    translateCalls += 1
    if (translateMode === 'fail') return Promise.reject(new Error('network down'))
    if (translateMode === 'hang') return new Promise(() => {})
    const body = JSON.parse(opts.body)
    lastContext = body.context || ''
    const items = body.items.map((it) => ({ id: it.id, text: 'Hello world, this is English.' }))
    const payload = JSON.stringify({ items })
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ items }),
      text: () => Promise.resolve(payload),
    })
  }
  const empty = JSON.stringify({})
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve(empty) })
}
g.fetch = fetchStub

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

const code = fs.readFileSync(file, 'utf8')
new Function('window', 'document', 'localStorage', 'sessionStorage', 'fetch',
  'MutationObserver', 'setTimeout', 'clearTimeout', 'navigator', 'location', 'React', code)(
  g, doc, storage, storage, fetchStub, g.MutationObserver,
  (f, ms) => setTimeout(f, ms), (id) => clearTimeout(id), g.navigator, g.location, React,
)

const exported = loaded[0].factory(requireFn)

const slots = []
const ctx = {
  slots: {
    inject: (name, fn) => { fn() },
    register: (decl, comp) => { slots.push({ decl, comp }); return () => {} },
    registerForce: (decl) => { slots.push({ decl }); return () => {} },
  },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  on: () => () => {},
  get: () => undefined,
  fetch: fetchStub,
}
exported.apply(ctx)

const keydownFns = docListeners.filter((e) => e[0] === 'keydown').map((e) => e[1])
const clickFns = docListeners.filter((e) => e[0] === 'click').map((e) => e[1])

console.log('发送链路单测 · ' + path.basename(file))
check('apply() 注册了槽位', slots.length > 0, 'slots=' + slots.length)
check('keydown 只有一套监听器（防重复拦截）', keydownFns.length === 1, 'count=' + keydownFns.length)
check('click 只有一套监听器', clickFns.length === 1, 'count=' + clickFns.length)

function pressEnter() {
  const ev = {
    key: 'Enter', shiftKey: false, altKey: false, repeat: false, keyCode: 13, isComposing: false,
    _prevented: false, _stopped: false,
    preventDefault() { this._prevented = true },
    stopPropagation() { this._stopped = true },
    stopImmediatePropagation() { this._stopped = true },
  }
  for (const fn of keydownFns) fn(ev)
  return ev
}

async function main() {
  // --- 场景 1：拿不到 inputActions → 不能吞事件 ---
  activeEl = makeEditable('这是一段中文草稿')
  const ev1 = pressEnter()
  check('无 inputActions 时不阻止默认行为（不吞消息）', ev1._prevented === false, 'prevented=' + ev1._prevented)

  // --- 装配 inputActions（模拟面板挂载时写入 bridge） ---
  const panel = slots.find((s) => s.decl && s.decl.name === 'conversation.composer.dock')
  if (!panel) { console.error('找不到 composer.dock 面板槽位'); process.exit(1) }
  const actions = makeActions()
  panel.comp({ inputActions: actions, useInput: (sel) => sel({ draft: '' }) })

  // --- 场景 2：首次 Enter → 先拦下，译文就绪后自动发一次英文 ---
  setDraftCalls = []
  submitCount = 0
  translateCalls = 0
  translateMode = 'ok'
  activeEl = makeEditable('这是一段中文草稿')
  const ev2 = pressEnter()
  check('接管时阻止了默认行为', ev2._prevented === true, 'prevented=' + ev2._prevented)
  check('译文未就绪时先不提交', submitCount === 0, 'submit=' + submitCount)

  await sleep(400)
  check('译文就绪后自动提交一次', submitCount === 1, 'submit=' + submitCount)
  check('提交前写入了英文草稿', setDraftCalls.length === 1 && /[A-Za-z]/.test(String(setDraftCalls[0])),
    'setDraft=' + JSON.stringify(setDraftCalls))
  check('只发起了一次翻译请求', translateCalls === 1, 'translateCalls=' + translateCalls)

  // --- 场景 3：译文就绪后连按 Enter → 仍然只提交一次 ---
  setDraftCalls = []
  submitCount = 0
  translateCalls = 0
  activeEl = makeEditable('第二段中文草稿')
  pressEnter()
  await sleep(30)
  const ev3b = pressEnter()
  await sleep(400)
  check('翻译在飞时连按 Enter 仍然只提交一次', submitCount === 1, 'submit=' + submitCount)
  check('连按期间第二次按键被吞', ev3b._prevented === true, 'prevented=' + ev3b._prevented)

  // --- 场景 4：翻译失败 → 原文照发，不阻塞 ---
  setDraftCalls = []
  submitCount = 0
  translateMode = 'fail'
  activeEl = makeEditable('第三段中文草稿')
  pressEnter()
  await sleep(400)
  check('翻译失败不吞消息（放行原文）', submitCount === 0, 'submit=' + submitCount)
  const ev4b = pressEnter()
  check('失败后再次 Enter 放行给原生提交', ev4b._prevented === false, 'prevented=' + ev4b._prevented)

  // --- 场景 5：翻译挂起 → 不能卡死；译文回来后自动发 ---
  setDraftCalls = []
  submitCount = 0
  translateMode = 'hang'
  activeEl = makeEditable('第四段中文草稿')
  pressEnter()
  await sleep(500)
  check('翻译挂起时先不提交（不吞成双发）', submitCount === 0, 'submit=' + submitCount)
  translateMode = 'ok'

  // --- 场景 6：新草稿不受上一段影响 ---
  setDraftCalls = []
  submitCount = 0
  activeEl = makeEditable('第五段中文草稿')
  pressEnter()
  await sleep(400)
  check('上一段挂起的翻译不影响新消息发送', submitCount === 1, 'submit=' + submitCount)

  // --- 场景 7：队列里的中文消息 → 被就地译成英文 ---
  const queueSlot = slots.find((s) => s.decl && s.decl.name === 'conversation.input.dock' && s.decl.id === 'shadow-bilingual-queue')
  check('注册了队列翻译槽位', queueSlot !== undefined)

  if (queueSlot !== undefined) {
    let queueUpdates = []
    const updateQueue = (id, action) => { queueUpdates.push([id, action]); return Promise.resolve() }
    const rows = { 'next-turn': [
      { id: 'row-1', content: [{ type: 'text', text: '这是排队中的中文消息' }] },
      { id: 'row-2', content: [{ type: 'text', text: 'Already English here' }] },
      { id: 'row-3', content: [{ type: 'text', text: '带图片的中文' }, { type: 'image', attachment: {} }] },
    ] }
    translateMode = 'ok'
    translateCalls = 0
    queueSlot.comp({ updateQueue, useProjection: () => rows })
    await sleep(300)
    check('队列里含中文的行被写回英文', queueUpdates.length === 1 && queueUpdates[0][0] === 'row-1',
      'updates=' + JSON.stringify(queueUpdates.map((u) => u[0])))
    check('写回的是 edit 动作且内容为英文',
      queueUpdates.length === 1 && queueUpdates[0][1].kind === 'edit'
      && /[A-Za-z]/.test(queueUpdates[0][1].content[0].text),
      'action=' + JSON.stringify(queueUpdates[0] && queueUpdates[0][1]))
    check('纯英文行不重复翻译', !queueUpdates.some((u) => u[0] === 'row-2'), 'updates=' + JSON.stringify(queueUpdates.map((u) => u[0])))
    check('带附件的行不动（避免丢附件）', !queueUpdates.some((u) => u[0] === 'row-3'), 'updates=' + JSON.stringify(queueUpdates.map((u) => u[0])))

    // --- 场景 8：队列翻译失败 → 不写回，原文保留 ---
    queueUpdates = []
    translateMode = 'fail'
    queueSlot.comp({ updateQueue, useProjection: () => ({ 'next-turn': [{ id: 'row-4', content: [{ type: 'text', text: '另一条中文' }] }] }) })
    await sleep(300)
    check('队列翻译失败时保留原文，不乱改', queueUpdates.length === 0, 'updates=' + JSON.stringify(queueUpdates))

    // --- 场景 9：同一行不会反复翻译（不自激） ---
    queueUpdates = []
    translateMode = 'ok'
    const loopRows = { 'next-turn': [{ id: 'row-5', content: [{ type: 'text', text: '第三条中文' }] }] }
    queueSlot.comp({ updateQueue, useProjection: () => loopRows })
    await sleep(400)
    check('同一行只翻译一次', queueUpdates.filter((u) => u[0] === 'row-5').length === 1,
      'count=' + queueUpdates.filter((u) => u[0] === 'row-5').length)
  }

  console.log('')
  console.log(failures === 0 ? '全部通过 (' + passed + ')' : failures + ' 项失败（通过 ' + passed + '）')
  process.exit(failures === 0 ? 0 : 1)

}

main().catch((e) => { console.error(e); process.exit(1) })
