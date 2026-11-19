/**
 * 访问闸门回归测试。
 *
 * 背景：awesome-dsh-plugin 的维护者在 review 时指出，本插件用 `webServer.register`
 * 注册的 HTTP 路由没有走 DSH 的访问检查（`ctx.connection.requestRejection`）。
 * 后果不是「泄露一个掩码 Key」，而是浏览器里任意网页都能 `POST /config` 改写
 * baseURL —— 下一次翻译时用户的 API Key 就会被送到第三方。
 *
 * 这组测试锁住两件事：
 *   1. connection 存在时，未授权请求必须被拒绝，且拒绝发生在任何路由逻辑之前；
 *   2. connection 取不到时（老宿主 / 早期单测）不能崩，但 /health 必须自报 guard:false。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
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
  let json = null
  try {
    json = JSON.parse(res.body)
  } catch {
    json = null
  }
  return { status: res.statusCode, json }
}

/** 建一个记录了 handler 的最小宿主上下文。 */
async function boot({ rejection } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'shadow-bilingual-guard-'))
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

  // rejection === undefined 表示「不装闸门」（模拟老宿主）
  if (rejection !== 'absent') {
    const calls = []
    ctx.connection = {
      requestRejection(req) {
        calls.push(req.url)
        return rejection
      },
    }
    ctx.__rejectionCalls = calls
  }

  const mod = await import('../lib/index.js')
  mod.apply(ctx)

  const cleanup = () => {
    process.env.DSH_HOME = previousHome
    if (previousKey !== undefined) process.env.DEEPSEEK_API_KEY = previousKey
    rmSync(home, { recursive: true, force: true })
  }

  return { handler, ctx, cleanup }
}

test('unauthenticated requests are rejected before any route runs', async () => {
  const { handler, ctx, cleanup } = await boot({ rejection: 401 })
  try {
    // 最危险的一条：改写 baseURL，之后 Key 会被送到攻击者端点
    const config = await call(handler, 'POST', '/config', {
      baseURL: 'https://attacker.example.com',
      apiKey: 'sk-attacker',
    })
    assert.equal(config.status, 401, 'POST /config 必须被拒绝')
    assert.equal(config.json.ok, false)
    assert.equal(config.json.code, 'UNAUTHORIZED')

    // 读取类也不行
    const read = await call(handler, 'GET', '/config')
    assert.equal(read.status, 401)
    assert.equal(read.json.ok, false)

    // 花钱的翻译接口
    const translate = await call(handler, 'POST', '/translate', {
      items: [{ id: 1, text: '你好', target: 'en' }],
    })
    assert.equal(translate.status, 401)

    // /health 也一并挡掉：它本来会泄露 hasKey / keySource
    const health = await call(handler, 'GET', '/health')
    assert.equal(health.status, 401)

    assert.ok(ctx.__rejectionCalls.length >= 4, '每个请求都应先过 requestRejection')
  } finally {
    cleanup()
  }
})

test('403 from the host is surfaced as FORBIDDEN, not swallowed', async () => {
  const { handler, cleanup } = await boot({ rejection: 403 })
  try {
    const result = await call(handler, 'POST', '/config', { model: 'x' })
    assert.equal(result.status, 403)
    assert.equal(result.json.code, 'FORBIDDEN')
  } finally {
    cleanup()
  }
})

test('authorized requests still work when the host allows them', async () => {
  const { handler, cleanup } = await boot({ rejection: undefined })
  try {
    const health = await call(handler, 'GET', '/health')
    assert.equal(health.status, 200)
    assert.equal(health.json.ok, true)
    // 闸门接上了就必须自报 true，便于升级后一眼确认没被静默降级
    assert.equal(health.json.guard, true)
  } finally {
    cleanup()
  }
})

test('a host without a connection service degrades safely and says so', async () => {
  const { handler, cleanup } = await boot({ rejection: 'absent' })
  try {
    const health = await call(handler, 'GET', '/health')
    // 不崩，但必须明说闸门没接上
    assert.equal(health.status, 200)
    assert.equal(health.json.guard, false)
  } finally {
    cleanup()
  }
})
