#!/usr/bin/env node
/**
 * 逐语言自检：对正在运行的宿主逐个显示语言发一次 /translate，判断真的翻译了。
 *
 * 为什么要这个脚本：显示语言有 18 种，客户端只会用到当前选中的那一种，
 * 单测和离线探针都覆盖不到「装好的宿主是不是真的在翻」。这个脚本不打补丁、
 * 不发信号，只发 HTTP 请求。
 *
 * 退出码：0 = 全部通过 / 2 = 宿主没在跑或没装本插件 / 1 = 有语言没通过。
 *
 * 用法：node scripts/check-languages.mjs [--port 55340]
 */

import { execFileSync } from 'node:child_process'

const API = '/api/shadow-bilingual'
const SAMPLE =
  'The crash dialog showed the string 应用无法启动或已意外停止, which came from the host stderr tail. ' +
  'The panel keeps the error message and the retry button together.'

/** 18 种显示语言：值是「翻译成功后必须出现的字符」检验方式。 */
const TARGETS = [
  ['zh', 'han'],
  ['zh-TW', 'trad'],
  ['ja', 'kana'],
  ['ko', 'hangul'],
  ['es', 'latin-changed'],
  ['fr', 'latin-changed'],
  ['de', 'latin-changed'],
  ['pt', 'latin-changed'],
  ['ru', 'cyrillic'],
  ['it', 'latin-changed'],
  ['nl', 'latin-changed'],
  ['pl', 'latin-changed'],
  ['tr', 'latin-changed'],
  ['ar', 'arabic'],
  ['hi', 'devanagari'],
  ['th', 'thai'],
  ['vi', 'latin-changed'],
  ['id', 'latin-changed'],
]

const RE = {
  han: /[\u3400-\u9fff]/,
  kana: /[\u3040-\u309f\u30a0-\u30ff]/,
  hangul: /[\uac00-\ud7af]/,
  cyrillic: /[\u0400-\u04ff]/,
  arabic: /[\u0600-\u06ff]/,
  devanagari: /[\u0900-\u097f]/,
  thai: /[\u0e00-\u0e7f]/,
  trad: /[這個們進學國說時對為與關開發還會讓樣點產區嚴選總認識語譯話龍麼後來問見現實際應該無係東車書寫讀聽獨]/,
}

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(2)
}

function detectPort(explicit) {
  if (explicit) return explicit
  let pid
  try {
    const ps = execFileSync('ps', ['ax', '-o', 'pid=,command='], { encoding: 'utf8' })
    const line = ps.split('\n').find((row) => row.includes('dsh-desktop-host/lib/index.js'))
    if (line) pid = Number(line.trim().split(/\s+/)[0])
  } catch {
    /* ignore */
  }
  if (!pid) return null
  try {
    const lsof = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)], { encoding: 'utf8' })
    const ports = [...lsof.matchAll(/:(\d+) \(LISTEN\)/g)].map((m) => Number(m[1]))
    return ports.length > 0 ? ports : []
  } catch {
    return null
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const portIndex = argv.indexOf('--port')
  const explicit = portIndex >= 0 ? Number(argv[portIndex + 1]) : null

  const detected = detectPort(explicit)
  if (detected === null) fail('找不到正在运行的 dsh 宿主进程（dsh-desktop-host/lib/index.js）——应用没开着？')
  const ports = Array.isArray(detected) ? detected : [detected]

  let base = null
  let health = null
  for (const port of ports) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${API}/health`, { signal: AbortSignal.timeout(4000) })
      if (!res.ok) continue
      const body = await res.json()
      if (body && body.ok === true) {
        base = `http://127.0.0.1:${port}`
        health = body
        break
      }
    } catch {
      /* next port */
    }
  }
  if (!base) fail(`宿主在跑，但端口 ${ports.join('/')} 上没有本插件的 /health——插件没装或没启用。`)

  console.log(`host ${base}  logic=${health.logic ?? '?'}  hasKey=${health.hasKey}`)
  if (health.hasKey !== true) fail('宿主没有可用的 Key，先把 设置 → 双语 里的 Key 填上。')

  const failures = []
  for (const [target, check] of TARGETS) {
    const started = Date.now()
    let body
    try {
      const res = await fetch(`${base}${API}/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ id: 1, text: SAMPLE, target }] }),
        signal: AbortSignal.timeout(90000),
      })
      body = await res.json()
      if (!res.ok || body.ok !== true) throw new Error(`HTTP ${res.status} ${JSON.stringify(body).slice(0, 120)}`)
    } catch (error) {
      failures.push([target, `请求失败：${error.message}`])
      console.log(`✗ ${target.padEnd(6)} ${Date.now() - started}ms  ${error.message}`)
      continue
    }
    const text = String(body.items?.[0]?.text ?? '')
    const ms = Date.now() - started
    if (text.trim() === SAMPLE) {
      failures.push([target, '原样返回，没有翻译'])
      console.log(`✗ ${target.padEnd(6)} ${ms}ms  原样返回（没翻译）`)
      continue
    }
    if (check === 'latin-changed') {
      if (text.trim() !== SAMPLE && /[A-Za-z]/.test(text)) {
        console.log(`✓ ${target.padEnd(6)} ${ms}ms  ${text.slice(0, 46)}…`)
      } else {
        failures.push([target, '返回内容不是另一种语言'])
        console.log(`✗ ${target.padEnd(6)} ${ms}ms  返回内容不可判定`)
      }
      continue
    }
    if (!RE[check].test(text)) {
      failures.push([target, `译文里没有出现预期的 ${check} 字符`])
      console.log(`✗ ${target.padEnd(6)} ${ms}ms  译文缺少 ${check}`)
      continue
    }
    console.log(`✓ ${target.padEnd(6)} ${ms}ms  ${text.slice(0, 46)}…`)
  }

  console.log('')
  if (failures.length > 0) {
    console.error(`✗ ${failures.length}/${TARGETS.length} 种显示语言没通过：`)
    for (const [target, reason] of failures) console.error(`   - ${target}: ${reason}`)
    console.error('   宿主是旧代码的话，正常退出应用再重开（不要 kill 进程）。')
    process.exit(1)
  }
  console.log(`✅ ${TARGETS.length}/${TARGETS.length} 种显示语言都能翻译`)
}

main().catch((error) => fail(error.stack || String(error)))
