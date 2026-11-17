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

test('原文已经是目标语言时不再请求模型，也不会 502', async () => {
  // 回归（2026-11-17 线上日志成片 `status=502 empty`）：助手偶尔直接用中文回答，
  // 客户端按本地语言请求 zh 译文；旧逻辑把「模型原样返回」判成无效 → 重试 → 空 → 502。
  const home = mkdtempSync(path.join(tmpdir(), 'shadow-bilingual-identity-'))
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
  globalThis.fetch = async () => {
    requests += 1
    throw new Error('原文已是目标语言时不应该再打模型')
  }

  try {
    const mod = await import('../lib/index.js')
    mod.apply(ctx)
    await call(handler, 'POST', '/config', { apiKey: 'sk-identity-1234567890' })

    const chinese = '我发现了一个设计缺口：宿主端存储了 localLanguage，却从不把它发给模型。'
    let result = await call(handler, 'POST', '/translate', {
      items: [{ id: 1, text: chinese, target: 'zh' }],
    })
    assert.equal(result.status, 200)
    assert.equal(result.json.items[0].text, chinese)
    assert.equal(requests, 0, '同一语言的段落必须跳过请求')

    // 用户直接打英文时的 en 目标同理
    const english = 'Merge this branch in.'
    result = await call(handler, 'POST', '/translate', {
      items: [{ id: 7, text: english, target: 'en' }],
    })
    assert.equal(result.status, 200)
    assert.equal(result.json.items[0].text, english)
    assert.equal(requests, 0)

    // 纯符号/数字没有可译内容：模型原样返回时不能判成 502
    globalThis.fetch = async (_url, options) => {
      requests += 1
      const items = JSON.parse(JSON.parse(options.body).messages[1].content).items
      const content = JSON.stringify({ items: items.map((item) => ({ id: item.id, text: item.text })) })
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ choices: [{ message: { content } }] })
        },
      }
    }
    requests = 0
    result = await call(handler, 'POST', '/translate', { items: [{ id: 9, text: '—', target: 'zh' }] })
    assert.equal(result.status, 200)
    assert.equal(result.json.items[0].text, '—')
    assert.ok(requests >= 1)

    // 混批：无需翻译的直接通过，需要翻译的仍然交给模型
    globalThis.fetch = async () => {
      requests += 1
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ items: [{ id: 2, text: 'Hello world.' }] }) } }],
          })
        },
      }
    }
    requests = 0
    result = await call(handler, 'POST', '/translate', {
      items: [
        { id: 1, text: '已经就是中文的段落', target: 'zh' },
        { id: 2, text: '这是一句需要翻成英文的话。', target: 'en' },
      ],
    })
    assert.equal(result.status, 200)
    assert.equal(result.json.items.length, 2)
    assert.equal(result.json.items[0].text, '已经就是中文的段落')
    assert.equal(result.json.items[1].text, 'Hello world.')
    assert.equal(requests, 1)
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

test('目标英文却原样回中文仍然算失败（不能把「没翻译」放过）', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'shadow-bilingual-lazy-'))
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
    const items = JSON.parse(JSON.parse(options.body).messages[1].content).items
    // 懒惰模型：把中文原样回给 en 目标
    const content = JSON.stringify({ items: items.map((item) => ({ id: item.id, text: item.text })) })
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
    await call(handler, 'POST', '/config', { apiKey: 'sk-lazy-1234567890' })
    const result = await call(handler, 'POST', '/translate', {
      items: [{ id: 1, text: '把这条分支合进去。', target: 'en' }],
    })
    assert.equal(result.status, 502)
    assert.ok(requests >= 1)
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

