import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function loadClient() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let loaded = null

  class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }
  }

  const React = {
    createElement: (...args) => ({ args }),
    Component,
    Fragment: Symbol('Fragment'),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }

  const primitives = {
    MarkdownText: function MarkdownText() {},
    JsonBlock: function JsonBlock() {},
  }

  const window = {
    __ModuleLoader__: {
      load: (entry) => {
        loaded = entry.factory((name) => {
          if (name === 'react') return React
          if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
          throw new Error('unexpected require: ' + name)
        })
      },
    },
  }

  const context = {
    window,
    console,
    URL,
    Map,
    Set,
    Symbol,
    setTimeout,
    clearTimeout,
    fetch: () => Promise.reject(new Error('no network in test')),
    sessionStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
  }
  vm.runInNewContext(source, context, { filename: 'client.js' })
  return loaded
}

test('client bundle loads and registers every slot', () => {
  const loaded = loadClient()
  assert.equal(loaded.name, 'shadow-bilingual')
  const registered = []
  const ctx = {
    effect: (fn) => {
      fn()
      return () => {}
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    slots: {
      inject: (name, callback) => {
        const off = callback()
        registered.push(name)
        return off
      },
      register: (meta, component) => {
        assert.ok(meta.name)
        assert.ok(typeof component === 'function')
        return () => {}
      },
    },
  }
  loaded.apply(ctx)
  assert.deepEqual(registered.sort(), [
    'conversation.chat.node',
    'conversation.composer.dock',
    'conversation.input.dock',
    'conversation.input.left',
    'conversation.session.header.actions',
    'conversation.user.text.node',
    'settings.section',
    'settings.section.icon',
  ])
})

test('client internals expose the markdown pipeline', () => {
  const loaded = loadClient()
  const units = loaded.__internals.splitUnits('### Title\n\nBody text here.')
  assert.equal(units.map((unit) => unit.kind).join(','), 'heading,paragraph')

  // 显示侧：英文正文 → 本地语言（助手回复那条链路）
  assert.equal(loaded.__internals.translationTarget(units[1], { mode: 'local', localLanguage: 'zh' }).target, 'zh')
  assert.equal(loaded.__internals.translationTarget(units[1], { mode: 'local', localLanguage: 'ja' }).target, 'ja')
  // 显示侧：已经是本地语言就不翻
  assert.equal(loaded.__internals.translationTarget(units[1], { mode: 'local', localLanguage: 'en' }), null)

  // AI 侧：本地语言 → 英文（输入框 / 插话 / 队列那条链路）
  const zhUnits = loaded.__internals.splitUnits('### 标题\n\n正文。')
  assert.equal(loaded.__internals.translationTarget(zhUnits[1], { mode: 'english', localLanguage: 'zh' }).target, 'en')
  // AI 侧：本来就是英文就不翻
  assert.equal(loaded.__internals.translationTarget(units[1], { mode: 'english', localLanguage: 'zh' }), null)

  // 本地语种列表由设置页消费，至少要有中文、日文、西文三种
  const codes = loaded.__internals.localLanguages.map((item) => item.code)
  assert.ok(codes.includes('zh') && codes.includes('ja') && codes.includes('es'), codes.join(','))
})
