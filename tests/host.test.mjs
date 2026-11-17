import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function makeReq(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = {}
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
    req.emit('end')
  })
  return req
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(chunk) {
      this.body = Buffer.from(chunk).toString('utf8')
    },
  }
}

async function call(handler, method, route, body) {
  const res = makeRes()
  await handler(makeReq(method, '/api/shadow-bilingual' + route, body), res)
  return { status: res.statusCode, json: JSON.parse(res.body) }
}

test('host retries a missing short segment individually instead of dropping the batch', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'shadow-bilingual-retry-'))
  const previousHome = process.env.DSH_HOME
  const previousKey = process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  process.env.DSH_HOME = home

  let handler = null
  const ctx = {
    webServer: {
      register(options) {
        handler = options.handler
      },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }

  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async (_url, options) => {
    requests += 1
    const payload = JSON.parse(options.body)
    const items = JSON.parse(payload.messages[1].content).items
    // Simulate the model omitting every short item when it is batched:
    // a multi-item request returns only the first item; a single-item retry
    // returns that item.
    const returned = items.length > 1 ? [items[0]] : items
    const content = JSON.stringify({
      items: returned.map((item) => ({
        id: item.id,
        text: item.target === 'en' ? `English ${item.id}` : `中文 ${item.id}`,
      })),
    })
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ choices: [{ message: { content } }] })
      },
    }
  }

  try {
    const mod = await import('../lib/index.js')
    mod.apply(ctx)
    await call(handler, 'POST', '/config', { apiKey: 'sk-retry-1234567890' })
    const result = await call(handler, 'POST', '/translate', {
      items: [
        { id: 1, text: '功率因数 0.88 滞后（lagging）：', target: 'en' },
        { id: 2, text: '三、写成相量', target: 'en' },
      ],
    })
    assert.equal(result.status, 200)
    assert.equal(result.json.items.length, 2)
    assert.equal(result.json.items[0].text, 'English 1')
    assert.equal(result.json.items[1].text, 'English 2')
    assert.ok(requests >= 2, 'expected a batch request plus an individual retry')
  } finally {
    try {
      if (handler !== null) await call(handler, 'POST', '/config', { apiKey: '' })
    } catch {
      // 清理失败不影响测试结论
    }
    globalThis.fetch = originalFetch
    process.env.DSH_HOME = previousHome
    if (previousKey !== undefined) process.env.DEEPSEEK_API_KEY = previousKey
    rmSync(home, { recursive: true, force: true })
  }
})