test('英文段落里夹一句中文引用时仍然要翻', async () => {
  // 回归（2026-11-17）：宿主旧 alreadyInTarget 用 /[\u3400-\u9fff]/.test() 判
  // 「出现一个汉字就是中文」，于是「英文正文 + 一句中文引用」被整段塞进
  // passthrough、译文 == 原文：HTTP 200、日志无声，界面上整段英文没有译文。
  const home = mkdtempSync(path.join(tmpdir(), 'shadow-bilingual-mixed-'))
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

  const mixed = 'The crash dialog showed the string 应用无法启动或已意外停止, which came from the host stderr tail.'
  const translated = '崩溃对话框显示的是 应用无法启动或已意外停止 这句话，它来自宿主 stderr 的尾巴。'

  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async (_url, options) => {
    requests += 1
    const items = JSON.parse(JSON.parse(options.body).messages[1].content).items
    const content = JSON.stringify({ items: items.map((item) => ({ id: item.id, text: translated })) })
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
    await call(handler, 'POST', '/config', { apiKey: 'sk-mixed-1234567890' })

    // 中文正文夹长标识符：占比够高，仍应原样通过，而且不能从响应里消失。
    const chineseWithIdentifier = '这个配置文件里没有 localLanguage 字段。'
    requests = 0
    const result = await call(handler, 'POST', '/translate', {
      items: [
        { id: 1, text: mixed, target: 'zh' },
        { id: 2, text: chineseWithIdentifier, target: 'zh' },
      ],
    })
    assert.equal(result.status, 200)
    assert.equal(requests, 1, '混排段落必须交给模型；中文夹标识符不能再消耗请求')
    assert.equal(result.json.items.length, 2, '通过项也必须原样出现在响应里')
    assert.equal(result.json.items[0].text, translated)
    assert.equal(result.json.items[1].text, chineseWithIdentifier)
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


test('中文句子夹英文标识符、目标是英文时仍然要翻', async () => {
  // 回归（2026-11-18）：用户打「帮我装插件hermes-loop」按 Enter 发不出去。
  // 宿主旧判据 latinDominant 只看拉丁字母数量：hermes-loop 贡献 10 个字母、
  // 汉字 5 个（10 >= 5*1.5）→ 判「已经是英文」→ 原样退回，客户端拿到
  // 「译文 == 原文」判无效，发送闸门每按一次 Enter 就重翻一次、永远发不出去。
  const home = mkdtempSync(path.join(tmpdir(), 'shadow-bilingual-ident-'))
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

  const chineseWithIdentifier = '帮我装插件hermes-loop'
  const translated = 'Help me install the hermes-loop plugin.'
  // 已经是英文正文的混排段落：目标是英文时必须原样通过，不能再浪费一次请求。
  const alreadyEnglish = 'The crash dialog showed the string 应用无法启动或已意外停止, which came from the host stderr tail.'

  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async (_url, options) => {
    requests += 1
    const items = JSON.parse(JSON.parse(options.body).messages[1].content).items
    const content = JSON.stringify({ items: items.map((item) => ({ id: item.id, text: translated })) })
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
    await call(handler, 'POST', '/config', { apiKey: 'sk-ident-1234567890' })

    requests = 0
    const result = await call(handler, 'POST', '/translate', {
      items: [
        { id: 1, text: chineseWithIdentifier, target: 'en' },
        { id: 2, text: alreadyEnglish, target: 'en' },
      ],
    })
    assert.equal(result.status, 200)
    assert.equal(requests, 1, '中文夹标识符必须交给模型；已经是英文的段落不该再消耗请求')
    assert.equal(result.json.items.length, 2)
    assert.equal(result.json.items[0].text, translated, '不能把原样退回当中文句子的英文译文')
    assert.equal(result.json.items[1].text, alreadyEnglish)
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

test('拉丁字母显示语言与简繁：源语言不对就不许 passthrough', async () => {
  // 回归（2026-11-18 实测）：宿主旧 alreadyInTarget 只要看到拉丁字母就返回 true，
  // 于是「英文 → es/fr/de/pt/it/nl/pl/tr/vi/id」全被当成「已经是目标语言」原样退回，
  // 18 种显示语言里 10 种永远没有译文（HTTP 200、耗时 ~650ms、日志无声）。
  const home = mkdtempSync(path.join(tmpdir(), 'shadow-bilingual-latin-'))
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
    const items = JSON.parse(JSON.parse(options.body).messages[1].content).items
    const content = JSON.stringify({
      items: items.map((item) => ({ id: item.id, text: `[${item.target}] ${item.text}` })),
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
    await call(handler, 'POST', '/config', { apiKey: 'sk-latin-1234567890' })

    const english = 'The crash loop came from a restart script.'
    const spanish = 'El bucle de fallos vino de un script de reinicio, pero el panel no muestra nada.'
    const simplified = '这个配置文件里没有 localLanguage 字段。'
    const traditional = '這個設定檔裡沒有 localLanguage 欄位。'

    // 英文 → 十种拉丁字母显示语言：每一种都必须真的发请求
    const latinTargets = ['es', 'fr', 'de', 'pt', 'it', 'nl', 'pl', 'tr', 'vi', 'id']
    requests = 0
    const latinResult = await call(handler, 'POST', '/translate', {
      items: latinTargets.map((target, index) => ({ id: index + 1, text: english, target })),
    })
    assert.equal(latinResult.status, 200)
    assert.ok(requests >= 1, '十种拉丁字母语言不能因为「有字母」就被跳过')
    for (const item of latinResult.json.items) {
      assert.ok(item.text.startsWith('['), `${item.id} 必须拿到模型译文，实际是原文`)
    }

    // 西语正文 → es：这才是「已经是目标语言」，不许发请求
    requests = 0
    const spaResult = await call(handler, 'POST', '/translate', {
      items: [{ id: 1, text: spanish, target: 'es' }],
    })
    assert.equal(spaResult.json.items[0].text, spanish)
    assert.equal(requests, 0, '西语正文发给 es 目标不该再打模型')

    // 西语正文 → 法语：必须翻
    requests = 0
    await call(handler, 'POST', '/translate', { items: [{ id: 2, text: spanish, target: 'fr' }] })
    assert.equal(requests, 1, '西语正文发给法语目标必须翻译')

    // 简繁：简体正文 → zh-TW 要请求；繁体正文 → zh-TW 不请求
    requests = 0
    await call(handler, 'POST', '/translate', { items: [{ id: 3, text: simplified, target: 'zh-TW' }] })
    assert.equal(requests, 1, '简体正文发给 zh-TW 必须真的转一次')

    requests = 0
    const tradResult = await call(handler, 'POST', '/translate', {
      items: [{ id: 4, text: traditional, target: 'zh-TW' }],
    })
    assert.equal(tradResult.json.items[0].text, traditional)
    assert.equal(requests, 0, '繁体正文发给 zh-TW 不该再打模型')

    // 日文目标：纯汉字文本不是日文，必须请求（中文正文 → ja）
    requests = 0
    await call(handler, 'POST', '/translate', { items: [{ id: 5, text: simplified, target: 'ja' }] })
    assert.equal(requests, 1, '纯汉字文本发给 ja 必须翻译，不能当「已是日文」')
  } finally {
    globalThis.fetch = originalFetch
    process.env.DSH_HOME = previousHome
    if (previousKey !== undefined) process.env.DEEPSEEK_API_KEY = previousKey
    rmSync(home, { recursive: true, force: true })
  }
})

test('拉丁兄弟语言的草稿不能被当成英文原样放行', async () => {
  // 回归（2026-11-18 实测）：西语草稿 → target en 时被 looksEnglish 的「纯拉丁字母即英文」放过，
  // 原样返回西语；客户端判定「译文不可用」，于是把西语原文直接发给模型。
  const home = mkdtempSync(path.join(tmpdir(), 'shadow-bilingual-drafts-'))
  const previousHome = process.env.DSH_HOME
  const previousKey = process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  process.env.DSH_HOME = home

  let handler = null
  const ctx = {
    webServer: { register(options) { handler = options.handler; } },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }

  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async (_url, options) => {
    requests += 1
    const items = JSON.parse(JSON.parse(options.body).messages[1].content).items
    const content = JSON.stringify({
      items: items.map((item) => ({ id: item.id, text: `The panel does not show the last error (#${item.id}).` })),
    })
    return {
      ok: true,
      status: 200,
      async text() { return JSON.stringify({ choices: [{ message: { content } }] }); },
    }
  }

  try {
    const mod = await import('../lib/index.js')
    mod.apply(ctx)
    await call(handler, 'POST', '/config', { apiKey: 'sk-drafts-1234567890' })

    const spanish = 'El panel no muestra el último error, pero la traducción funciona.'
    const german = 'Das Panel zeigt nicht den letzten Fehler, aber die Übersetzung funktioniert.'

    requests = 0
    const result = await call(handler, 'POST', '/translate', {
      items: [
        { id: 1, text: spanish, target: 'en' },
        { id: 2, text: german, target: 'en' },
      ],
    })
    assert.equal(result.status, 200)
    assert.equal(requests, 1, '西语/德语草稿必须真的翻成英文')
    for (const item of result.json.items) {
      assert.match(item.text, /^The panel/, `${item.id} 应该拿到英文改写，而不是原文`)
    }
  } finally {
    globalThis.fetch = originalFetch
    process.env.DSH_HOME = previousHome
    if (previousKey !== undefined) process.env.DEEPSEEK_API_KEY = previousKey
    rmSync(home, { recursive: true, force: true })
  }
})
