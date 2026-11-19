/**
 * shadow-bilingual —— 宿主半：DeepSeek 翻译代理 + 配置 API。
 *
 * 为什么翻译要放在宿主：
 *   1. API Key 不进浏览器（不暴露在页面/网络面板里）；
 *   2. 浏览器直连 api.deepseek.com 会被 CORS 拦住；
 *   3. 宿主可以统一做超时、批量、错误归一化。
 *
 * 只注册同源前缀路由 `/api/shadow-bilingual/*`；浏览器半侧用普通 fetch 调用。
 */

import { appendFile, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'shadow-bilingual'

/** webServer 是唯一硬依赖；没有它浏览器半侧拿不到译文。 */
export const inject = ['webServer', 'connection']

const API_PREFIX = '/api/shadow-bilingual'
const MAX_BODY_BYTES = 256 * 1024
const MAX_ITEMS = 24
const MAX_TEXT_CHARS = 6000
const BATCH_SIZE = 3

const DEFAULTS = Object.freeze({
  apiKey: '',
  model: 'deepseek-chat',
  baseURL: 'https://api.deepseek.com',
  timeoutMs: 60000,
  forceEnglish: true,
  // 本地显示语言。AI 侧固定英文；这个值只决定「给用户看的对照译文」用哪种语言。
  localLanguage: 'zh',
})

/**
 * 支持的目标语言。key 与客户端 LOCAL_LANGUAGES 一致。
 *
 * 只有非拉丁书写系统的语言能做字符级硬校验；拉丁字母语言之间
 * （es/fr/de/…）模型自己不会串，我们也没法靠字符集区分，只好放过。
 */
const TARGET_LANGUAGES = Object.freeze({
  zh: { name: 'Simplified Chinese', script: 'zh' },
  'zh-TW': { name: 'Traditional Chinese (Taiwan / Hong Kong)', script: 'zh' },
  ja: { name: 'Japanese', script: 'ja' },
  ko: { name: 'Korean', script: 'ko' },
  es: { name: 'Spanish', script: 'latin' },
  fr: { name: 'French', script: 'latin' },
  de: { name: 'German', script: 'latin' },
  pt: { name: 'Portuguese', script: 'latin' },
  ru: { name: 'Russian', script: 'ru' },
  it: { name: 'Italian', script: 'latin' },
  nl: { name: 'Dutch', script: 'latin' },
  pl: { name: 'Polish', script: 'latin' },
  tr: { name: 'Turkish', script: 'latin' },
  ar: { name: 'Arabic', script: 'ar' },
  hi: { name: 'Hindi', script: 'hi' },
  th: { name: 'Thai', script: 'th' },
  vi: { name: 'Vietnamese', script: 'latin' },
  id: { name: 'Indonesian', script: 'latin' },
})

const DEFAULT_LOCAL_LANGUAGE = 'zh'

function normalizeLocalLanguage(value) {
  const text = String(value || '').trim()
  if (text === '') return DEFAULT_LOCAL_LANGUAGE
  if (TARGET_LANGUAGES[text] !== undefined) return text
  // 大小写 / 下划线宽容：zh-tw、zh_TW → zh-TW
  const guess = Object.keys(TARGET_LANGUAGES).find(
    (code) => code.toLowerCase() === text.toLowerCase().replace(/_/g, '-'),
  )
  return guess === undefined ? DEFAULT_LOCAL_LANGUAGE : guess
}

let config = { ...DEFAULTS }
let configPath = ''

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function defaultConfigPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'shadow-bilingual.json')
}