test('host config + translate route with a fake DeepSeek endpoint', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'shadow-bilingual-test-'))
  const previousHome = process.env.DSH_HOME
  const previousKey = process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  process.env.DSH_HOME = home

  let handler = null
  const ctx = {
    webServer: {
      register(options) {
        handler = options.handler
      },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }

  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    // 按 target 回不同语言：宿主的 validTranslation 会拒绝「en 目标却回中文」，
    // 回错语言会让重试逻辑把测试拖成 502。
    let target = 'zh'
    try {
      const sent = JSON.parse(options.body)
      const user = sent.messages.find((m) => m.role === 'user')
      target = JSON.parse(user.content).items[0].target
    } catch {
      target = 'zh'
    }
    const SAMPLES = {
      en: 'Merge this branch in.',
      zh: '你好，世界。',
      'zh-TW': '你好，世界。',
      ja: 'こんにちは、世界。',
      ko: '안녕하세요, 세계.',
      ru: 'Привет, мир.',
      ar: 'مرحبا بالعالم.',
      hi: 'नमस्ते दुनिया।',
      th: 'สวัสดีชาวโลก',
    }
    // 拉丁字母的目标语言（es/fr/de/…）：宿主只校验有没有拉丁字母
    const text = SAMPLES[target] ?? 'Hola, mundo.'
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ items: [{ id: 1, text }] }) } }],
        })
      },
    }
  }

  try {
    const mod = await import('../lib/index.js')
    mod.apply(ctx)
    assert.ok(handler)

    let result = await call(handler, 'GET', '/config')
    assert.equal(result.status, 200)
    assert.equal(result.json.hasKey, false)

    result = await call(handler, 'POST', '/config', { apiKey: 'sk-test-1234567890', model: 'deepseek-chat' })
    assert.equal(result.status, 200)
    assert.equal(result.json.hasKey, true)
    assert.equal(result.json.keyHint, 'sk-…7890')
    let saved = JSON.parse(readFileSync(path.join(home, 'shadow-bilingual.json'), 'utf8'))
    assert.equal(saved.apiKey, 'sk-test-1234567890')

    // 本地显示语言：默认中文、可写可读、未知值回落、落盘
    assert.equal(result.json.localLanguage, 'zh')
    assert.ok(Array.isArray(result.json.localLanguages) && result.json.localLanguages.length >= 10)
    result = await call(handler, 'POST', '/config', { localLanguage: 'ja' })
    assert.equal(result.status, 200)
    assert.equal(result.json.localLanguage, 'ja')
    saved = JSON.parse(readFileSync(path.join(home, 'shadow-bilingual.json'), 'utf8'))
    assert.equal(saved.localLanguage, 'ja')

    // 大小写 / 下划线宽容 + 未知值回落默认
    result = await call(handler, 'POST', '/config', { localLanguage: 'zh_tw' })
    assert.equal(result.json.localLanguage, 'zh-TW')
    result = await call(handler, 'POST', '/config', { localLanguage: 'klingon' })
    assert.equal(result.json.localLanguage, 'zh')

    // 显示侧目标语言真的要送到模型，且译文按该语言校验
    calls.length = 0
    result = await call(handler, 'POST', '/translate', { items: [{ id: 1, text: 'Hello, world.', target: 'ja' }] })
    assert.equal(result.status, 200)
    assert.equal(result.json.items[0].text, 'こんにちは、世界。')
    const jaSent = JSON.parse(calls[0].options.body)
    const jaUser = jaSent.messages.find((m) => m.role === 'user')
    assert.equal(JSON.parse(jaUser.content).items[0].target, 'ja')
    // 系统提示词里必须列出所有目标语言，否则模型不知道 ja 是什么
    const systemText = jaSent.messages.find((m) => m.role === 'system').content
    for (const code of ['en', 'zh', 'ja', 'ko', 'de', 'ar']) {
      assert.ok(systemText.includes(code), `SYSTEM_PROMPT 缺少语言 ${code}`)
    }

    calls.length = 0
    result = await call(handler, 'POST', '/translate', { items: [{ id: 1, text: 'Hello, world.', target: 'zh' }] })
    assert.equal(result.status, 200)
    assert.equal(result.json.items[0].text, '你好，世界。')
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /\/chat\/completions$/)
    assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-test-1234567890')

    // 上下文必须真的进了发给模型的请求体，否则「术语一致」只是空话。
    calls.length = 0
    result = await call(handler, 'POST', '/translate', {
      items: [{ id: 1, text: '把这个分支合进去。', target: 'en' }],
      context: '用户(中) : 用 git merge 分支\n助手(英) : Merge the branch with git.',
    })
    assert.equal(result.status, 200)
    const sent = JSON.parse(calls[0].options.body)
    const userMessage = sent.messages.find((m) => m.role === 'user')
    const parsed = JSON.parse(userMessage.content)
    assert.ok(typeof parsed.context === 'string', 'context 字段缺失')
    assert.match(parsed.context, /git merge/, 'context 内容没传到模型')

    // 没有上下文时不能凭空塞一个空 context 字段进去
    calls.length = 0
    result = await call(handler, 'POST', '/translate', { items: [{ id: 1, text: 'Hello, world.', target: 'zh' }] })
    assert.equal(result.status, 200)
    const plainBody = JSON.parse(calls[0].options.body)
    const plainUser = plainBody.messages.find((m) => m.role === 'user')
    const plainParsed = JSON.parse(plainUser.content)
    assert.equal(plainParsed.context, undefined, '没有上下文时不应出现 context 字段')

    result = await call(handler, 'POST', '/translate', { items: [] })
    assert.equal(result.status, 400)

    result = await call(handler, 'POST', '/config', { apiKey: '' })
    assert.equal(result.json.hasKey, false)
  } finally {
    globalThis.fetch = originalFetch
    process.env.DSH_HOME = previousHome
    if (previousKey !== undefined) process.env.DEEPSEEK_API_KEY = previousKey
    rmSync(home, { recursive: true, force: true })
  }
})

test('credentials service is looked up per call, not cached at apply()', async () => {
  // 回归：插件可能是在应用启动之后才被 plugin_manager 挂载的，那一刻 credentials
  // 服务未必就绪。早先 apply() 里取一次就缓存 null，导致 hasKey 永远 false、
  // 翻译整个不可用，而界面上没有任何提示。
  const home = mkdtempSync(path.join(tmpdir(), 'shadow-bilingual-creds-'))
  const previousHome = process.env.DSH_HOME
  const previousKey = process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  process.env.DSH_HOME = home

  let handler = null
  let credCalls = 0
  const ctx = {
    webServer: {
      register(options) {
        handler = options.handler
      },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    // 关键：apply() 时还没有 credentials，之后才有——模拟「服务晚于插件就绪」
    get(name) {
      if (name !== 'credentials') return undefined
      return {
        async resolve() {
          credCalls += 1
          return { value: 'sk-late-1234567890' }
        },
      }
    },
  }

  try {
    const mod = await import('../lib/index.js')
    mod.apply(ctx)
    assert.ok(handler)

    const result = await call(handler, 'GET', '/health')
    assert.equal(result.status, 200)
    assert.equal(result.json.hasKey, true, 'credentials 应当每次现取，不能缓存 null')
    assert.equal(result.json.keySource, 'credentials')
    assert.ok(credCalls > 0)

    // 再问一次仍然可用（说明不是一次性快照）
    const again = await call(handler, 'GET', '/health')
    assert.equal(again.json.hasKey, true)
    assert.ok(credCalls >= 2, '第二次查询也应重新走凭据服务')
  } finally {
    process.env.DSH_HOME = previousHome
    if (previousKey !== undefined) process.env.DEEPSEEK_API_KEY = previousKey
    rmSync(home, { recursive: true, force: true })
  }
})