function normalizeBaseURL(value) {
  const text = String(value || '').trim()
  if (text === '') return DEFAULTS.baseURL
  let url
  try {
    url = new URL(text)
  } catch {
    throw new HttpError(400, 'Base URL 不是合法 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpError(400, 'Base URL 只支持 http/https')
  return text.replace(/\/+$/, '')
}

function normalizeModel(value) {
  const text = String(value || '').trim()
  if (text === '') return DEFAULTS.model
  if (text.length > 120) throw new HttpError(400, '模型名过长')
  return text
}

function normalizeTimeout(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULTS.timeoutMs
  return Math.max(5000, Math.min(180000, Math.round(n)))
}

function loadConfigSync() {
  configPath = defaultConfigPath()
  try {
    const raw = readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return
    if (typeof parsed.apiKey === 'string') config.apiKey = parsed.apiKey
    if (typeof parsed.model === 'string' && parsed.model.trim() !== '') config.model = parsed.model.trim()
    if (typeof parsed.baseURL === 'string' && parsed.baseURL.trim() !== '') {
      try {
        config.baseURL = normalizeBaseURL(parsed.baseURL)
      } catch {
        config.baseURL = DEFAULTS.baseURL
      }
    }
    if (parsed.timeoutMs !== undefined) config.timeoutMs = normalizeTimeout(parsed.timeoutMs)
    if (typeof parsed.forceEnglish === 'boolean') config.forceEnglish = parsed.forceEnglish
    if (parsed.localLanguage !== undefined) config.localLanguage = normalizeLocalLanguage(parsed.localLanguage)
  } catch {
    // 文件不存在 / 损坏 → 保持默认；绝不让配置阻断启动
  }
}

async function persistConfig() {
  await mkdir(path.dirname(configPath), { recursive: true })
  const tmp = `${configPath}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  await rename(tmp, configPath)
  try {
    await chmod(configPath, 0o600)
  } catch {
    // Windows 上 chmod 基本无效；失败不阻断
  }
}

function effectiveKey() {
  const fromConfig = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
  if (fromConfig !== '') return { key: fromConfig, source: 'plugin' }
  const fromEnv = typeof process.env.DEEPSEEK_API_KEY === 'string' ? process.env.DEEPSEEK_API_KEY.trim() : ''
  if (fromEnv !== '') return { key: fromEnv, source: 'env' }
  return { key: '', source: 'none' }
}

/**
 * DSH 的凭据服务（可选）。存在时优先复用 `DEEPSEEK_API_KEY`，用户不必再贴一遍。
 *
 * 注意：**不能**在 apply() 里取一次就存下来。插件可能是在应用启动之后被
 * plugin_manager 中途挂载的，那一刻 credentials 服务未必已经就绪；缓存 null
 * 会让 hasKey 永远为 false、翻译整个不可用（实测踩过）。所以每次调用现取。
 */
let hostContext = null

function credentialsService() {
  const ctx = hostContext
  if (ctx === null) return null
  try {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get('credentials')
      if (viaGet !== null && viaGet !== undefined) return viaGet
    }
    return ctx.credentials ?? null
  } catch {
    return null
  }
}

async function resolveKey(override) {
  if (typeof override === 'string' && override.trim() !== '') return { key: override.trim(), source: 'request' }
  const local = effectiveKey()
  if (local.key !== '') return local
  try {
    const credentials = credentialsService()
    if (credentials !== null && typeof credentials.resolve === 'function') {
      const hit = await credentials.resolve('DEEPSEEK_API_KEY')
      if (hit !== null && hit !== undefined && typeof hit.value === 'string' && hit.value.trim() !== '') {
        return { key: hit.value.trim(), source: 'credentials' }
      }
    }
  } catch {
    // 凭据服务不可用 → 当作未配置
  }
  return { key: '', source: 'none' }
}

function maskKey(key) {
  if (key === '') return ''
  if (key.length <= 8) return `${key.slice(0, 2)}…${key.slice(-2)}`
  return `${key.slice(0, 3)}…${key.slice(-4)}`
}

async function publicConfig() {
  const current = await resolveKey()
  return {
    ok: true,
    hasKey: current.key !== '',
    keySource: current.source,
    keyHint: maskKey(current.key),
    model: config.model,
    baseURL: config.baseURL,
    timeoutMs: config.timeoutMs,
    forceEnglish: config.forceEnglish !== false,
    localLanguage: normalizeLocalLanguage(config.localLanguage),
    localLanguages: Object.keys(TARGET_LANGUAGES).map((code) => ({ code, label: TARGET_LANGUAGES[code].name })),
    configPath,
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  const bytes = Buffer.from(text, 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.length),
    'cache-control': 'no-store',
  })
  res.end(bytes)
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        req.destroy()
        reject(new HttpError(413, '请求体过大'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text.trim() === '' ? {} : JSON.parse(text))
      } catch {
        reject(new HttpError(400, '请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function parseJsonLoose(value) {
  let text = String(value === null || value === undefined ? '' : value).trim()
  if (text === '') return null
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  try {
    return JSON.parse(text)
  } catch {
    // 继续尝试截取
  }
  const objectStart = text.indexOf('{')
  const objectEnd = text.lastIndexOf('}')
  if (objectStart !== -1 && objectEnd > objectStart) {
    try {
      return JSON.parse(text.slice(objectStart, objectEnd + 1))
    } catch {
      // 继续
    }
  }
  const arrayStart = text.indexOf('[')
  const arrayEnd = text.lastIndexOf(']')
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    try {
      return JSON.parse(text.slice(arrayStart, arrayEnd + 1))
    } catch {
      // 放弃
    }
  }
  return null
}

function extractItems(parsed) {
  if (parsed === null || parsed === undefined) return null
  if (Array.isArray(parsed)) return parsed
  if (Array.isArray(parsed.items)) return parsed.items
  if (Array.isArray(parsed.translations)) return parsed.translations
  if (Array.isArray(parsed.results)) return parsed.results
  if (parsed.items !== null && typeof parsed.items === 'object') {
    return Object.keys(parsed.items).map((key) => ({ id: key, text: parsed.items[key] }))
  }
  return null
}

function normalizeItems(body) {
  const raw = Array.isArray(body?.items) ? body.items : null
  if (raw === null || raw.length === 0) throw new HttpError(400, 'items 不能为空')
  if (raw.length > MAX_ITEMS) throw new HttpError(400, `一次最多 ${MAX_ITEMS} 段`)
  return raw.map((item, index) => {
    const text = String(item?.text ?? '').trim()
    if (text === '') throw new HttpError(400, `第 ${index + 1} 段没有文本`)
    if (text.length > MAX_TEXT_CHARS) throw new HttpError(400, `第 ${index + 1} 段超过 ${MAX_TEXT_CHARS} 字`)
    // 'en' 是 AI 侧目标（输入/队列/插话）；其余任意已知语言码是显示侧目标
    const raw = String(item?.target ?? '').trim()
    const target = raw === 'en' ? 'en' : normalizeLocalLanguage(raw)
    return {
      id: Number.isInteger(item?.id) ? item.id : index + 1,
      text,
      target,
    }
  })
}

/**
 * 翻译上下文：一小段最近对话，用来给专有名词/技术术语定锚。
 *
 * 用户需求（m01409）：译名要一致，不要因为缺少上下文把术语译歪；
 * 但不能塞太多，否则每条都烧 token。客户端已经截到 ~600 字符，这里再兜一次底。
 */
const CONTEXT_MAX_CHARS = 800

function normalizeContext(value) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\r/g, '').trim()
  if (text === '') return ''
  return text.length > CONTEXT_MAX_CHARS ? text.slice(0, CONTEXT_MAX_CHARS) : text
}

function chunk(array, size) {
  const out = []
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size))
  return out
}

const LANGUAGE_LIST = Object.keys(TARGET_LANGUAGES)
  .map((code) => {
    const spec = TARGET_LANGUAGES[code]
    return code === 'en' ? 'en = natural English' : `${code} = ${spec.name}`
  })
  .join(', ')

const SYSTEM_PROMPT = [
  'You are a professional bilingual translator for the DeepSeek Harness chat UI.',
  'Each item carries its own target language code. Translate every item into exactly that target language.',
  `Supported target codes: ${LANGUAGE_LIST}.`,
  'Two kinds of target appear: "en" is what the AI reads (user input is rewritten into English before sending); any other code is the human-facing display language (the English assistant reply gets a translation underneath).',
  'zh-TW means Traditional Chinese as written in Taiwan / Hong Kong — use traditional characters and local vocabulary, never simplified.',
  'Return ONLY a JSON object in this exact shape: {"items":[{"id":1,"text":"..."}]}.',
  'Keep every id exactly once and in the original order.',
  'Every id must be returned, including short headings, labels and list-item text; never return an empty string.',
  'Preserve Markdown inline formatting: **bold**, *italic*, `code`, [links](url), $math$, and line breaks.',
  'For table items, preserve the Markdown table structure (header row, separator row, pipe columns) and translate each cell; keep the same rows and columns.',
  'Do NOT add heading markers (#), bullet markers (-, *), numbering, surrounding quotes, or explanations.',
  'Keep code, file paths, URLs, formulas, product names and technical terms unchanged.',
  'Translate the full meaning naturally; never summarize or omit anything.',
  'If a segment is already in the target language, return it unchanged.',
  'The request may include a "context" field: a short excerpt of the recent conversation. Use it ONLY to keep terminology consistent (proper nouns, technical terms, product names, identifiers); never translate the context itself and never repeat it in the output.',
  'When a term already appears in the context with an established translation, reuse that exact translation.',
].join('\n')

const SCRIPT_TEST = {
  zh: /[\u3400-\u9fff]/,
  ja: /[\u3040-\u309f\u30a0-\u30ff\u3400-\u9fff]/,
  ko: /[\uac00-\ud7af]/,
  ru: /[\u0400-\u04ff]/,
  ar: /[\u0600-\u06ff]/,
  hi: /[\u0900-\u097f]/,
  th: /[\u0e00-\u0e7f]/,
  latin: /[A-Za-z\u00c0-\u024f]/,
}

/** 计数用的同一批正则（全局）：判「占比」要数条数，不能只用 test() 判有无。 */
const SCRIPT_COUNT = {
  zh: /[\u3400-\u9fff]/g,
  ja: /[\u3040-\u309f\u30a0-\u30ff\u3400-\u9fff]/g,
  ko: /[\uac00-\ud7af]/g,
  ru: /[\u0400-\u04ff]/g,
  ar: /[\u0600-\u06ff]/g,
  hi: /[\u0900-\u097f]/g,
  th: /[\u0e00-\u0e7f]/g,
  latin: /[A-Za-z\u00c0-\u024f]/g,
}

function countScript(text, script) {
  const regex = SCRIPT_COUNT[script]
  if (regex === undefined) return 0
  const matches = String(text).match(regex)
  return matches === null ? 0 : matches.length
}

const HAS_LETTER = /\p{L}/u

/** 拉丁字母是否占主导（目标英文时用来拒掉「回了大段中日韩」）。 */
function latinDominant(text) {
  const foreign = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length
  const latin = (text.match(/[A-Za-z]/g) || []).length
  return latin >= 2 && latin >= foreign * 1.5
}

/**
 * 英语高频虚词（与 lib/markdown.cjs 的 ENGLISH_HINTS 保持同一份）。
 * 判「这段英文是不是已经在用英文写」时用：光看拉丁字母数量会被标识符骗过去，
 * 「帮我装插件hermes-loop」这种中文句子，hermes-loop 就贡献了 10 个拉丁字母。
 * 单字母 a / i 故意不算，避免中文标题里的编号被误判。
 */
const ENGLISH_HINTS = [
  'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'and', 'or', 'but', 'if', 'then', 'than',
  'that', 'this', 'these', 'those', 'which', 'who', 'whom', 'whose', 'what', 'when', 'where', 'why', 'how',
  'of', 'to', 'in', 'on', 'at', 'for', 'with', 'without', 'from', 'by', 'as', 'it', 'its', 'we', 'you',
  'they', 'he', 'she', 'not', 'no', 'can', 'will', 'would', 'should', 'could', 'do', 'does', 'did',
  'have', 'has', 'had', 'there', 'their', 'our', 'your', 'my', 'me', 'them', 'us', 'about', 'into',
  'over', 'after', 'before', 'because', 'so', 'also', 'only', 'just', 'more', 'most', 'some', 'any',
  'all', 'one', 'two', 'new', 'use', 'used', 'using', 'while', 'see', 'get', 'got', 'make', 'made',
  'need', 'needs', 'want', 'like', 'well', 'still', 'even', 'up', 'out', 'back', 'now', 'here',
]
// 反查表：判拉丁语系时要跳过英文虚词，否则 "help me … help me" 这种英文句会被算成西语。
const ENGLISH_HINT_SET = new Set(ENGLISH_HINTS)

/** 命中的英语虚词条数（按非字母切词、小写比较）。 */
function englishWordHits(text) {
  const tokens = String(text).toLowerCase().split(/[^a-z]+/)
  let hits = 0
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] !== '' && ENGLISH_HINTS.indexOf(tokens[i]) !== -1) hits += 1
  }
  return hits
}

/**
 * 原文是不是已经用英文在写（目标语言 en 专用）。
 *
 * 旧判据只看 latinDominant：拉丁字母够多就算英文。于是
 * 「帮我装插件hermes-loop」（latin 10 / foreign 5）被判成「已经是英文」→ 原样退回，
 * 客户端拿到「译文 == 原文」判为无效 → 发送闸门反复吞掉 Enter。
 *
 * 新判据：有中日韩文字时，必须再命中两个以上英语虚词，才算英文正文；
 * 纯拉丁文本（foreign === 0）才可以直接放过。
 */
function looksEnglish(text) {
  if (typeof text !== 'string') return false
  const latin = countScript(text, 'latin')
  if (latin < 2) return false
  const foreign = countScript(text, 'zh') + countScript(text, 'ja') + countScript(text, 'ko')
  if (foreign === 0) {
    // 纯拉丁字母也可能是西语/法语/德语…：认出兄弟语言就不能当成英文，
    // 否则用户用西语打的草稿会被「已经是英文」放过、原样发给模型。
    return detectLatinLanguage(text) === null
  }
  return englishWordHits(text) >= 2 && latinDominant(text)
}

/**
 * 假名 / 简繁判别用的辅助表。
 *
 * 日文正文里本来就有汉字，所以「有汉字」不能判成日文；反过来「有假名」一定是日文。
 * 显示语言选 zh 还是 zh-TW 时，也得先知道原文已经是哪一种，否则简体永远换不成繁体。
 */
const KANA_TEST = /[\u3040-\u309f\u30a0-\u30ff]/

const TRAD_ONLY = '這個們進學國說時對為與關開發還會讓樣點產區嚴選總認識語譯話龍麼後來問見現實際應該無係東車書寫讀聽獨'
const SIM_ONLY = '这个们进学国说时对为与关开发还会让样产区严选总认识语译话龙么后来问见现实际应该无系东车书写读听独'

/** 汉字为主的文本是不是繁体（繁体字命中多于简体字）。 */
function looksTraditional(text) {
  const src = String(text)
  let trad = 0
  let sim = 0
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (TRAD_ONLY.indexOf(ch) !== -1) trad += 1
    else if (SIM_ONLY.indexOf(ch) !== -1) sim += 1
  }
  return trad > sim
}

/**
 * 拉丁字母语言（es / fr / de / pt / it / nl / pl / tr / vi / id）共用同一套字母，
 * 光看书写系统分不开，这里用与 lib/markdown.cjs 完全相同的一份高频虚词表来猜。
 *
 * 为什么要猜：旧逻辑只要看到拉丁字母就认为「原文已经是目标语言」，
 * 于是英文正文发给 es/fr/de/… 时被整段 passthrough 成「译文 == 原文」，
 * 10 种拉丁字母显示语言全都拿不到译文（2026-11-18 实测 18 种语言里 10 种失效）。
 */
const LATIN_HINTS = {
  es: ['el', 'los', 'las', 'que', 'por', 'para', 'con', 'una', 'del', 'como', 'más', 'pero', 'esta', 'este', 'hay', 'muy', 'sin', 'sobre', 'también', 'cuando', 'porque', 'qué', 'cómo', 'está', 'son', 'tiene', 'puedes', 'hola', 'gracias', 'esto', 'eso', 'no', 'es', 'están', 'estos', 'estas', 'entre', 'hasta', 'desde', 'sólo', 'solo', 'aquí', 'de', 'la', 'un', 'en', 'al'],
  fr: ['le', 'les', 'des', 'du', 'et', 'une', 'est', 'que', 'qui', 'pour', 'pas', 'vous', 'nous', 'avec', 'dans', 'sur', 'au', 'ce', 'cette', 'ces', 'sont', 'plus', 'mais', 'ou', 'il', 'elle', 'je', 'tu', 'se', 'son', 'sa', 'bonjour', 'merci', 'être', 'fait', 'tout', 'très', 'bien', 'ici', 'aussi', 'encore', 'cet', 'votre', 'notre', 'leur', 'peut', 'doit', 'tous', 'de', 'la', 'un', 'en', 'aux'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'zu', 'den', 'mit', 'sich', 'des', 'auf', 'für', 'im', 'dem', 'werden', 'wird', 'auch', 'als', 'noch', 'bei', 'oder', 'aus', 'wie', 'wenn', 'nur', 'kann', 'danke', 'hallo', 'bitte', 'sehr', 'diese', 'dieser', 'dieses', 'kein', 'keine', 'keinen', 'denn', 'doch', 'über', 'unter', 'nach', 'vor', 'zum', 'zur', 'vom', 'beim', 'durch', 'gegen', 'ohne', 'sind', 'war', 'hat', 'haben', 'können', 'müssen', 'soll', 'hier', 'dort', 'jetzt', 'immer'],
  pt: ['os', 'as', 'do', 'da', 'que', 'em', 'um', 'uma', 'para', 'com', 'por', 'na', 'mais', 'como', 'mas', 'foi', 'são', 'dos', 'das', 'ao', 'ele', 'ela', 'isso', 'você', 'obrigado', 'olá', 'muito', 'está', 'tem', 'não', 'é', 'estamos', 'há', 'estão', 'este', 'esta', 'estes', 'estas', 'sem', 'sobre', 'entre', 'até', 'desde', 'também', 'aqui', 'de', 'la', 'un', 'o'],
  it: ['il', 'lo', 'gli', 'le', 'di', 'del', 'che', 'un', 'una', 'per', 'con', 'non', 'da', 'su', 'al', 'come', 'più', 'ma', 'è', 'sono', 'questo', 'questa', 'questi', 'queste', 'anche', 'quando', 'perché', 'ciao', 'grazie', 'molto', 'bene', 'senza', 'sopra', 'tra', 'nel', 'nello', 'nella', 'ci', 'si', 'ancora', 'solo', 'dove', 'e', 'in'],
  nl: ['het', 'een', 'van', 'op', 'te', 'dat', 'die', 'niet', 'zijn', 'voor', 'met', 'aan', 'er', 'maar', 'om', 'ook', 'als', 'dan', 'bij', 'uit', 'kan', 'worden', 'deze', 'dit', 'geen', 'wel', 'nog', 'al', 'naar', 'door', 'over', 'onder', 'tussen', 'de', 'in', 'is'],
  pl: ['w', 'na', 'do', 'nie', 'się', 'jest', 'że', 'jak', 'po', 'co', 'tak', 'ale', 'od', 'za', 'przez', 'dla', 'oraz', 'już', 'tylko', 'może', 'jestem', 'dziękuję', 'cześć', 'to', 'ten', 'ta', 'te', 'być', 'ma', 'mają', 'ich', 'jego', 'jej', 'z'],
  tr: ['bir', 'için', 'ile', 'var', 'gibi', 'daha', 'çok', 'ama', 'veya', 'kadar', 'sonra', 'her', 'şey', 'olarak', 'değil', 'ben', 'sen', 'bu', 'şu', 'merhaba', 'teşekkür', 'lütfen', 've', 'ne', 'en', 'çünkü', 'nasıl', 'neden', 'şimdi', 'burada', 'yok', 'ki', 'mi', 'da', 'de'],
  vi: ['và', 'của', 'là', 'có', 'không', 'được', 'trong', 'người', 'những', 'cho', 'một', 'các', 'đã', 'này', 'với', 'để', 'khi', 'từ', 'như', 'hay', 'chào', 'cảm', 'ơn', 'thì', 'mà', 'nên', 'rồi', 'đang', 'sẽ', 'phải'],
  id: ['yang', 'dan', 'itu', 'ini', 'dengan', 'untuk', 'tidak', 'dari', 'dalam', 'akan', 'pada', 'juga', 'saya', 'kamu', 'bisa', 'sudah', 'karena', 'atau', 'lebih', 'terima', 'kasih', 'halo', 'ada', 'adalah', 'ke', 'di', 'nya', 'belum', 'harus'],
}


function detectLatinLanguage(text) {
  const plain = String(text).toLowerCase()
  if (plain.trim() === '') return null
  // 强信号：西语倒问号/倒叹号、德语 ß、葡语 ã/õ、越南语声调符号
  if (/[¿¡]/.test(plain)) return 'es'
  if (/ß/.test(plain)) return 'de'
  if (/[ãõ]/.test(plain)) return 'pt'
  if (/[ăâđêôơư]/i.test(plain)) return 'vi'
  const tokens = plain.split(/[^a-z\u00c0-\u024f]+/)
  let best = ''
  let bestScore = 0
  let secondScore = 0
  for (const code of Object.keys(LATIN_HINTS)) {
    const hints = LATIN_HINTS[code]
    let score = 0
    for (const token of tokens) {
      if (token === '' || ENGLISH_HINT_SET.has(token)) continue
      if (hints.indexOf(token) !== -1) score += 1
    }
    if (score > bestScore) {
      secondScore = bestScore
      bestScore = score
      best = code
    } else if (score > secondScore) {
      secondScore = score
    }
  }
  // 只有一个命中、或两个语言打平，都不足以断定「这是别的语言」：
  // 宁可当成英文（调用方会继续当英文处理），也不能把英文误判成西语。
  if (bestScore < 2 || bestScore <= secondScore) return null
  return best
}

/**
 * 原文是否已经是目标语言。
 *
 * 两种情况要用它：
 *   1. 翻译前先筛：已经是对应语言就不必再问模型（省一次请求，也不会自激重试）；
 *   2. 校验「模型原样返回」：只有原文本来就是目标语言时，原样返回才是对的译文。
 *
 * 拉丁字母语言之间（es/fr/de/…）字符集分不开，必须先猜出原文到底是哪一种；
 * 「有拉丁字母就放过」会让 10 种拉丁字母显示语言全部不翻译（2026-11-18 实测）。
 * 汉字也不能「有汉字就算」：日文有汉字、简繁也是两种不同目标，都要分开判。
 */
function alreadyInTarget(text, target) {
  if (typeof text !== 'string' || text.trim() === '') return false
  const key = String(target || 'en')
  // en 是特殊目标：不在 TARGET_LANGUAGES 里（它只列「显示语言」）。
  if (key === 'en') return looksEnglish(text)
  const spec = TARGET_LANGUAGES[key]
  if (spec === undefined) return false
  const latin = countScript(text, 'latin')

  // 拉丁字母目标语言：必须真的认出原文就是这一种，不能「有字母就算」。
  if (spec.script === 'latin') {
    if (latin === 0) return false
    return detectLatinLanguage(text) === key
  }

  // 中文：日文里也有汉字，先按假名排除；再按简繁区分 zh / zh-TW。
  if (key === 'zh' || key === 'zh-TW') {
    if (KANA_TEST.test(text)) return false
    const han = countScript(text, 'zh')
    if (han === 0) return false
    if (han / (han + latin) < 0.3) return false
    return key === 'zh' ? !looksTraditional(text) : looksTraditional(text)
  }

  // 日文：没有假名的纯汉字文本不是日文（大概率是中文）。
  if (key === 'ja') {
    if (!KANA_TEST.test(text)) return false
    const own = countScript(text, 'ja')
    return own / (own + latin) >= 0.3
  }

  // 其余（ko / ru / ar / hi / th）：按目标文字在「目标文字 + 拉丁字母」里的占比判。
  const own = countScript(text, spec.script)
  if (own === 0) return false
  if (latin === 0) return true
  return own / (own + latin) >= 0.3
}

function validTranslationText(text, target, source) {
  if (typeof text !== 'string' || text.trim() === '') return false
  if (typeof source === 'string' && source.trim() !== '') {
    if (text.replace(/\s+/g, ' ').trim() === source.replace(/\s+/g, ' ').trim()) {
      // 原样返回只有两种算有效：原文本来就是目标语言（助手这次就用中文回答），
      // 或原文没有任何可译的字母（"—"、"1)"、"😀"）。其余说明模型没干活，拒掉。
      return alreadyInTarget(source, target) || !HAS_LETTER.test(source)
    }
  }
  const key = String(target || 'en')
  const script = TARGET_LANGUAGES[key]?.script ?? 'latin'
  if (!SCRIPT_TEST[script].test(text)) return false
  if (key === 'en') return looksEnglish(text)
  return true
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function logTranslationError(status, message) {
  try {
    const file = path.join(path.dirname(configPath || defaultConfigPath()), 'shadow-bilingual-errors.log')
    await appendFile(file, `${new Date().toISOString()} status=${status} ${message}\n`, 'utf8')
  } catch {
    // 日志失败不影响翻译
  }
}

async function requestDeepSeek(url, payload, key) {
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(config.timeoutMs),
      })
    } catch (error) {
      const reason = String(error?.message || error)
      lastError = /timeout|abort/i.test(reason)
        ? new HttpError(504, `DeepSeek 请求超时（${Math.round(config.timeoutMs / 1000)} 秒）`)
        : new HttpError(502, `无法连接 DeepSeek：${reason}`)
      if (attempt < 2 && !/timeout|abort/i.test(reason)) {
        await sleep(600 * (attempt + 1))
        continue
      }
      throw lastError
    }

    const raw = await response.text()
    if (response.ok) return raw

    let detail = raw.slice(0, 500)
    try {
      const parsed = JSON.parse(raw)
      detail = parsed?.error?.message || parsed?.message || detail
    } catch {
      // 保留原文
    }
    if (response.status === 401) throw new HttpError(401, `API Key 无效或与当前通道不匹配（${new URL(url).host}）`)
    if (response.status === 402) throw new HttpError(402, `当前通道账户余额不足（${new URL(url).host}）`)

    lastError = new HttpError(
      response.status === 429 ? 429 : 502,
      `DeepSeek 返回 ${response.status}：${detail}`,
    )
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await sleep(800 * (attempt + 1))
      continue
    }
    throw lastError
  }
  throw lastError || new HttpError(502, 'DeepSeek 请求失败')
}

async function callDeepSeek(key, items, override = {}, context = '') {
  const baseURL = normalizeBaseURL(override.baseURL || config.baseURL)
  const model = normalizeModel(override.model || config.model)
  const url = `${baseURL}/chat/completions`
  const payload = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: JSON.stringify(context === '' ? { items } : { items, context }),
      },
    ],
    temperature: 0.2,
    max_tokens: 4096,
    response_format: { type: 'json_object' },
  }

  const raw = await requestDeepSeek(url, payload, key)

  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new HttpError(502, 'DeepSeek 返回的不是 JSON')
  }

  const content = data?.choices?.[0]?.message?.content
  const parsed = typeof content === 'string' ? parseJsonLoose(content) : null
  const list = extractItems(parsed)
  if (list === null) {
    await logTranslationError(
      502,
      `format model=${model} items=${JSON.stringify(items).slice(0, 600)} content=${String(content ?? '').slice(0, 600)}`,
    )
    throw new HttpError(502, '当前翻译通道返回的译文格式无法解析')
  }

  const byId = new Map()
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i]
    if (item === null || typeof item !== 'object') continue
    const text = item.text ?? item.translation ?? item.translated ?? item.value
    if (typeof text !== 'string') continue
    const key = item.id !== undefined ? String(item.id) : String(i + 1)
    byId.set(key, text.trim())
  }

  const out = []
  const missing = []
  for (const item of items) {
    const translated = byId.get(String(item.id))
    if (validTranslationText(translated, item.target, item.text)) {
      out.push({ id: item.id, text: translated.trim() })
    } else {
      missing.push(item)
    }
  }

  // 有些模型对单个表格/单段会返回纯文本而不是 JSON；单条请求时直接兜底。
  if (out.length === 0 && items.length === 1 && typeof content === 'string') {
    const plain = content.trim()
    const looksJson = plain.startsWith('{') || plain.startsWith('[')
    if (!looksJson && plain !== '' && validTranslationText(plain, items[0].target, items[0].text)) {
      out.push({ id: items[0].id, text: plain })
      missing.length = 0
    }
  }

  if (out.length === 0) {
    await logTranslationError(
      502,
      `empty model=${model} items=${JSON.stringify(items).slice(0, 900)} content=${String(content ?? '').slice(0, 900)}`,
    )
  }
  return { items: out, missing }
}

// 所有翻译请求在宿主里串行排队，避免心跳 + 多条消息同时打上游触发限流。
let translationChain = Promise.resolve()

function enqueueTranslation(task) {
  const run = translationChain.then(task, task)
  translationChain = run.catch(() => {})
  return run
}

async function translateItems(items, keyOverride, override = {}, context = '') {
  // 原文已经是目标语言的段落不再请求模型：原样返回即可。
  // （助手偶尔直接用中文回答时，旧逻辑会把它当成「模型没翻译」，然后成片刷 502。）
  const passthrough = new Map()
  const pending = []
  for (const item of items) {
    if (alreadyInTarget(item.text, item.target)) {
      passthrough.set(String(item.id), String(item.text).trim())
    } else {
      pending.push(item)
    }
  }
  if (pending.length === 0) {
    return items.map((item) => ({ id: item.id, text: passthrough.get(String(item.id)) }))
  }

  const current = await resolveKey(keyOverride)
  if (current.key === '') {
    throw new HttpError(400, '还没有配置 DeepSeek API Key。请打开 设置 → 双语，填入 Key 后再试。')
  }

  const results = []
  const retry = []
  let lastError = null

  // 第一轮：按批请求。某一批失败/漏段时不丢弃已经成功的批次，
  // 只把失败和漏掉的单元留给第二轮逐条重试。
  for (const batch of chunk(pending, BATCH_SIZE)) {
    try {
      const result = await callDeepSeek(current.key, batch, override, context)
      results.push(...result.items)
      if (result.missing.length > 0) retry.push(...result.missing)
    } catch (error) {
      lastError = error
      const status = typeof error?.status === 'number' ? error.status : 0
      if (status === 401 || status === 402 || status === 403 || status === 429) throw error
      retry.push(...batch)
    }
  }

  // 第二轮：一条一条重试，避免一个短标题/短标签拖死整批。
  for (const item of retry) {
    await sleep(120)
    try {
      const result = await callDeepSeek(current.key, [item], override, context)
      results.push(...result.items)
    } catch (error) {
      lastError = error
      const status = typeof error?.status === 'number' ? error.status : 0
      if (status === 401 || status === 402 || status === 403 || status === 429) throw error
    }
  }

  if (results.length === 0 && passthrough.size === 0) {
    throw lastError || new HttpError(502, '当前翻译通道没有返回任何有效译文')
  }

  // 按原始顺序合并「无需翻译的」与「模型返回的」；调用方按 id 取用。
  const byId = new Map()
  for (const item of results) byId.set(String(item.id), item.text)
  for (const [id, text] of passthrough) byId.set(id, text)
  const ordered = []
  for (const item of items) {
    const text = byId.get(String(item.id))
    if (text !== undefined) ordered.push({ id: item.id, text })
  }
  return ordered
}

/** 「始终用英文回复」的系统提示词段落：可随配置即时装入 / 卸载。 */
const ENGLISH_POLICY_SECTION = 'bilingual:response-language'
const ENGLISH_POLICY_ORDER = 9500
const ENGLISH_POLICY_TEXT = [
  'Language policy for this deployment (it overrides any conflicting instruction about the language of replies):',
  '- Write every user-visible reply in English: progress updates, questions, summaries, conclusions and explanations.',
  '- Answer in English even when the user writes in another language, for example Chinese.',
  '- Keep code, commands, file paths, identifiers, commit messages and quoted source text exactly as they are.',
  '- Do not also translate your reply; the chat UI renders translations itself.',
].join('\n')

let promptService = null
let englishDisposal = null

/** 按当前配置装入或卸载英文策略段落；重复调用是安全的。 */
function refreshEnglishPolicy() {
  if (typeof englishDisposal === 'function') {
    try {
      englishDisposal()
    } catch {
      // 已经卸载过
    }
    englishDisposal = null
  }
  if (promptService === null || config.forceEnglish === false) return
  try {
    const handle = promptService.section({
      name: ENGLISH_POLICY_SECTION,
      order: ENGLISH_POLICY_ORDER,
      text: ENGLISH_POLICY_TEXT,
    })
    englishDisposal = typeof handle === 'function' ? handle : null
  } catch (error) {
    try {
      promptService = null
    } catch {
      // 忽略
    }
  }
}

function routeOf(req) {
  return (req.url ?? '').split('?')[0].slice(API_PREFIX.length) || '/'
}

/**
 * 宿主的浏览器访问检查（`ctx.connection.requestRejection`）。
 * 返回 `undefined` 表示放行；返回 401/403 表示必须拒绝，调用方原样作为状态码回给浏览器。
 *
 * 取不到 `connection` 时（老宿主/单测）按「不拦」处理以保持兼容，但如果拿到了
 * connection 而它没有 requestRejection，说明契约变了——那时宁可放行也不 crash，
 * 由 /health 的 guard 字段暴露出来，便于升级后第一时间发现闸门失效。
 */
function requestRejectionOf(ctx, req) {
  try {
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : ctx.connection
    if (!connection || typeof connection.requestRejection !== 'function') return undefined
    const rejection = connection.requestRejection(req)
    return rejection === undefined ? undefined : rejection
  } catch {
    return undefined
  }
}

/** 闸门是否真的接上了（给 /health 用来确认升级后没被静默降级）。 */
function guardActive(ctx) {
  try {
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : ctx.connection
    return Boolean(connection && typeof connection.requestRejection === 'function')
  } catch {
    return false
  }
}

export function apply(ctx) {
  loadConfigSync()

  hostContext = ctx

  try {
    ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        const route = routeOf(req)
        try {
          // 先过宿主访问检查，再分发任何路由：没有这道闸，浏览器里任意网页都能调
          // POST /config 改写 baseURL/API Key（Key 会随之被送到第三方），见 D26。
          const refused = requestRejectionOf(ctx, req)
          if (refused !== undefined) {
            return sendJson(res, refused, {
              ok: false,
              code: refused === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED',
              message: 'DSH browser authentication is required',
            })
          }

          if (route === '/config' && req.method === 'GET') {
            return sendJson(res, 200, await publicConfig())
          }

          if (route === '/config' && req.method === 'POST') {
            const body = await readBody(req)
            if (Object.prototype.hasOwnProperty.call(body, 'apiKey')) {
              if (body.apiKey === null) config.apiKey = ''
              else if (typeof body.apiKey === 'string') config.apiKey = body.apiKey.trim()
              else throw new HttpError(400, 'apiKey 必须是字符串')
            }
            if (Object.prototype.hasOwnProperty.call(body, 'model')) config.model = normalizeModel(body.model)
            if (Object.prototype.hasOwnProperty.call(body, 'baseURL')) config.baseURL = normalizeBaseURL(body.baseURL)
            if (Object.prototype.hasOwnProperty.call(body, 'timeoutMs')) config.timeoutMs = normalizeTimeout(body.timeoutMs)
            if (Object.prototype.hasOwnProperty.call(body, 'forceEnglish')) {
              config.forceEnglish = body.forceEnglish !== false
              refreshEnglishPolicy()
            }
            if (Object.prototype.hasOwnProperty.call(body, 'localLanguage')) {
              config.localLanguage = normalizeLocalLanguage(body.localLanguage)
            }
            await persistConfig()
            return sendJson(res, 200, await publicConfig())
          }

          if (route === '/translate' && req.method === 'POST') {
            const body = await readBody(req)
            const items = normalizeItems(body)
            const context = normalizeContext(body?.context)
            const translations = await enqueueTranslation(async () => {
              await sleep(650)
              return translateItems(items, body?.apiKey, {}, context)
            })
            return sendJson(res, 200, { ok: true, items: translations })
          }

          if (route === '/test' && req.method === 'POST') {
            const body = await readBody(req)
            const override = {}
            if (body?.model !== undefined) override.model = normalizeModel(body.model)
            if (body?.baseURL !== undefined) override.baseURL = normalizeBaseURL(body.baseURL)
            const sample = await translateItems([{ id: 1, text: 'Hello, world.', target: 'zh' }], body?.apiKey, override)
            return sendJson(res, 200, { ok: true, sample: sample[0]?.text ?? '' })
          }

          if (route === '/health' && req.method === 'GET') {
            const current = await resolveKey()
            return sendJson(res, 200, {
              ok: true,
              hasKey: current.key !== '',
              keySource: current.source,
              // 诊断用：确认宿主跑的是哪一版混排判据（升级后 /health 能直接看出是否热替换成功）
              logic: 'mixed-v2.1',
              // 升级后用来确认访问闸门真的接上了（false = connection 服务没拿到，路由处于旧的不设防状态）
              guard: guardActive(ctx),
            })
          }

          return sendJson(res, 404, { error: `未知接口: ${route}` })
        } catch (error) {
          const status = typeof error?.status === 'number' ? error.status : 500
          const message = String(error?.message || error)
          if (status >= 500) {
            void logTranslationError(status, `${req.method} ${route} ${message}`)
            try {
              ctx.logger?.warn?.(`[shadow-bilingual] ${message}`)
            } catch {
              // 忽略
            }
          }
          return sendJson(res, status, { error: message })
        }
      },
    })
  } catch (error) {
    // 路由注册失败只让翻译不可用，绝不能影响宿主启动
    try {
      ctx.logger?.error?.(`[shadow-bilingual] 路由注册失败：${String(error?.message || error)}`)
    } catch {
      // 忽略
    }
    return
  }

  try {
    promptService = typeof ctx.get === 'function' ? ctx.get('systemPrompt') ?? null : ctx.systemPrompt ?? null
  } catch {
    promptService = null
  }
  refreshEnglishPolicy()
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        if (typeof englishDisposal === 'function') englishDisposal()
        englishDisposal = null
        hostContext = null
      }, 'shadow-bilingual: english policy')
    }
  } catch {
    // 清理失败不影响运行
  }

  resolveKey()
    .then((current) => {
      ctx.logger?.info?.(
        `[shadow-bilingual] 就绪（${current.key === '' ? '未配置 Key' : `Key ${maskKey(current.key)}（${current.source}）`}；模型 ${config.model}）`,
      )
    })
    .catch(() => {})
}

export const __test = {
  normalizeBaseURL,
  normalizeModel,
  normalizeTimeout,
  normalizeItems,
  parseJsonLoose,
  extractItems,
  maskKey,
}
