/**
 * shadow-bilingual —— 浏览器半（手写 __ModuleLoader__ bundle，无需构建工具）。
 *
 * 三件事：
 *   1. 影子注册 assistant-step 渲染器，把每个正文块的 markdown 交给
 *      `decorate()`：原文 + 每段下面的译文，仍然走官方 `MarkdownText`；
 *   2. 在会话头注册「双语」开关（sessionStorage，手动开启，默认关）；
 *   3. 在 设置 → 双语 里配置 DeepSeek Key / 模型 / Base URL，并测试连接。
 *
 * 翻译只改显示层：会话记录、发给模型的上下文、复制按钮都仍是原文。
 */

window.__ModuleLoader__.load({
  id: 'shadow-bilingual',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    /*__INLINE_MARKDOWN__*/

    var React = require('react')
    var h = React.createElement

    var primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch (error) {
      primitives = null
    }

    var MarkdownText = primitives !== null && primitives.MarkdownText !== null && primitives.MarkdownText !== undefined ? primitives.MarkdownText : FallbackMarkdown
    var JsonBlock = primitives !== null && primitives.JsonBlock !== null && primitives.JsonBlock !== undefined ? primitives.JsonBlock : null
    if (primitives !== null && primitives.default !== null && primitives.default !== undefined) {
      if (primitives.default.MarkdownText !== null && primitives.default.MarkdownText !== undefined) MarkdownText = primitives.default.MarkdownText
      if (primitives.default.JsonBlock !== null && primitives.default.JsonBlock !== undefined) JsonBlock = primitives.default.JsonBlock
    }

    var API = '/api/shadow-bilingual'
    var ENABLED_KEY = 'shadow-bilingual.enabled'
    var CACHE_KEY = 'shadow-bilingual.cache.v2'
    var LEGACY_CACHE_KEY = 'shadow-bilingual.cache.legacy0'
    var LEGACY_CACHE_KEY_1 = 'shadow-bilingual.cache.legacy1'
    var LEGACY_CACHE_KEY_2 = 'shadow-bilingual.cache.legacy2'
    // 改名前的旧键：读完就搬进新键，已积累的译文不会白费。
    var PREVIOUS_CACHE_KEY = 'dsh-bilingual-en.cache.v2'
    var PREVIOUS_ENABLED_KEY = 'dsh-bilingual-en.enabled'
    var PREVIOUS_SEND_KEY = 'dsh-bilingual-en.sendTranslation'
    var PREVIOUS_SENT_KEY = 'dsh-bilingual-en.sent.v1'
    var CACHE_LIMIT = 400
    var STYLE_ID = 'shadow-bilingual-styles'

    // 本地显示语言（AI 侧固定英文）。用户 m01815 要求「本地语种多一些选择」。
    // 顺序即设置页下拉框的顺序：中文排在第一位。
    var LOCAL_LANGUAGES = [
      { code: 'zh', label: '简体中文', tag: 'ZH' },
      { code: 'zh-TW', label: '繁體中文', tag: 'ZH-TW' },
      { code: 'ja', label: '日本語', tag: 'JA' },
      { code: 'ko', label: '한국어', tag: 'KO' },
      { code: 'es', label: 'Español', tag: 'ES' },
      { code: 'fr', label: 'Français', tag: 'FR' },
      { code: 'de', label: 'Deutsch', tag: 'DE' },
      { code: 'pt', label: 'Português', tag: 'PT' },
      { code: 'ru', label: 'Русский', tag: 'RU' },
      { code: 'it', label: 'Italiano', tag: 'IT' },
      { code: 'nl', label: 'Nederlands', tag: 'NL' },
      { code: 'pl', label: 'Polski', tag: 'PL' },
      { code: 'tr', label: 'Türkçe', tag: 'TR' },
      { code: 'ar', label: 'العربية', tag: 'AR' },
      { code: 'hi', label: 'हिन्दी', tag: 'HI' },
      { code: 'th', label: 'ไทย', tag: 'TH' },
      { code: 'vi', label: 'Tiếng Việt', tag: 'VI' },
      { code: 'id', label: 'Bahasa Indonesia', tag: 'ID' },
    ]
    var LOCAL_LANGUAGE_KEY = 'shadow-bilingual.localLanguage'

    /** 精确查找；没有就返回 null（用来区分「宿主给了个不认识的码」和「宿主给了中文」）。 */
    function findLocalLanguage(code) {
      for (var i = 0; i < LOCAL_LANGUAGES.length; i += 1) {
        if (LOCAL_LANGUAGES[i].code === code) return LOCAL_LANGUAGES[i]
      }
      return null
    }

    function localLanguageEntry(code) {
      return findLocalLanguage(code) ?? LOCAL_LANGUAGES[0]
    }

    function readLocalLanguage() {
      var stored = safeGetStorage('local', LOCAL_LANGUAGE_KEY)
      if (stored === null || stored === '') return 'zh'
      return localLanguageEntry(stored).code
    }

    function writeLocalLanguage(code) {
      localLanguage = localLanguageEntry(code).code
      safeSetStorage('local', LOCAL_LANGUAGE_KEY, localLanguage)
    }

    var localLanguage = readLocalLanguage()

    // ---------------------------------------------------------------- 小工具

    function safeGetStorage(kind, key) {
      try {
        if (kind === 'session' && typeof sessionStorage !== 'undefined') return sessionStorage.getItem(key)
        if (kind === 'local' && typeof localStorage !== 'undefined') return localStorage.getItem(key)
      } catch (error) {
        return null
      }
      return null
    }

    function safeSetStorage(kind, key, value) {
      try {
        if (kind === 'session' && typeof sessionStorage !== 'undefined') sessionStorage.setItem(key, value)
        if (kind === 'local' && typeof localStorage !== 'undefined') localStorage.setItem(key, value)
      } catch (error) {
        // 隐私模式 / 配额满：只影响下次是否记得
      }
    }

    function readEnabled() {
      var current = safeGetStorage('session', ENABLED_KEY)
      if (current !== null) return current !== '0'
      var previous = safeGetStorage('session', PREVIOUS_ENABLED_KEY)
      return previous === null ? true : previous !== '0'
    }

    function loadCache() {
      var map = new Map()
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem(LEGACY_CACHE_KEY)
          localStorage.removeItem(LEGACY_CACHE_KEY_1)
          localStorage.removeItem(LEGACY_CACHE_KEY_2)
        }
      } catch (error) {
        // 清不掉旧缓存也不影响：下面读的是新 key
      }
      var raw = safeGetStorage('local', CACHE_KEY)
      if (raw === null) {
        // 第一次用新名字：把旧插件的缓存搬过来，别让历史译文白白失效。
        raw = safeGetStorage('local', PREVIOUS_CACHE_KEY)
        if (raw !== null) {
          safeSetStorage('local', CACHE_KEY, raw)
          try {
            localStorage.removeItem(PREVIOUS_CACHE_KEY)
          } catch (error) {
            // 删不掉也无害
          }
        }
      }
      if (raw === null) return map
      try {
        var parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return map
        Object.keys(parsed).forEach(function (key) {
          if (typeof parsed[key] === 'string' && parsed[key].trim() !== '') map.set(key, parsed[key])
        })
      } catch (error) {
        return map
      }
      return map
    }

    var cache = loadCache()
    var saveTimer = null

    function scheduleCacheSave() {
      if (typeof setTimeout !== 'function') return
      if (saveTimer !== null) return
      saveTimer = setTimeout(function () {
        saveTimer = null
        try {
          var object = {}
          var count = 0
          cache.forEach(function (value, key) {
            if (count >= CACHE_LIMIT) return
            object[key] = value
            count += 1
          })
          safeSetStorage('local', CACHE_KEY, JSON.stringify(object))
        } catch (error) {
          // 存不下就算了，内存缓存仍然有效
        }
      }, 400)
    }

    // ---------------------------------------------------------------- 响应式池

    var store = {
      enabled: readEnabled(),
      version: 0,
      listeners: new Set(),
      pending: 0,
      lastError: '',
      lastErrorStatus: 0,
      lastErrorAt: 0,
      retryToken: 0,
      subscribe: function (listener) {
        store.listeners.add(listener)
        return function () {
          store.listeners.delete(listener)
        }
      },
      getVersion: function () {
        return store.version
      },
      bump: function () {
        store.version += 1
        store.listeners.forEach(function (listener) {
          try {
            listener()
          } catch (error) {
            // 单个订阅者失败不影响其它 UI
          }
        })
      },
      setEnabled: function (value) {
        store.enabled = value === true
        safeSetStorage('session', ENABLED_KEY, store.enabled ? '1' : '0')
        store.bump()
      },
      setError: function (message) {
        store.lastError = message === null || message === undefined ? '' : String(message)
        store.bump()
      },
      retry: function () {
        store.retryToken += 1
        store.lastError = ''
        store.bump()
      },
      get: function (key) {
        return cache.get(key)
      },
      put: function (key, value) {
        cache.set(key, value)
        if (cache.size > CACHE_LIMIT) {
          var first = cache.keys().next()
          if (first.done !== true) cache.delete(first.value)
        }
        scheduleCacheSave()
      },
    }

    var inflight = new Set()

    /** 一条译文是否真的像目标语言；空串 / 原样返回都不算。规则在 markdown.cjs 里统一维护。 */
    function validTranslation(text, target, source) {
      return ShadowMarkdown.translationLooksValid(text, target, source)
    }

    /**
     * 这段文字在发送前是否需要换成英文。
     *
     * 这是全项目最容易漏的一个函数：它取代了原本到处都是的 `hasCjk()`。
     * 只判「有没有汉字」在多语种下是错的——日文、韩文、俄文、西文都该翻，
     * 而英文本该原样发出。判错的代价不对称：误判成「要翻」只是多一次请求，
     * 误判成「不用翻」则会让非英文原文直接发给模型。
     */
    function needsEnglish(text, language) {
      return ShadowMarkdown.needsEnglish(text, language ?? localLanguage)
    }

    /** 书写系统识别（'zh' / 'ja' / 'ko' / 'ru' / 'ar' / … / 'en' / null）。 */
    function languageOf(text) {
      return ShadowMarkdown.languageOf(text)
    }

    /**
     * 批量请求偶尔会漏掉某个短标题/短标签（模型只回了长段落）。
     * 漏掉的单元单独重试——一次只发一条，避免一条坏数据拖垮整批。
     */
    var scheduledRetries = new Set()
    var retryState = new Map()
    var lastRetryReset = 0

    /** 读缓存前先校验目标语言；命中但内容不对的条目直接删掉重翻。 */
    function cachedValue(unit, target) {
      var key = ShadowMarkdown.unitKey(unit, target)
      if (!cache.has(key)) return null
      var value = cache.get(key)
      if (validTranslation(value, target, unit.content)) return value
      cache.delete(key)
      scheduleCacheSave()
      return null
    }

    function cachedValueForKey(key, target, source) {
      if (!cache.has(key)) return null
      var value = cache.get(key)
      if (validTranslation(value, target, source)) return value
      cache.delete(key)
      scheduleCacheSave()
      return null
    }

    function scheduleRetries(missing) {
      if (store.enabled !== true) return
      if (store.lastErrorStatus === 401 || store.lastErrorStatus === 402 || store.lastErrorStatus === 403) return
      var baseDelay = store.lastErrorStatus === 429 ? 4000 : store.lastErrorStatus >= 500 ? 5000 : 700
      missing.forEach(function (item, index) {
        if (cachedValueForKey(item.key, item.target, item.text) !== null || scheduledRetries.has(item.key)) return
        scheduledRetries.add(item.key)
        setTimeout(function () {
          scheduledRetries.delete(item.key)
          retryOne(item)
        }, baseDelay + index * 450)
      })
    }

    function retryOne(item) {
      if (store.enabled !== true || cachedValueForKey(item.key, item.target, item.text) !== null) return
      var used = retryState.get(item.key) || 0
      if (used >= 2) return
      retryState.set(item.key, used + 1)
      apiPost('/translate', { items: [{ id: 1, text: item.text, target: item.target }] })
        .then(function (data) {
          var list = data !== null && data !== undefined && Array.isArray(data.items) ? data.items : []
          var translated = list[0] !== undefined && list[0] !== null ? list[0].text : ''
          if (validTranslation(translated, item.target, item.text)) {
            store.put(item.key, translated.trim())
            store.lastError = ''
            store.lastErrorStatus = 0
            store.lastErrorAt = 0
            store.bump()
            return
          }
          if (used + 1 < 2) {
            setTimeout(function () {
              retryOne(item)
            }, 1200 * (used + 1))
          }
        })
        .catch(function (error) {
          store.lastErrorStatus = error !== null && error !== undefined && typeof error.status === 'number' ? error.status : 0
          store.lastErrorAt = Date.now()
          if (store.lastErrorStatus === 401 || store.lastErrorStatus === 402 || store.lastErrorStatus === 403) return
          if (used + 1 < 2) {
            setTimeout(function () {
              retryOne(item)
            }, (store.lastErrorStatus === 429 ? 3000 : 1500) * (used + 1))
          }
        })
    }

    /** 助手回复侧：把英文正文补成本地语言。 */
    function localTargetFor(unit) {
      return ShadowMarkdown.translationTarget(unit, { mode: 'local', localLanguage: localLanguage })
    }

    /** 用户输入侧：把本地语言变成英文（AI 侧固定英文）。 */
    function englishTargetFor(unit) {
      return ShadowMarkdown.translationTarget(unit, { mode: 'english', localLanguage: localLanguage })
    }

    /** 输入侧：取出所有已缓存的英文译文（键按目标语言 'en' 分开存）。 */
    function englishMapFor(text) {
      var units = ShadowMarkdown.splitUnits(text)
      var out = {}
      for (var i = 0; i < units.length; i += 1) {
        var target = englishTargetFor(units[i])
        if (target === null) continue
        if (target.target !== 'en') continue
        var value = cachedValue(units[i], 'en')
        if (value !== null) out[ShadowMarkdown.unitKey(units[i], 'en')] = value
      }
      return out
    }

    function translationsFor(text) {
      var units = ShadowMarkdown.splitUnits(text)
      var out = {}
      for (var i = 0; i < units.length; i += 1) {
        var target = localTargetFor(units[i])
        if (target === null) continue
        var value = cachedValue(units[i], target.target)
        if (value !== null) {
          out[ShadowMarkdown.unitKey(units[i], target.target)] = value
          // 同时写一份不带目标语言后缀的键：调用方 decorate() 可能只按单元查表。
          out[ShadowMarkdown.unitKey(units[i])] = value
        }
      }
      return out
    }

    function ensureTranslations(text) {
      if (store.enabled !== true) return
      // 上游刚连续失败时先冷静 8 秒，别让心跳把 502/429 越打越多。
      if (store.lastErrorStatus >= 500 && Date.now() - store.lastErrorAt < 8000) return
      var units = ShadowMarkdown.splitUnits(text)
      var missing = []
      for (var i = 0; i < units.length; i += 1) {
        var unit = units[i]
        var target = localTargetFor(unit)
        if (target === null) continue
        var key = ShadowMarkdown.unitKey(unit, target.target)
        if (cachedValue(unit, target.target) !== null || inflight.has(key)) continue
        // 心跳每 4 秒扫一次；失败 3 次后不再自动重试，避免持续烧 API。
        if ((retryState.get(key) || 0) >= 3) continue
        missing.push({ key: key, text: unit.content, target: target.target, kind: unit.kind })
      }
      if (missing.length === 0) return

      // 按目标语言分组：同一个请求里混着 zh→en 和 en→zh，模型更容易漏短句。
      var groups = {}
      missing.forEach(function (item) {
        if (groups[item.target] === undefined) groups[item.target] = []
        groups[item.target].push(item)
      })

      Object.keys(groups).forEach(function (target) {
        var group = groups[target]
        // 表格单独发；短标题/短标签按 4 条一组发。一条一个请求会瞬间打爆
        // DeepSeek 的速率限制（上层 429/502），整段译文反而全丢。
        var tables = group.filter(function (item) {
          return item.kind === 'table'
        })
        var short = group.filter(function (item) {
          return item.kind !== 'table' && item.text.length <= 160
        })
        var long = group.filter(function (item) {
          return item.kind !== 'table' && item.text.length > 160
        })
        tables.forEach(function (item, index) {
          setTimeout(function () {
            requestGroup([item])
          }, index * 700)
        })
        for (var ci = 0; ci < short.length; ci += 4) {
          (function (chunk, index) {
            setTimeout(function () {
              requestGroup(chunk)
            }, 500 + index * 500)
          })(short.slice(ci, ci + 4), ci / 4)
        }
        if (long.length > 0) {
          setTimeout(function () {
            requestGroup(long)
          }, 900)
        }
      })
    }

    function requestGroup(group) {
      if (group.length === 0) return
      group.forEach(function (item) {
        inflight.add(item.key)
      })
      store.pending += 1
      store.bump()

      var payload = {
        items: group.map(function (item, index) {
          return { id: index + 1, text: item.text, target: item.target }
        }),
      }
      var still = group.slice()
      var brief = contextBrief()
      if (brief !== '') payload.context = brief

      apiPost('/translate', payload)
        .then(function (data) {
          var byId = {}
          var list = data !== null && data !== undefined && Array.isArray(data.items) ? data.items : []
          list.forEach(function (item) {
            if (item !== null && item !== undefined && item.id !== undefined) byId[String(item.id)] = item.text
          })
          var got = 0
          group.forEach(function (item, index) {
            var translated = byId[String(index + 1)]
            if (validTranslation(translated, item.target, item.text)) {
              store.put(item.key, translated.trim())
              got += 1
            }
          })
          if (got > 0) {
            store.lastError = ''
            store.lastErrorStatus = 0
            store.lastErrorAt = 0
          }
        })
        .catch(function (error) {
          store.lastErrorStatus = error !== null && error !== undefined && typeof error.status === 'number' ? error.status : 0
          store.lastError = error !== null && error !== undefined && error.message ? error.message : String(error)
          store.lastErrorAt = Date.now()
        })
        .then(function () {
          group.forEach(function (item) {
            inflight.delete(item.key)
          })
          store.pending = Math.max(0, store.pending - 1)
          still = group.filter(function (item) {
            return cachedValueForKey(item.key, item.target, item.text) === null
          })
          store.bump()
          if (still.length > 0) scheduleRetries(still)
        })
    }

    // ---------------------------------------------------------------- HTTP

    // ---------------------------------------------------- 翻译上下文（术语一致）
    //
    // 用户需求（m01409）：翻译时带一点上下文，避免专有名词/技术术语被误译。
    // 但不该花太多 token，所以这里只维护一小段「最近对话」的滚动窗口。
    //
    // 来源是插件本来就渲染的正文（助手英文块 + 用户中文原文），
    // 不额外发请求、不改宿主行为，纯本地累积。
    var CONTEXT_MAX_CHARS = 600
    var CONTEXT_MAX_ITEMS = 8
    var contextBuffer = []

    function normalizeContextText(text) {
      return String(text === null || text === undefined ? '' : text)
        .replace(/\s+/g, ' ')
        .trim()
    }

    /** 记一段对话原文作为翻译上下文（重复的忽略，保持顺序）。 */
    function pushContext(lang, text) {
      var value = normalizeContextText(text)
      if (value === '') return
      // 长段落只留开头：术语通常出现在前几句，没必要整段塞进去
      if (value.length > 220) value = value.slice(0, 220) + '…'
      for (var i = 0; i < contextBuffer.length; i += 1) {
        if (contextBuffer[i].text === value) return
      }
      contextBuffer.push({ lang: lang, text: value })
      while (contextBuffer.length > CONTEXT_MAX_ITEMS) contextBuffer.shift()
      var total = 0
      for (var j = 0; j < contextBuffer.length; j += 1) total += contextBuffer[j].text.length
      while (total > CONTEXT_MAX_CHARS && contextBuffer.length > 1) {
        total -= contextBuffer.shift().text.length
      }
    }

    /** 把上下文压成一段短文本，跟着翻译请求一起发过去。 */
    function contextBrief() {
      if (contextBuffer.length === 0) return ''
      var lines = []
      for (var i = 0; i < contextBuffer.length; i += 1) {
        var entry = contextBuffer[i]
        var prefix = entry.lang === 'en' ? '助手(英) : ' : '用户(' + localLanguageEntry(entry.lang).tag + ') : '
        lines.push(prefix + entry.text)
      }
      var out = lines.join('\n')
      return out.length > CONTEXT_MAX_CHARS ? out.slice(0, CONTEXT_MAX_CHARS) : out
    }

    function readJson(res) {
      return res.text().then(function (text) {
        var data = null
        try {
          data = text === '' ? null : JSON.parse(text)
        } catch (error) {
          data = null
        }
        if (!res.ok) {
          var message = data !== null && data !== undefined && data.error ? data.error : 'HTTP ' + res.status
          var err = new Error(message)
          err.status = res.status
          throw err
        }
        return data
      })
    }

    function apiGet(path) {
      return fetch(API + path, { cache: 'no-store' }).then(readJson)
    }

    function apiPost(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body === null || body === undefined ? {} : body),
      }).then(readJson)
    }

    // ---------------------------------------------------------------- 宿主 Markdown 小件

    var FALLBACK_LABELS = {
      copy: '复制',
      copied: '已复制',
      'codeBlock.title': '代码',
      'codeBlock.wrap': '自动换行',
      'codeBlock.unwrap': '取消换行',
      'markdown.footnotes': '脚注',
      'message.think': '思考',
      'message.stopped': '已停止',
      'message.unknownBlock': '未知内容',
    }

    function tFallback(key, params) {
      var text = FALLBACK_LABELS[key] !== undefined ? FALLBACK_LABELS[key] : key
      if (params !== null && params !== undefined) {
        Object.keys(params).forEach(function (name) {
          text = text.split('{' + name + '}').join(String(params[name]))
        })
      }
      return text
    }

    function safeT(t, key, params) {
      if (typeof t === 'function') {
        try {
          var value = t(key, params)
          if (typeof value === 'string' && value !== '' && value !== key) return value
        } catch (error) {
          // 宿主词典缺失时走内置文案
        }
      }
      return tFallback(key, params)
    }

    function markdownLabels(t) {
      var tr = typeof t === 'function' ? t : tFallback
      return {
        code: {
          copyLabel: tr('copy'),
          copiedLabel: tr('copied'),
          toolbarLabels: {
            codeLabel: tr('codeBlock.title'),
            wrapLabel: tr('codeBlock.wrap'),
            unwrapLabel: tr('codeBlock.unwrap'),
          },
        },
        footnotes: tr('markdown.footnotes'),
      }
    }

    function isWindowsStylePath(value) {
      return /^[A-Za-z]:[/\\]/.test(value) || value.indexOf('\\\\') === 0
    }

    function isAbsoluteWorkspacePath(value) {
      return value.charAt(0) === '/' || isWindowsStylePath(value)
    }

    function fileMediaUrl(base, value) {
      if ((!/^https?:/i.test(base) && base.indexOf('dsh-app://app/') !== 0) || !isAbsoluteWorkspacePath(value)) return undefined
      if (/^[/\\]{2}/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return undefined
      return new URL('api/file?path=' + encodeURIComponent(value), base).href
    }

    function localPathMediaUrl(base, value) {
      var path
      try {
        path = decodeURIComponent(String(value).split(/[?#]/)[0] || '')
      } catch (error) {
        return undefined
      }
      return fileMediaUrl(base, path)
    }

    function makePathImages() {
      if (typeof document === 'undefined') return undefined
      return {
        resolve: function (value) {
          return localPathMediaUrl(document.baseURI, value)
        },
      }
    }

    function FallbackMarkdown(props) {
      return h('pre', { className: 'sbp-fallback-md' }, String(props.text === null || props.text === undefined ? '' : props.text))
    }

    function FallbackUnknown(props) {
      return h('pre', { className: 'sbp-fallback-md' }, JSON.stringify(props.payload, null, 2))
    }

    // ---------------------------------------------------------------- 影子里程碑

    function useStore() {
      var useSync = React.useSyncExternalStore
      if (typeof useSync === 'function') return useSync(store.subscribe, store.getVersion, store.getVersion)
      var pair = React.useState(store.getVersion())
      React.useEffect(function () {
        return store.subscribe(function () {
          pair[1](store.getVersion())
        })
      }, [])
      return pair[0]
    }

    function useInView(ref, active) {
      var unavailable = typeof IntersectionObserver === 'undefined'
      var pair = React.useState(unavailable ? true : false)
      React.useEffect(function () {
        if (unavailable || active !== true) return undefined
        var element = ref.current
        if (element === null || element === undefined) return undefined
        var observer = new IntersectionObserver(
          function (entries) {
            pair[1](
              entries.some(function (entry) {
                return entry.isIntersecting === true
              }),
            )
          },
          { rootMargin: '200px' },
        )
        observer.observe(element)
        return function () {
          observer.disconnect()
        }
      }, [active, unavailable])
      return pair[0]
    }

    function AssistantStep(props) {
      var data = props.node !== null && props.node !== undefined && props.node.data !== null && props.node.data !== undefined ? props.node.data : {}
      var blocks = Array.isArray(data.blocks) ? data.blocks : []
      var groupPart = props.groupPart
      var t = typeof props.t === 'function' ? props.t : tFallback
      var tr = function (key, params) {
        return safeT(t, key, params)
      }
      var labels = markdownLabels(tr)
      var pathImages = makePathImages()
      var enabled = store.enabled
      var version = useStore()
      var retryToken = store.retryToken
      var rootRef = React.useRef(null)
      var settled = data.status !== 'running'
      var inView = useInView(rootRef, enabled === true)

      var blockKey = ''
      for (var bi = 0; bi < blocks.length; bi += 1) {
        blockKey += (blocks[bi] && blocks[bi].kind ? blocks[bi].kind : '?') + ':' + (blocks[bi] && blocks[bi].text ? blocks[bi].text : '') + '\u0000'
      }

      React.useEffect(function () {
        if (enabled !== true || settled !== true || inView !== true) return
        if (groupPart === 'reasoning') return
        var seen = {}
        for (var i = 0; i < blocks.length; i += 1) {
          var block = blocks[i]
          if (block === null || block === undefined || block.kind !== 'text') continue
          var text = typeof block.text === 'string' ? block.text : ''
          if (text.trim() === '' || seen[text] === true) continue
          seen[text] = true
          // 助手正文就是「正在使用的英文表述」，正好给术语定锚
          pushContext('en', text)
          ensureTranslations(text)
        }
      }, [enabled, settled, inView, groupPart, blockKey, retryToken])

      // 兜底：有些回合在正文已经显示后还会继续跑工具/收尾，data.status 长时间
      // 停在 running。正文块稳定 1.8 秒后就先翻，避免“表格/横线后面整段没译文”
      // 一直等到回合彻底结束。文本继续增长时 blockKey 变化会重置计时器。
      React.useEffect(function () {
        if (enabled !== true || settled === true) return
        if (groupPart === 'reasoning') return
        var timer = setTimeout(function () {
          var seen = {}
          for (var i = 0; i < blocks.length; i += 1) {
            var block = blocks[i]
            if (block === null || block === undefined || block.kind !== 'text') continue
            var text = typeof block.text === 'string' ? block.text : ''
            if (text.trim() === '' || seen[text] === true) continue
            seen[text] = true
            ensureTranslations(text)
          }
        }, 1800)
        return function () {
          clearTimeout(timer)
        }
      }, [enabled, settled, inView, groupPart, blockKey, retryToken])

      // 心跳补翻：不管 status / 视口 / effect 依赖有没有漏掉，只要插件开着，
      // 每 4 秒扫一遍这一行里的正文块；已翻译的会直接命中缓存，不发请求。
      // 这是“下半截整段没译文”的最后一道保险。
      React.useEffect(function () {
        if (enabled !== true || groupPart === 'reasoning') return undefined
        var timer = setInterval(function () {
          if (store.enabled !== true) return
          // 失败计数不能永久钉死：上游恢复后，最多 45 秒就重新给这些块机会。
          if (Date.now() - lastRetryReset > 45000) {
            retryState.clear()
            lastRetryReset = Date.now()
          }
          var seen = {}
          for (var i = 0; i < blocks.length; i += 1) {
            var block = blocks[i]
            if (block === null || block === undefined || block.kind !== 'text') continue
            var text = typeof block.text === 'string' ? block.text : ''
            if (text.trim() === '' || seen[text] === true) continue
            seen[text] = true
            ensureTranslations(text)
          }
        }, 4000)
        return function () {
          clearInterval(timer)
        }
      }, [enabled, groupPart, blockKey, retryToken])

      var reasoningHidden = false
      try {
        var turnProcess = props.turnProcess
        if (
          turnProcess !== null &&
          turnProcess !== undefined &&
          turnProcess.foldable === true &&
          turnProcess.spec !== null &&
          turnProcess.spec !== undefined &&
          turnProcess.spec.answerStep === data.step &&
          turnProcess.spec.inlineReasoning === true &&
          turnProcess.open !== true
        ) {
          reasoningHidden = true
        }
      } catch (error) {
        reasoningHidden = false
      }

      var rendered = []
      for (var i = 0; i < blocks.length; i += 1) {
        var block = blocks[i]
        if (block === null || block === undefined) continue
        if (groupPart === 'reasoning' && block.kind !== 'reasoning') continue
        if (groupPart === 'response' && block.kind === 'reasoning') continue

        if (block.kind === 'text') {
          var text = typeof block.text === 'string' ? block.text : ''
          var decorated = text
          if (enabled === true && groupPart !== 'reasoning' && settled === true) {
            var map = translationsFor(text)
            decorated = ShadowMarkdown.decorate(text, map)
          }
          rendered.push(
            h(MarkdownText, {
              key: 'text-' + i,
              text: decorated,
              streaming: data.status === 'running',
              labels: labels,
              pathImages: pathImages,
            }),
          )
          continue
        }

        if (block.kind === 'reasoning') {
          if (typeof block.text !== 'string' || block.text.trim() === '') continue
          if (reasoningHidden === true) continue
          rendered.push(
            h(
              'details',
              { key: 'reasoning-' + i, className: 'sbp-think' },
              h('summary', { className: 'sbp-think-summary' }, tr('message.think')),
              h(
                'div',
                { className: 'sbp-think-body' },
                h(MarkdownText, {
                  text: block.text,
                  streaming: data.status === 'running',
                  labels: labels,
                  pathImages: pathImages,
                }),
              ),
            ),
          )
          continue
        }

        if (block.kind === 'image') {
          var group = [block]
          while (i + 1 < blocks.length && blocks[i + 1] !== null && blocks[i + 1] !== undefined && blocks[i + 1].kind === 'image') {
            group.push(blocks[i + 1])
            i += 1
          }
          var images = group.map(function (item) {
            return { attachment: item.attachment }
          })
          var node = null
          try {
            if (typeof props.renderSlot === 'function') {
              node = props.renderSlot('conversation.chat.message.images', {
                images: images,
                loadImage: props.loadImage,
                align: 'start',
              })
            } else if (typeof props.renderFactorySlot === 'function') {
              node = props.renderFactorySlot('conversation.chat.message.images', {
                images: images,
                loadImage: props.loadImage,
                align: 'start',
              })
            }
          } catch (error) {
            node = null
          }
          if (node !== null && node !== undefined) rendered.push(h(React.Fragment, { key: 'images-' + i }, node))
          continue
        }

        if (block.kind === 'tool-call') continue

        rendered.push(
          JsonBlock !== null
            ? h(JsonBlock, {
                key: 'unknown-' + i,
                label: tr('message.unknownBlock'),
                payload: block.block !== undefined ? block.block : block,
                truncatedLabel: function (total) {
                  return '…（共 ' + total + ' 项）'
                },
              })
            : h(FallbackUnknown, { key: 'unknown-' + i, payload: block.block !== undefined ? block.block : block }),
        )
      }

      if (data.status === 'interrupted' && (groupPart === undefined || groupPart === 'response' || groupPart === 'reasoning')) {
        rendered.push(h('span', { key: 'stopped', className: 'sbp-stopped' }, tr('message.stopped')))
      }

      return h(
        'div',
        {
          ref: rootRef,
          className: 'sbp-assistant',
          'data-bilingual': enabled === true ? '1' : '0',
          'data-group-part': groupPart,
          'data-status': data.status,
          'data-version': version,
        },
        rendered,
      )
    }

    class AssistantBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error: error }
      }

      componentDidCatch(error) {
        try {
          console.error('[shadow-bilingual] 助手行渲染失败，已退回纯文本：', error)
        } catch (ignored) {
          // 忽略
        }
      }

      render() {
        if (this.state.error !== null) {
          var data = this.props.node !== null && this.props.node !== undefined && this.props.node.data !== null && this.props.node.data !== undefined ? this.props.node.data : {}
          var blocks = Array.isArray(data.blocks) ? data.blocks : []
          var children = []
          for (var i = 0; i < blocks.length; i += 1) {
            var block = blocks[i]
            if (block === null || block === undefined) continue
            if (block.kind === 'text' && typeof block.text === 'string') {
              children.push(h('pre', { key: 'fallback-text-' + i, className: 'sbp-fallback-md' }, block.text))
            }
          }
          return h('div', { className: 'sbp-assistant sbp-assistant-fallback' }, children)
        }
        return this.props.children
      }
    }

    // ---------------------------------------------------------------- 开关 / 设置 UI

    function ToggleButton() {
      useStore()
      var enabled = store.enabled
      var busy = store.pending > 0
      var error = store.lastError
      var title = enabled
        ? busy
          ? '正在翻译…'
          : error !== ''
            ? '翻译失败：' + error
            : '关闭双语对照'
        : '开启双语对照（每段原文下方追加另一种语言）'
      return h(
        'button',
        {
          type: 'button',
          className: 'sbp-toggle',
          'data-on': enabled === true ? '1' : '0',
          'data-busy': busy === true ? '1' : '0',
          'data-error': error !== '' ? '1' : '0',
          title: title,
          'aria-pressed': enabled === true ? 'true' : 'false',
          onClick: function () {
            store.setEnabled(!store.enabled)
          },
        },
        h('span', { className: 'sbp-toggle-dot', 'aria-hidden': 'true' }),
        h('span', { className: 'sbp-toggle-label' }, '双语'),
        h('span', { className: 'sbp-toggle-build' }, 'v4.4'),
        enabled === true ? h('span', { className: 'sbp-toggle-state' }, 'ON') : null,
      )
    }

    function Field(props) {
      return h(
        'label',
        { className: 'sbp-field' },
        h('span', { className: 'sbp-field-label' }, props.label),
        h('input', {
          className: 'sbp-input',
          type: props.type || 'text',
          value: props.value,
          placeholder: props.placeholder || '',
          spellCheck: false,
          autoComplete: 'off',
          onChange: function (event) {
            props.onChange(event.target.value)
          },
        }),
        props.hint ? h('span', { className: 'sbp-field-hint' }, props.hint) : null,
      )
    }

    function Select(props) {
      return h(
        'label',
        { className: 'sbp-field' },
        h('span', { className: 'sbp-field-label' }, props.label),
        h(
          'select',
          {
            className: 'sbp-input sbp-select',
            value: props.value,
            onChange: function (event) {
              props.onChange(event.target.value)
            },
          },
          props.options.map(function (option) {
            return h('option', { key: option.value, value: option.value }, option.label)
          }),
        ),
        props.hint ? h('span', { className: 'sbp-field-hint' }, props.hint) : null,
      )
    }

    function SettingsPage() {
      useStore()
      var langPair = React.useState(localLanguage)
      var langDraft = langPair[0]
      var setLangDraft = langPair[1]
      var remotePair = React.useState(null)
      var remote = remotePair[0]
      var setRemote = remotePair[1]
      var draftPair = React.useState({ apiKey: '', model: 'deepseek-chat', baseURL: 'https://api.deepseek.com' })
      var draft = draftPair[0]
      var setDraft = draftPair[1]
      var statusPair = React.useState('')
      var status = statusPair[0]
      var setStatus = statusPair[1]
      var busyPair = React.useState(false)
      var busy = busyPair[0]
      var setBusy = busyPair[1]

      React.useEffect(function () {
        var alive = true
        apiGet('/config')
          .then(function (data) {
            if (!alive) return
            setRemote(data)
            setDraft(function (current) {
              return {
                apiKey: current.apiKey,
                model: data.model || 'deepseek-chat',
                baseURL: data.baseURL || 'https://api.deepseek.com',
              }
            })
            // 宿主持有 localLanguage 的真值。换设备、清过 localStorage 之后本地
            // 可能还停在默认 zh，这里以宿主为准回填，并写回本机。
            if (typeof data.localLanguage === 'string' && findLocalLanguage(data.localLanguage) !== null) {
              if (data.localLanguage !== localLanguage) writeLocalLanguage(data.localLanguage)
              setLangDraft(localLanguage)
            }
          })
          .catch(function (error) {
            if (!alive) return
            setStatus('宿主未连接：' + (error.message || String(error)) + '。请重启 DSH 后再打开本页。')
          })
        return function () {
          alive = false
        }
      }, [])

      function save() {
        setBusy(true)
        setStatus('保存中…')
        var payload = { model: draft.model, baseURL: draft.baseURL }
        if (draft.apiKey.trim() !== '') payload.apiKey = draft.apiKey.trim()
        apiPost('/config', payload)
          .then(function (data) {
            setRemote(data)
            setDraft(function (current) {
              return { apiKey: '', model: data.model, baseURL: data.baseURL }
            })
            setStatus('已保存。')
            store.retry()
          })
          .catch(function (error) {
            setStatus('保存失败：' + (error.message || String(error)))
          })
          .then(function () {
            setBusy(false)
          })
      }

      function test() {
        setBusy(true)
        setStatus('正在测试当前通道…')
        var payload = { model: draft.model, baseURL: draft.baseURL }
        if (draft.apiKey.trim() !== '') payload.apiKey = draft.apiKey.trim()
        apiPost('/test', payload)
          .then(function (data) {
            setStatus('连接正常。示例：' + (data.sample || '（空）'))
            store.retry()
          })
          .catch(function (error) {
            setStatus('连接失败：' + (error.message || String(error)))
          })
          .then(function () {
            setBusy(false)
          })
      }

      function clearKey() {
        setBusy(true)
        setStatus('正在清除…')
        apiPost('/config', { apiKey: '' })
          .then(function (data) {
            setRemote(data)
            setStatus('已清除插件里保存的 Key。')
          })
          .catch(function (error) {
            setStatus('清除失败：' + (error.message || String(error)))
          })
          .then(function () {
            setBusy(false)
          })
      }

      function clearCache() {
        cache.clear()
        retryState.clear()
        scheduledRetries.clear()
        try {
          if (typeof localStorage !== 'undefined') {
            localStorage.removeItem(CACHE_KEY)
            localStorage.removeItem(LEGACY_CACHE_KEY)
            localStorage.removeItem(LEGACY_CACHE_KEY_1)
            localStorage.removeItem(LEGACY_CACHE_KEY_2)
          }
        } catch (error) {
          // 清不掉内存缓存也已经清空
        }
        store.lastError = ''
        store.lastErrorStatus = 0
        store.retry()
        setStatus('译文缓存已清空，正在按需重译…')
      }

      var enabled = store.enabled
      var keySourceLabel =
        remote === null
          ? ''
          : remote.keySource === 'plugin'
            ? '插件设置'
            : remote.keySource === 'env'
              ? '环境变量'
              : remote.keySource === 'credentials'
                ? 'DSH 凭据'
                : remote.keySource === 'request'
                  ? '本次请求'
                  : '未知来源'
      var keyState =
        remote === null
          ? '读取中…'
          : remote.hasKey === true
            ? '已配置（' + remote.keyHint + '，来源：' + keySourceLabel + '）'
            : '未配置'

      return h(
        'div',
        { className: 'sbp-settings' },
        h('div', { className: 'sbp-settings-head' }, h('h2', { className: 'sbp-settings-title' }, '双语对照'), h('p', { className: 'sbp-settings-desc' }, '对话本身是英文的（模型只读英文）；界面上再给你一份本地语言对照。输入框里打本地语言时，发送前会自动换成英文，并显示影子译文。只改显示与发送内容，不改会话记录里的原文。')),
        h(
          'div',
          { className: 'sbp-card' },
          h(
            'div',
            { className: 'sbp-row' },
            h('div', null, h('div', { className: 'sbp-card-title' }, '当前会话开关'), h('div', { className: 'sbp-muted' }, enabled ? '已开启（只在本标签页生效）' : '关闭（默认）')),
            h(
              'button',
              {
                type: 'button',
                className: 'sbp-button sbp-button-primary',
                onClick: function () {
                  store.setEnabled(!store.enabled)
                },
              },
              enabled ? '关闭双语' : '开启双语',
            ),
          ),
        ),
        h(
          'div',
          { className: 'sbp-card' },
          h('div', { className: 'sbp-card-title' }, '本地显示语言'),
          h(
            'div',
            { className: 'sbp-muted' },
            'AI 始终用英文思考与回复（对模型最友好、最省 token）；这里选的是**给你看**的语言：助手回复的下方对照、以及你消息气泡里的本地语种对照，都用它。',
          ),
          h(Select, {
            label: '本地语言',
            value: langDraft,
            options: LOCAL_LANGUAGES.map(function (item) {
              return { value: item.code, label: item.label + '（' + item.code + '）' }
            }),
            hint: '切换后已缓存的旧语种译文不会被复用；新段落会按新语言重新翻译。',
            onChange: function (value) {
              setLangDraft(value)
              writeLocalLanguage(value)
              // 换语言等于换缓存世界：立刻重扫一遍，把已经显示的正文补上新语种
              store.retry()
              // 同时写一份到宿主：localStorage 会随缓存清掉，宿主配置不会。
              apiPost('/config', { localLanguage: value })
                .then(function (data) {
                  setRemote(data)
                })
                .catch(function () {
                  // 宿主没连上不影响本机使用，本地已经生效
                })
            },
          }),
        ),
        h(
          'div',
          { className: 'sbp-card' },
          h('div', { className: 'sbp-card-title' }, '翻译通道（DeepSeek / MiMo / OpenAI 兼容）'),
          h('div', { className: 'sbp-muted' }, '会自动读取 DSH 已保存的 DEEPSEEK_API_KEY（设置 → 模型 里的凭据）；也可以在这里单独填一个 Key（填了则优先用这里的），只保存在本机 ' + (remote !== null && remote.configPath ? remote.configPath : '<DSH_HOME>/shadow-bilingual.json') + '，不会写进会话。切换通道要同时改 Base URL、模型和 Key。'),
          h(Field, {
            label: 'API Key',
            type: 'password',
            value: draft.apiKey,
            placeholder: remote !== null && remote.hasKey === true ? '已保存 ' + remote.keyHint + '，留空保持不变' : 'sk-...',
            onChange: function (value) {
              setDraft(function (current) {
                return { apiKey: value, model: current.model, baseURL: current.baseURL }
              })
            },
          }),
          h('div', { className: 'sbp-muted sbp-key-state' }, 'Key 状态：' + keyState),
          h(Field, {
            label: '模型',
            value: draft.model,
            placeholder: 'deepseek-chat',
            hint: '默认 deepseek-chat；也可以填兼容端点的模型名。',
            onChange: function (value) {
              setDraft(function (current) {
                return { apiKey: current.apiKey, model: value, baseURL: current.baseURL }
              })
            },
          }),
          h(Field, {
            label: 'Base URL',
            value: draft.baseURL,
            placeholder: 'https://api.deepseek.com',
            hint: 'OpenAI 兼容的 Base URL（不含 /chat/completions）。DeepSeek：https://api.deepseek.com；MiMo：https://api.xiaomimimo.com/v1。',
            onChange: function (value) {
              setDraft(function (current) {
                return { apiKey: current.apiKey, model: current.model, baseURL: value }
              })
            },
          }),
          h(
            'div',
            { className: 'sbp-actions' },
            h(
              'button',
              { type: 'button', className: 'sbp-button sbp-button-primary', disabled: busy, onClick: save },
              busy ? '处理中…' : '保存',
            ),
            h('button', { type: 'button', className: 'sbp-button', disabled: busy, onClick: test }, '测试连接'),
            h('button', { type: 'button', className: 'sbp-button', disabled: busy, onClick: clearCache }, '清空译文缓存'),
            h('button', { type: 'button', className: 'sbp-button sbp-button-danger', disabled: busy, onClick: clearKey }, '清除 Key'),
          ),
          status !== '' ? h('div', { className: 'sbp-status' }, status) : null,
        ),
        h(
          'div',
          { className: 'sbp-card' },
          h('div', { className: 'sbp-card-title' }, '说明'),
          h('ul', { className: 'sbp-help' }, h('li', null, '默认开启；点会话头部的「双语」或上面的按钮可以临时关掉。'), h('li', null, 'AI 侧固定英文：输入框、插话框、消息队列里的本地语言，都会在发送前换成英文。'), h('li', null, '显示侧跟随「本地显示语言」：助手回复的正文段落、标题、列表、引用和表格下方补该语言对照；代码块、公式不翻译。'), h('li', null, '原文保持不变；复制按钮复制的仍是原文。'), h('li', null, '同一段译文按「目标语言」分别缓存在本机，切换语种不会串味，滚动回来也不会重复请求。')),
        ),
        h('div', { className: 'sbp-muted', style: { padding: '0 4px' } }, 'Shadow Bilingual v1.0.0 · 本地定制版'),
      )
    }

    // ---------------------------------------------------------------- 样式

    var CSS = [
      '.sbp-assistant{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.sbp-think{margin:4px 0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.6}',
      '.sbp-think-summary{cursor:pointer;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px;line-height:20px;user-select:none}',
      '.sbp-think-summary:hover{color:var(--dsw-alias-label-secondary,#5f6672)}',
      '.sbp-think-body{margin-top:6px;padding-left:10px;border-left:2px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));color:var(--dsw-alias-label-secondary,#5f6672)}',
      '.sbp-stopped{color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px;line-height:18px}',
      '.sbp-fallback-md{white-space:pre-wrap;word-break:break-word;margin:0;font:inherit}',
      '.sbp-toggle{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);font:12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer;white-space:nowrap;transition:background-color .15s ease,border-color .15s ease,color .15s ease}',

      '.sbp-en-panel{display:flex;flex-direction:column;gap:6px;margin:6px 2px 0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));border-radius:9px;background:var(--dsw-alias-bg-layer-2,#f7f8fa);font:12px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--dsw-alias-label-secondary,#5f6672)}',
      '.sbp-en-panel[data-active="0"]{padding:6px 10px}',
      // 翻译中：整块加一条左侧竖条，让「还不能发」这件事看得见
      '.sbp-en-panel[data-phase="pending"]{border-left:2px solid var(--dsw-alias-brand-primary,#4c6ef5)}',
      '.sbp-en-panel[data-phase="ready"] .sbp-en-lang{color:var(--dsw-alias-brand-primary,#4c6ef5);font-weight:600}',
      '.sbp-en-row{display:flex;align-items:center;gap:8px}',
      '.sbp-en-check{display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none}',
      '.sbp-en-check input{width:13px;height:13px;margin:0;accent-color:var(--dsw-alias-brand-primary,#4d6bfe);cursor:pointer}',
      '.sbp-en-check-label{font-size:12px;font-weight:500}',
      '.sbp-en-lang{font-size:10px;font-weight:600;letter-spacing:.06em;opacity:.65}',
      // 输入框内的影子译文：紧跟可编辑区之后，沿用同一套字号/行高/内边距，
      // 视觉上就是草稿正文下面的灰色续写（用户 m01277 要的「真正的影子输入」）。
      '.sbp-en-ghost{box-sizing:border-box;max-height:40vh;overflow-y:auto;padding:2px 8px 6px 14px;margin-top:-8px;border-top:1px dashed var(--dsw-alias-border-l1,rgba(127,127,127,.28));white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;font-family:var(--dsw-font-family,inherit);font-size:inherit;line-height:inherit;color:var(--dsw-alias-label-tertiary,#8a8f98);pointer-events:none;user-select:none}',
      '.sbp-en-ghost[data-phase="pending"] .sbp-en-ghost-text{opacity:.55}',
      '.sbp-en-ghost-status{display:block;margin-top:2px;font-size:11px;letter-spacing:.02em;opacity:.7}',
      '.sbp-en-ghost-empty{opacity:.75}',
      '.sbp-user-text{white-space:pre-wrap;word-break:break-word}',
      '.sbp-en-user-origin{display:block;gap:6px;justify-content:flex-end;margin:0 2px 4px;font:12px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--dsw-alias-label-tertiary,#8a8f98);white-space:pre-wrap;word-break:break-word}',
      '.sbp-toggle:hover{background:rgba(127,127,127,.10)}',
      '.sbp-toggle[data-on="1"]{border-color:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-brand-primary,#4d6bfe);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 10%,transparent)}',
      '.sbp-toggle[data-error="1"]{border-color:var(--dsw-alias-state-error-primary,#e5484d);color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.sbp-toggle-dot{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.45;flex:none}',
      '.sbp-toggle[data-on="1"] .sbp-toggle-dot{opacity:1}',
      '.sbp-toggle[data-busy="1"] .sbp-toggle-dot{animation:sbp-pulse 1s ease-in-out infinite}',
      '.sbp-toggle-state{font-size:10px;font-weight:600;letter-spacing:.04em;opacity:.9}',
      '.sbp-toggle-build{font-size:9px;font-weight:500;opacity:.55;margin-left:-1px}',
      '@keyframes sbp-pulse{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1.15)}}',
      '.sbp-settings{display:flex;flex-direction:column;gap:14px;max-width:760px;padding:4px 0 24px;color:var(--dsw-alias-label-primary,#1b1c20);font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}',
      '.sbp-settings-head{display:flex;flex-direction:column;gap:6px}',
      '.sbp-settings-title{margin:0;font-size:18px;line-height:26px;font-weight:600}',
      '.sbp-settings-desc{margin:0;color:var(--dsw-alias-label-secondary,#5f6672)}',
      '.sbp-card{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff)}',
      '.sbp-card-title{font-weight:600;font-size:13px}',
      '.sbp-muted{color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px;line-height:1.6}',
      '.sbp-row{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.sbp-field{display:flex;flex-direction:column;gap:5px}',
      '.sbp-field-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#5f6672)}',
      '.sbp-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));border-radius:7px;background:var(--dsw-alias-bg-layer-2,#f7f8fa);color:var(--dsw-alias-label-primary,#1b1c20);font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;outline:none}',
      '.sbp-input:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 18%,transparent)}',
      '.sbp-select{height:34px;padding:0 8px;cursor:pointer}',
      '.sbp-field-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98)}',
      '.sbp-key-state{font-size:11px}',
      '.sbp-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:2px}',
      '.sbp-button{appearance:none;height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#1b1c20);font:12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer}',
      '.sbp-button:hover:not(:disabled){background:rgba(127,127,127,.10)}',
      '.sbp-button:disabled{opacity:.5;cursor:default}',
      '.sbp-button-primary{border-color:var(--dsw-alias-brand-primary,#4d6bfe);background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff}',
      '.sbp-button-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary,#4d6bfe);filter:brightness(1.06)}',
      '.sbp-button-danger{color:var(--dsw-alias-state-error-primary,#e5484d);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 45%,transparent)}',
      '.sbp-status{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#5f6672);white-space:pre-wrap;word-break:break-word}',
      '.sbp-help{margin:0;padding-left:18px;color:var(--dsw-alias-label-secondary,#5f6672);font-size:12px;line-height:1.8}',
    ].join('')

    function installStyles(ctx) {
      function mount() {
        if (typeof document === 'undefined' || document.head === null) return
        if (document.getElementById(STYLE_ID) !== null) return
        var style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
      }
      mount()
      try {
        if (typeof ctx.effect === 'function') {
          ctx.effect(function () {
            mount()
            return function () {
              var element = document.getElementById(STYLE_ID)
              if (element !== null && element.parentNode !== null) element.parentNode.removeChild(element)
            }
          }, 'shadow-bilingual: styles')
        }
      } catch (error) {
        // 样式失败不影响功能
      }
    }

    // ---------------------------------------------------------------- 英文模式（定制）

    var SEND_KEY = 'shadow-bilingual.sendTranslation'
    var CJK_TEST_RE = /[\u3400-\u9fff\uf900-\ufaff]/
    var CJK_ALL_RE = /[\u3400-\u9fff\uf900-\ufaff]/g

    var sendTranslation = safeGetStorage('local', SEND_KEY) !== '0'

    function readSendTranslation() {
      var current = safeGetStorage('local', SEND_KEY)
      if (current !== null) return current !== '0'
      var previous = safeGetStorage('local', PREVIOUS_SEND_KEY)
      return previous === null ? true : previous !== '0'
    }

    function writeSendTranslation(value) {
      sendTranslation = value === true
      safeSetStorage('local', SEND_KEY, sendTranslation ? '1' : '0')
    }

    function countCjk(text) {
      var matches = String(text === null || text === undefined ? '' : text).match(CJK_ALL_RE)
      return matches === null ? 0 : matches.length
    }

    function hasCjk(text) {
      return CJK_TEST_RE.test(String(text === null || text === undefined ? '' : text))
    }

    /** 输入框里最近一次看到的原文与译文，供提交拦截器同步读取。 */
    /** 影子译文的停顿阈值：输入停这么久才翻，避免边打边翻烧额度。 */
    var SHADOW_DEBOUNCE_MS = 900
    /** 影子翻译的硬超时：过了就当失败，退回 idle 让原文能发出去。 */
    var SHADOW_TIMEOUT_MS = 15000

    var composerSource = ''
    var composerEnglish = ''
    // 同一段草稿共用一次翻译请求：发消息时不再另起一次
    var sharedTranslation = { source: '', promise: null, english: '' }
    var composerBridge = { actions: null }
    var steerReplaying = false
    var submittedAt = 0
    // 刚提交过的那段文本：窗口期里只有「同一段」才算重复，别吞新消息
    var submittedDraft = ''
    // 用户已经按了发送、但译文还没好：翻好了要**自动发出去**，
    // 不能让用户再按一次（用户规格 m01128：「翻译完成后会立即发送」）。
    var pendingSubmit = { kind: '', source: '' }
    var lastBlock = ''
    var lockAt = 0
    var sendSeq = 0
    var intercepting = false

    /**
     * 把一个（可能是多段的）输入框文本翻成英文。
     *
     * 复用助手侧的 markdown 切分与译文缓存：代码块 / 表格原样保留，
     * 缓存命中就立即返回，因此重复输入不会重复花 API 额度。
     */
    function translateDraft(rawText) {
      var source = typeof rawText === 'string' ? rawText : ''
      if (source.trim() === '' || !needsEnglish(source, localLanguage)) return Promise.resolve('')

      var units = ShadowMarkdown.splitUnits(source)
      var need = []
      var seen = Object.create(null)
      for (var i = 0; i < units.length; i += 1) {
        var unit = units[i]
        var target = englishTargetFor(unit)
        if (target === null) continue
        var key = ShadowMarkdown.unitKey(unit, target.target)
        if (seen[key] === true) continue
        seen[key] = true
        if (cachedValue(unit, target.target) !== null) continue
        if (unit.content.length > 5000) continue
        need.push({ key: key, text: unit.content, target: target.target })
      }

      function finish() {
        return ShadowMarkdown.replaceUnits(source, englishMapFor(source), 'en')
      }

      if (need.length === 0) return Promise.resolve(finish())

      var payload = {
        items: need.map(function (item, index) {
          return { id: index + 1, text: item.text, target: item.target }
        }),
      }
      var brief = contextBrief()
      if (brief !== '') payload.context = brief

      return apiPost('/translate', payload).then(function (data) {
        var byId = Object.create(null)
        var list = data !== null && data !== undefined && Array.isArray(data.items) ? data.items : []
        list.forEach(function (item) {
          if (item !== null && item !== undefined && item.id !== undefined) byId[String(item.id)] = item.text
        })
        need.forEach(function (item, index) {
          var translated = byId[String(index + 1)]
          if (validTranslation(translated, item.target, item.text)) store.put(item.key, translated.trim())
        })
        store.bump()
        return finish()
      })
    }

    /** 从编辑器 DOM 读当前草稿：拦截那一刻的文本比 state 投影更可靠。 */
    function readLiveDraft() {
      if (typeof document === 'undefined') return ''
      var element = null
      var active = document.activeElement
      if (active !== null && active !== undefined && typeof active.closest === 'function') {
        element = active.closest('[contenteditable="true"]')
      }
      if (element === null || element === undefined) {
        element = document.querySelector('[data-lexical-editor="true"]')
      }
      if (element === null || element === undefined) return ''
      var text = String(element.innerText === undefined ? element.textContent : element.innerText)
      return text.replace(/\u200b/g, '').replace(/^[\s\u00a0]+/, '').replace(/\s+$/, '')
    }

    // --------------------------------------------- 插话框（dsh-steer-note）
    //
    // 插话框是另一套输入组件：`textarea.dsh-steer-note-input`，受控 React 组件，
    // 它的 send() 读的是 React state（latestTextRef），不是 DOM。所以不能只改
    // DOM 文本——必须走原生 setter + input 事件让 React 更新，再触发它的按钮。
    // 不拦这里的话，插话会以中文原样发出去。

    /** 当前聚焦的插话 textarea（没有聚焦就返回 null）。 */
    function focusedSteerTextarea() {
      if (typeof document === 'undefined') return null
      var active = document.activeElement
      if (active === null || active === undefined) return null
      if (active.tagName !== 'TEXTAREA') return null
      if (!active.classList || !active.classList.contains('dsh-steer-note-input')) return null
      return active
    }

    /** 页面上任意一个插话 textarea（用于在发送后回查元素）。 */
    function steerTextarea() {
      var focused = focusedSteerTextarea()
      if (focused !== null) return focused
      if (typeof document === 'undefined') return null
      return document.querySelector('textarea.dsh-steer-note-input')
    }

    function readSteerDraft() {
      var element = steerTextarea()
      return element === null ? '' : String(element.value || '')
    }

    /** 受控组件：必须用原生 setter 再派发 input，React 才会更新 state。 */
    function setSteerValue(element, value) {
      if (typeof window === 'undefined' || window.HTMLTextAreaElement === undefined) return false
      var descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
      if (descriptor !== undefined && typeof descriptor.set === 'function') descriptor.set.call(element, value)
      else element.value = value
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }

    function steerSendButton() {
      var element = steerTextarea()
      var scope = null
      if (element !== null && typeof element.closest === 'function') scope = element.closest('.dsh-steer-note-row')
      var button = scope === null || scope === undefined ? null : scope.querySelector('button.dsh-steer-note-button')
      if (button === null || button === undefined) {
        button = document.querySelector('button.dsh-steer-note-button')
      }
      return button === null || button === undefined ? null : button
    }

    function isSteerSendButton(button) {
      if (button === null || button === undefined) return false
      if (!button.classList) return false
      if (button.classList.contains('dsh-steer-note-button')) return true
      var label = String(button.getAttribute('aria-label') || '')
      return label.indexOf('插话') !== -1 || /steering message/i.test(label)
    }

    /** 插话发送被拦截时，用它把「原样发送」这条兜住，避免消息被吞掉。 */
    function clickSteerSend() {
      var button = steerSendButton()
      if (button === null) return
      steerReplaying = true
      try {
        button.click()
      } finally {
        steerReplaying = false
      }
    }

    /**
     * 插话框的发送：同样受影子译文闸门约束。
     * 返回 true 表示已接管（调用方要 preventDefault）。
     */
    function interceptSteerSend() {
      if (steerReplaying === true || intercepting === true) return false
      var source = readSteerDraft()
      if (source.trim() === '' || !needsEnglish(source, localLanguage)) return false
      return gateSend('steer', source)
    }

    /** 比较草稿是否同一段（忽略空白差异）。 */
    function sameDraft(a, b) {
      var norm = function (value) {
        return String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim()
      }
      return norm(a) === norm(b) && norm(a) !== ''
    }

    // ---------------------------------------------------------- 影子译文状态
    //
    // 用户定的规格（m01128）：不做 Tab，「发送译文」勾选框 + 影子预览，
    // **译文没准备好之前不许发送**，并且要有明确反馈，
    // 否则用户看不到任何反应就会连点，又变成重复发送。
    //
    // 三段状态，所有发送路径共用：
    //   idle    —— 没有可翻译的草稿（或勾选框没开）
    //   pending —— 正在翻译：此时禁止发送，提示「正在翻译…」
    //   ready   —— 译文就绪：允许发送，按译文发
    var shadow = {
      /** 当前草稿原文（空白归一化前） */
      source: '',
      /** 就绪的英文译文；'' 表示还没有 */
      english: '',
      /** 'idle' | 'pending' | 'ready' */
      phase: 'idle',
      /** 上次失败原因，用于面板提示 */
      error: '',
      /** 每次请求的序号，防止旧结果覆盖新草稿 */
      seq: 0,
    }
    /** 订阅者：面板用它刷新「正在翻译…」提示。 */
    var shadowListeners = new Set()

    function shadowEmit() {
      // ghost 是普通 DOM，不受 React 调度；必须在这里直接画，
      // 否则「译文回来了但面板没重渲染」时用户看不到影子。
      try {
        renderGhost(shadow.source)
      } catch (ignored) {
        // 没有编辑器（例如设置页）时静默跳过
      }
      shadowListeners.forEach(function (fn) {
        try {
          fn()
        } catch (ignored) {
          // 订阅者异常不影响主流程
        }
      })
    }

    function shadowReset() {
      clearPendingSubmit()
      shadow.source = ''
      shadow.english = ''
      shadow.phase = 'idle'
      shadow.error = ''
      shadow.seq += 1
    }

    /** 当前草稿是否应该进入影子翻译（不是英文 + 勾了「发送译文」+ 插件开着）。 */
    function shadowWanted(text) {
      if (store.enabled !== true || readSendTranslation() !== true) return false
      var value = String(text === null || text === undefined ? '' : text)
      if (value.trim() === '') return false
      return needsEnglish(value, localLanguage)
    }

    /** 译文是否可以用来发送：非空、以字母开头、和原文不同。 */
    function usableEnglish(text, source) {
      var value = typeof text === 'string' ? text.trim() : ''
      if (value === '') return false
      if (!/^[A-Za-z]/.test(value)) return false
      if (sameDraft(value, source)) return false
      return true
    }

    /**
     * 刷新影子译文：草稿变了就按段落做 diff，只译缓存里没有的段。
     *
     * 防抖由调用方（面板 / 轮询）控制；这里只负责「该不该发请求、发哪些段」。
     * 增量能力来自 translateDraft 内部：它先查 cachedValue，
     * 命中的段不会进 payload，所以追加一句话时通常只请求新增的那一段。
     */
    function shadowRefresh(text, force) {
      var source = typeof text === 'string' ? text : ''
      if (!shadowWanted(source)) {
        if (shadow.phase !== 'idle' || shadow.source !== '') {
          shadowReset()
          shadowEmit()
        }
        return
      }
      if (force !== true && sameDraft(shadow.source, source)) return

      shadow.source = source
      // 注意：**不要**清空 shadow.english。
      // 清空会让预览在每次重译时先消失、再出现「翻译中」——用户看到的就是
      // 「卡一下、又显示正在翻译」。保留上一版译文，只把 phase 标成 pending，
      // 新译文回来再原地替换，视觉上是连续的。
      shadow.phase = 'pending'
      shadow.error = ''
      var mySeq = (shadow.seq += 1)
      shadowEmit()

      // 挂死的请求不能永久占着 pending：到点退回 idle，放原文过去。
      // 少了这一步，一次网络挂起就能让之后每条消息都发不出去。
      if (typeof setTimeout === 'function') {
        setTimeout(function () {
          if (mySeq !== shadow.seq || shadow.phase !== 'pending') return
          shadow.error = 'timeout'
          shadow.phase = 'idle'
          clearPendingSubmit()
          shadowEmit()
        }, SHADOW_TIMEOUT_MS)
      }

      translateDraft(source)
        .then(function (english) {
          if (mySeq !== shadow.seq) return
          var value = typeof english === 'string' ? english.trim() : ''
          if (!usableEnglish(value, source)) {
            // 译文不可用：保持 idle，不阻碍发送（旧译文也不留，它属于上一段草稿）
            shadow.english = ''
            shadow.phase = 'idle'
            shadow.error = ''
            shadowEmit()
            return
          }
          shadow.english = value
          shadow.phase = 'ready'
          shadow.error = ''
          shadowEmit()
          // 用户在翻译期间按过发送 → 现在立刻替他发出去
          if (pendingSubmit.source !== '' && sameDraft(pendingSubmit.source, source)) {
            var kind = pendingSubmit.kind
            clearPendingSubmit()
            commitShadow(kind, source)
          }
        })
        .catch(function (error) {
          if (mySeq !== shadow.seq) return
          // 失败保留上一版译文，只标记错误；清空会让预览整块消失
          shadow.error = String(error && error.message ? error.message : error)
          clearPendingSubmit()
          // 失败也回到 idle：宁可发原文，也不能把用户卡住
          shadow.phase = 'idle'
          shadow.error = String(error && error.message ? error.message : error)
          shadowEmit()
        })
    }

    /** 订阅影子状态（面板用）。 */
    function useShadow() {
      var tick = React.useState(0)
      var setTick = tick[1]
      React.useEffect(function () {
        var fn = function () {
          setTick(function (n) {
            return n + 1
          })
        }
        shadowListeners.add(fn)
        return function () {
          shadowListeners.delete(fn)
        }
      }, [])
      return shadow
    }

    /**
     * 发送闸门：译文没就绪时**不发送**，并给出反馈。
     *
     * 用户规格（m01128）：翻译没完成之前发送应该是不允许的，
     * 点发送要提示「正在翻译，翻译完成后会立即发送」，否则没反馈就会连点、重复发送。
     *
     * 返回 true 表示「这次发送已经被接管」：
     *   - pending：吞掉事件并提示，不发送
     *   - ready：  用译文发送
     * 返回 false 表示「不归我管」：调用方放行（例如没有中文、勾选框没开）。
     */
    function gateSend(kind, source) {
      if (!shadowWanted(source)) return false
      // 同一段草稿刚提交过：这是重复点击/连按，吞掉，不能再发一次。
      if (submittedDraft !== '' && sameDraft(submittedDraft, source) && Date.now() - submittedAt < 1500) {
        return true
      }
      // 主输入框拿不到 actions 就不能接管：否则吞掉事件又发不出去（消息丢失）
      if (kind === 'composer' && (composerBridge.actions === null || composerBridge.actions === undefined)) {
        lastBlock = 'no-actions'
        return false
      }
      // 关键：译文必须属于**当前这段草稿**。
      // 少了 sameDraft(shadow.source, source) 这一句，上一段草稿的旧译文
      // 会被拿去当成新草稿的译文发出去——发的是完全不相干的内容。
      if (shadow.phase === 'ready' && sameDraft(shadow.source, source) && usableEnglish(shadow.english, source)) {
        commitShadow(kind, source)
        return true
      }
      // 已经翻过这段、并且失败了：不能再挡。
      // 否则每次点击都重新发起翻译、每次都失败 —— 用户永远发不出消息，
      // 这比发原文糟糕得多。失败就让原文走。
      if (shadow.error !== '' && sameDraft(shadow.source, source)) return false
      // 影子属于**别的**草稿：上一段的翻译可能永远回不来（网络挂死）。
      // 这时必须为当前草稿重开一次，否则之后的每一条消息都会被永久挡住。
      if (!sameDraft(shadow.source, source)) {
        notePendingSubmit(kind, source)
        shadowRefresh(source, true)
        notifyShadowPending()
        return true
      }
      if (shadow.phase === 'pending') {
        // 正在翻译：记下这次发送意图，翻好了自动发出去。
        // 绝不在这里 submit，否则又会变成「中文先发、英文再发」。
        notePendingSubmit(kind, source)
        notifyShadowPending()
        return true
      }
      // idle 但草稿里有中文且勾选框开着：说明翻译还没开始，立刻开始并拦住这一次。
      notePendingSubmit(kind, source)
      shadowRefresh(source, true)
      notifyShadowPending()
      return true
    }

    function notePendingSubmit(kind, source) {
      pendingSubmit = { kind: kind, source: source }
    }

    function clearPendingSubmit() {
      pendingSubmit = { kind: '', source: '' }
    }

    var lastPendingNotice = 0
    function notifyShadowPending() {
      var now = Date.now()
      if (now - lastPendingNotice < 1200) return
      lastPendingNotice = now
      shadow.phase = 'pending'
      shadowEmit()
    }

    /** 用影子译文提交：只发一次（序列号 + 锁）。 */
    function commitShadow(kind, source) {
      if (intercepting === true) return
      intercepting = true
      lockAt = Date.now()
      var seq = (sendSeq += 1)
      var later = typeof setTimeout === 'function' ? setTimeout : null
      var english = shadow.english
      if (!usableEnglish(english, source)) {
        intercepting = false
        lockAt = 0
        return
      }
      recordSent(english, source)

      function release() {
        if (seq === sendSeq) {
          intercepting = false
          lockAt = 0
        }
      }

      if (kind === 'steer') {
        var element = steerTextarea()
        if (element === null || !setSteerValue(element, english)) {
          clickSteerSend()
          release()
          return
        }
        // 插话框是受控 React 组件：send() 读渲染时的 state，
        // 必须等它重渲染完再点它自己的按钮。
        if (later === null) {
          clickSteerSend()
          release()
          return
        }
        later(function () {
          try {
            clickSteerSend()
          } finally {
            submittedAt = Date.now()
            submittedDraft = english
            release()
          }
        }, 60)
        return
      }

      var actions = composerBridge.actions
      if (actions === null || actions === undefined) {
        release()
        return
      }
      try {
        actions.setDraft(english)
      } catch (error) {
        // 写不进英文草稿就放弃这次发送，让用户自己决定
        release()
        return
      }
      var commit = function () {
        try {
          actions.submit()
        } finally {
          submittedAt = Date.now()
          submittedDraft = english
          release()
        }
      }
      if (later === null) commit()
      else later(commit, 30)
    }

    function isSendButton(button) {
      var label = String(button.getAttribute('aria-label') || '')
      if (label === '') return false
      return /^(send|sending)/i.test(label) || label.indexOf('发送') !== -1
    }

    function installSubmitInterceptor(ctx) {
      if (typeof document === 'undefined') return

      function ready() {
        // 看门狗：锁悬空太久说明上一次发送出了异常，强制解锁，
        // 否则用户的每一次回车都会被无声吞掉。
        if (intercepting === true && lockAt !== 0 && Date.now() - lockAt > 20000) {
          intercepting = false
          lockAt = 0
        }
        return store.enabled === true && readSendTranslation() === true
      }

      /**
       * 翻译在飞 / 刚提交完的窗口里，必须**吞掉**这次发送，而不是放行。
       *
       * 之前的 bug：ready() 把 `intercepting === false` 也算进去了，于是
       * 翻译还没回来时用户再按一次 Enter，keydown 直接 return（不 preventDefault），
       * 浏览器原生提交把中文原样发出去；紧接着我们的翻译完成又 submit 一次英文。
       * 结果就是「中文一条 + 英文一条」。修法：这种时刻要拦住，不是放过。
       */
      function inFlight(event) {
        if (intercepting === true) return true
        // 刚提交完的窗口期里，只有「同一段草稿」才算重复发送。
        // 之前只看时间：600ms 内用户删掉重打的新消息会被无声吞掉，
        // 表现就是「按回车没反应、草稿留在框里」。
        if (Date.now() - submittedAt >= 600) return false
        if (submittedDraft === '') return false
        if (event === null || event === undefined) return true
        return sameDraft(submittedDraft, event)
      }

      function swallow(event) {
        event.preventDefault()
        event.stopPropagation()
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
      }

      function onKeyDown(event) {
        if (event.key !== 'Enter' || event.shiftKey === true || event.altKey === true) return
        if (event.isComposing === true || event.keyCode === 229) return
        if (!ready()) return

        // 插话框是另一套输入组件，优先处理
        var steer = focusedSteerTextarea()
        if (steer !== null) {
          if (inFlight(String(steer.value || ''))) {
            swallow(event)
            return
          }
          // 长按 Enter 的自动重复不能当成第二次发送
          if (event.repeat === true) {
            if (needsEnglish(String(steer.value || ''), localLanguage)) swallow(event)
            return
          }
          if (!needsEnglish(String(steer.value || ''), localLanguage)) return
          if (!interceptSteerSend()) return
          swallow(event)
          return
        }

        var source = readLiveDraft()
        if (source.trim() === '' || !needsEnglish(source, localLanguage)) return

        // 翻译在飞：吞掉，等我们自己的英文提交，绝不放行原文
        if (inFlight(source)) {
          swallow(event)
          return
        }
        if (event.repeat === true) {
          swallow(event)
          return
        }
        if (gateSend('composer', source) === false) return
        swallow(event)
      }

      function onClick(event) {
        var node = event.target
        if (node === null || node === undefined || typeof node.closest !== 'function') return
        var button = node.closest('button')
        if (button === null || button === undefined) return

        if (!ready()) return

        if (isSteerSendButton(button)) {
          if (!needsEnglish(readSteerDraft(), localLanguage)) return
          if (inFlight(readSteerDraft())) {
            swallow(event)
            return
          }
          if (!interceptSteerSend()) return
          swallow(event)
          return
        }

        if (!isSendButton(button)) return
        var source = readLiveDraft()
        if (source.trim() === '' || !needsEnglish(source, localLanguage)) return
        if (inFlight(source)) {
          swallow(event)
          return
        }
        if (gateSend('composer', source) === false) return
        swallow(event)
      }

      /**
       * 用 window 上的单例保证**任何时刻只有一套监听器**。
       *
       * 双重发送的真实来源：客户端热重载会重新执行 apply()，而旧 bundle 的
       * `document` 监听器不一定被清理干净（新旧模块各有自己的 `intercepting`），
       * 于是同一次 Enter 被两套拦截器各自翻译、各自 submit —— 两条不同的英文。
       * 模块级变量救不了这个问题，必须落在 window 上做成单例。
       */
      function attach() {
        var previous = null
        try {
          previous = window.__shadowBilingualInterceptor || null
        } catch (ignored) {
          previous = null
        }
        if (previous !== null && typeof previous.dispose === 'function') {
          try {
            previous.dispose()
          } catch (ignored) {
            // 旧监听器已经失效，继续装新的
          }
        }

        document.addEventListener('keydown', onKeyDown, true)
        document.addEventListener('click', onClick, true)

        var handle = {
          dispose: function () {
            document.removeEventListener('keydown', onKeyDown, true)
            document.removeEventListener('click', onClick, true)
            try {
              if (window.__shadowBilingualInterceptor === handle) window.__shadowBilingualInterceptor = null
            } catch (ignored) {
              // 忽略
            }
          },
        }
        try {
          window.__shadowBilingualInterceptor = handle
        } catch (ignored) {
          // 拿不到 window 就只能退化成无单例
        }
        return handle
      }

      try {
        if (typeof ctx.effect === 'function') {
          ctx.effect(function () {
            var handle = attach()
            return function () {
              if (handle !== null && typeof handle.dispose === 'function') handle.dispose()
            }
          }, 'shadow-bilingual: submit interceptor')
        } else {
          attach()
        }
      } catch (error) {
        // 拦截器装不上只影响「发送译文」，不影响其余功能
      }
    }

    // ------------------------------------------------------------ 队列翻译
    //
    // 用户的选择（m00946）：**排队时就译成英文存回去**。
    //
    // 场景：我正在干活时你发的消息进的是 DSH 官方的 inbox 队列（next-turn），
    // 要等这一轮彻底结束才作为下一轮送达。这条路径不经过 composer，
    // 所以主输入框的拦截器根本看不到它——之前队列里的中文就是这样漏出去的。
    //
    // 机制：`conversation.input.dock` 的 props 里有 `useProjection('inbox')`
    // 和注册时注入的 `updateQueue(itemId, { kind:'edit', content })`。
    // 发现哪一行含中文就翻一次，把该行的 content 换成英文；
    // 换完这一行不再含中文，因此不会自激循环（另有一张 seen 表兜底）。

    /** 已经处理过的队列行 id → true（防止翻译在飞时重复触发）。 */
    var queueSeen = Object.create(null)

    /** 取一个队列行的纯文本；含非文本块（图片/文件）时返回 '' 表示跳过。 */
    function queueRowText(row) {
      if (row === null || row === undefined) return ''
      var content = row.content
      if (!Array.isArray(content) || content.length === 0) return ''
      var parts = []
      for (var i = 0; i < content.length; i += 1) {
        var block = content[i]
        if (block === null || block === undefined) return ''
        if (block.type !== 'text') return ''
        parts.push(String(block.text === null || block.text === undefined ? '' : block.text))
      }
      return parts.join('')
    }

    /** 把一行队列消息译成英文并写回去；失败就保持原文，绝不丢消息。 */
    function translateQueueRow(id, text, updateQueue) {
      translateDraft(text).then(function (english) {
        var value = typeof english === 'string' ? english.trim() : ''
        // 译文不可用（空/不是英文/与原文相同）→ 保持原文，什么都不做
        if (value === '' || !/^[A-Za-z]/.test(value)) return
        if (value === text.trim()) return
        recordSent(value, text)
        return updateQueue(id, { kind: 'edit', content: [{ type: 'text', text: value }] })
      }).catch(function () {
        // 翻译或写回失败：队列里仍是原文，用户消息不会丢
      })
    }

    /**
     * 无渲染组件：盯着 inbox 队列，把含中文的行就地译成英文。
     * 挂在 `conversation.input.dock` 上，order 排在官方 QueueDock 之后。
     */
    function QueueTranslator(props) {
      var useProjection = props !== null && props !== undefined ? props.useProjection : null
      var updateQueue = props !== null && props !== undefined ? props.updateQueue : null
      var inbox = typeof useProjection === 'function' ? useProjection('inbox') : undefined
      useStore()

      React.useEffect(function () {
        if (store.enabled !== true || readSendTranslation() !== true) return
        if (typeof updateQueue !== 'function') return
        var rows = inbox !== null && inbox !== undefined && Array.isArray(inbox['next-turn']) ? inbox['next-turn'] : []
        for (var i = 0; i < rows.length; i += 1) {
          var row = rows[i]
          if (row === null || row === undefined || row.id === undefined) continue
          var id = String(row.id)
          var text = queueRowText(row)
          if (text.trim() === '' || !needsEnglish(text, localLanguage)) continue
          if (queueSeen[id] === true) continue
          queueSeen[id] = true
          translateQueueRow(id, text, updateQueue)
        }
      }, [inbox])

      return null
    }

    function registerQueueTranslator(ctx) {
      try {
        ctx.slots.inject('conversation.input.dock', function () {
          return ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'shadow-bilingual-queue',
              order: 30,
              inject: function (sessionId) {
                // 与官方 QueueDock 相同的取法：会话作用域里的 conversation 服务
                var sessions = undefined
                try {
                  if (ctx.sessions !== undefined) sessions = ctx.sessions
                  else if (typeof ctx.get === 'function') sessions = ctx.get('sessions')
                } catch (ignored) {
                  sessions = undefined
                }
                if (sessions === undefined || sessions === null) return {}
                var scoped = sessions.scope(sessionId)
                if (scoped === undefined) return {}
                var conversation = scoped.get('conversation')
                if (conversation === undefined) return {}
                return {
                  updateQueue: function (itemId, action) {
                    return conversation.updateQueue(itemId, action)
                  },
                }
              },
            },
            QueueTranslator,
          )
        })
      } catch (error) {
        try {
          console.warn('[shadow-bilingual] 队列翻译注册失败：', error)
        } catch (ignored) {
          // 忽略
        }
      }
    }

    /** 输入框上方的实时译文面板 + 「发送译文」勾选框。 */
    // -------------------------------------------------- 输入框内的影子译文
    //
    // 用户反馈（m01277）：译文放在下方 dock「位置不好」，希望像真正的影子输入
    // 一样直接出现在输入框里。做法：在编辑器的滚动容器里插一个只读 ghost 节点，
    // 紧跟在可编辑区之后，沿用同一套字号/行高/内边距——读起来就是草稿正文下面
    // 的灰色续写，而不是另一块 UI。
    var ghostNode = null

    function ghostHost() {
      if (typeof document === 'undefined') return null
      // 挂在输入卡片里、紧跟文本区之后。
      // 不挂进 [data-input-scroll]：那个容器有 14 行高度上限并自带滚动，
      // 长草稿时影子会被裁掉——用户反馈「看不到完整译文」就是这么来的。
      // 优先选「焦点所在」的那个输入卡片：页面上可能同时挂着 hero 输入区
      // 和会话输入区，直接取第一个会把影子画到看不见的那一个上。
      var active = document.activeElement
      if (active !== null && active !== undefined && typeof active.closest === 'function') {
        // 焦点在插话框里：那不是 composer，不能把插话文字画到主输入框上。
        if (active.classList && active.classList.contains('dsh-steer-note-input')) return null
        var focusedCard = active.closest('[data-composer-card]')
        if (focusedCard !== null && focusedCard !== undefined) return focusedCard
      }
      var scroller = document.querySelector('[data-input-scroll]')
      var card = null
      if (scroller !== null && scroller !== undefined && typeof scroller.closest === 'function') {
        card = scroller.closest('[data-composer-card]')
      }
      if (card === null || card === undefined) card = document.querySelector('[data-composer-card]')
      return card === null || card === undefined ? null : card
    }

    /** 保证 ghost 节点挂在输入卡片里（React 重渲染可能把它摘掉）。 */
    function ensureGhost() {
      var host = ghostHost()
      if (host === null || host === undefined) return null
      if (ghostNode !== null && ghostNode.parentNode === host) return ghostNode
      if (ghostNode === null) {
        ghostNode = document.createElement('div')
        ghostNode.className = 'sbp-en-ghost'
        ghostNode.setAttribute('aria-hidden', 'true')
      }
      // 紧跟文本区插入，而不是追加到卡片末尾——否则会跑到按钮行下面
      var scroller = host.querySelector === undefined ? null : host.querySelector('[data-input-scroll]')
      if (scroller !== null && scroller !== undefined && scroller.parentNode === host) {
        host.insertBefore(ghostNode, scroller.nextSibling)
      } else {
        host.appendChild(ghostNode)
      }
      return ghostNode
    }

    /**
     * React 不认识我们插进去的节点：卡片重渲染时可能把 ghost 摘掉。
     * 用 MutationObserver 盯着卡片，被摘了就按当前影子状态补回去。
     */
    var ghostObserver = null

    function watchGhost() {
      if (ghostObserver !== null || typeof MutationObserver !== 'function') return
      var host = ghostHost()
      if (host === null || host === undefined) return
      ghostObserver = new MutationObserver(function () {
        if (shadow.english === '' && shadow.phase !== 'pending') return
        if (ghostNode !== null && ghostNode.parentNode !== null) return
        try {
          renderGhost(shadow.source)
        } catch (ignored) {
          // 编辑器还没挂好，下次 emit 再说
        }
      })
      try {
        ghostObserver.observe(host, { childList: true })
      } catch (ignored) {
        ghostObserver = null
      }
    }

    function removeGhost() {
      if (ghostNode !== null && ghostNode.parentNode !== null && ghostNode.parentNode !== undefined) {
        ghostNode.parentNode.removeChild(ghostNode)
      }
    }

    /** 画影子：有本段译文就显示译文，翻译中就显示状态占位。 */
    function renderGhost(text) {
      var value = String(text === null || text === undefined ? '' : text)
      if (!shadowWanted(value)) {
        removeGhost()
        return
      }
      var node = ensureGhost()
      if (node === null) return
      watchGhost()

      // 只要手里有译文就先显示出来——哪怕它对应的是上一版草稿。
      // 清空再重画就是用户说的「闪一下」；宁可标个「更新中…」。
      var stale = !sameDraft(shadow.source, value)
      var pending = shadow.phase === 'pending'
      var body = shadow.english !== '' ? shadow.english : ''
      var status = ''
      if (body !== '' && (stale || pending)) status = '更新中…'
      else if (body === '' && pending) status = ''
      if (shadow.error !== '' && !pending && !stale) status = '翻译失败，将发送原文'

      node.textContent = ''
      var textNode = document.createElement('span')
      textNode.className = body === '' ? 'sbp-en-ghost-text sbp-en-ghost-empty' : 'sbp-en-ghost-text'
      textNode.textContent = body !== '' ? body : pending ? '翻译中…' : ''
      if (textNode.textContent === '') {
        removeGhost()
        return
      }
      node.appendChild(textNode)
      // 状态只在「已有译文、但正在更新」时补一行，避免和占位文字重复
      if (status !== '' && body !== '') {
        var statusNode = document.createElement('span')
        statusNode.className = 'sbp-en-ghost-status'
        statusNode.textContent = status
        node.appendChild(statusNode)
      }
      node.setAttribute('data-phase', shadow.phase)
    }

    function LiveTranslationPanel(props) {
      var useInput = props !== null && props !== undefined && typeof props.useInput === 'function' ? props.useInput : null
      var draft = useInput === null
        ? ''
        : useInput(function (state) {
          return state !== null && state !== undefined && typeof state.draft === 'string' ? state.draft : ''
        })
      useStore()
      useShadow()
      var sendPair = React.useState(readSendTranslation())
      var checked = sendPair[0]
      var setChecked = sendPair[1]

      React.useEffect(function () {
        var actions = props !== null && props !== undefined ? props.inputActions : null
        composerBridge.actions = actions === undefined ? null : actions
        return function () {
          if (composerBridge.actions === (actions === undefined ? null : actions)) composerBridge.actions = null
        }
      }, [props])

      var text = typeof draft === 'string' ? draft : ''
      var current = String(shadow.source)
      var normalized = String(text === null || text === undefined ? '' : text)

      // 草稿变化后延迟一小会儿再算影子译文：按「停顿」触发，不是每次按键。
      // 用户明确要求：不要翻得太即时，输入没停会反复翻。
      React.useEffect(function () {
        composerSource = normalized
        if (!shadowWanted(normalized)) {
          if (shadow.phase !== 'idle' || shadow.source !== '') {
            shadowReset()
            shadowEmit()
          }
          return
        }
        if (sameDraft(current, normalized) && shadow.phase !== 'idle') return
        var timer = setTimeout(function () {
          shadowRefresh(normalized, false)
        }, SHADOW_DEBOUNCE_MS)
        return function () {
          clearTimeout(timer)
        }
      }, [normalized, checked])

      // 影子画在输入框里（见 renderGhost），面板只留勾选框 + 一句状态
      React.useEffect(function () {
        renderGhost(normalized)
      }, [normalized, shadow.phase, shadow.english, shadow.seq])

      if (store.enabled !== true) return null

      var showTranslation = normalized.trim() !== '' && needsEnglish(normalized, localLanguage)
      var pending = shadow.phase === 'pending'
      var ready = shadow.phase === 'ready'
      var tip = pending ? '翻译中…（完成后自动发送）' : ready ? '已就绪' : shadow.error !== '' ? '翻译失败，将发送原文' : ''

      return h(
        'div',
        { className: 'sbp-en-panel', id: 'sbp-en-panel', 'data-active': showTranslation ? '1' : '0', 'data-phase': shadow.phase },
        h(
          'div',
          { className: 'sbp-en-row' },
          h(
            'label',
            { className: 'sbp-en-check' },
            h('input', {
              type: 'checkbox',
              checked: checked,
              onChange: function (event) {
                var value = event.target.checked === true
                writeSendTranslation(value)
                setChecked(value)
                if (value === false) {
                  shadowReset()
                  shadowEmit()
                } else if (normalized.trim() !== '') {
                  shadowRefresh(normalized, true)
                }
              },
            }),
            h('span', { className: 'sbp-en-check-label' }, '发送译文'),
          ),
          showTranslation === true && ready
            ? h('span', { className: 'sbp-en-lang' }, 'EN')
            : tip !== ''
              ? h('span', { className: 'sbp-en-lang' }, tip)
              : null,
        ),
      )
    }

    /**
     * 「英文译文 → 用户原始中文」的映射，用来在消息气泡里回显中文原文。
     *
     * 为什么需要它：`conversation.chat.user.before` 的 source 只有 rpcId，
     * 拿不到正文，所以发送时必须自己记一份。
     */
    var SENT_KEY = 'shadow-bilingual.sent.v1'
    var PREVIOUS_SENT_KEY_OLD = 'dsh-bilingual-en.sent.v1'
    var SENT_LIMIT = 200
    var sentCache = null

    function sentKey(text) {
      var value = String(text === null || text === undefined ? '' : text)
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
      if (value === '') return ''
      // 长文本用轻量哈希，避免 localStorage 键爆炸
      if (value.length <= 120) return value
      var hash = 0
      for (var i = 0; i < value.length; i += 1) {
        hash = (hash * 31 + value.charCodeAt(i)) | 0
      }
      return 'h' + value.length + ':' + hash
    }

    function sentMap() {
      if (sentCache !== null) return sentCache
      var raw = safeGetStorage('local', SENT_KEY)
      if (raw === null || raw === '') {
        // 改名前的「英文 → 中文原文」映射也搬过来，
        // 否则老消息气泡下会突然没有中文对照。
        var previous = safeGetStorage('local', PREVIOUS_SENT_KEY)
        if (previous !== null && previous !== '') {
          raw = previous
          safeSetStorage('local', SENT_KEY, previous)
        }
      }
      var parsed = null
      try {
        parsed = raw === null || raw === '' ? null : JSON.parse(raw)
      } catch (error) {
        parsed = null
      }
      sentCache = parsed !== null && typeof parsed === 'object' ? parsed : {}
      return sentCache
    }

    function recordSent(english, chinese) {
      var key = sentKey(english)
      if (key === '' || typeof chinese !== 'string' || chinese.trim() === '') return
      try {
        var map = sentMap()
        map[key] = chinese.trim()
        var keys = Object.keys(map)
        if (keys.length > SENT_LIMIT) {
          for (var i = 0; i < keys.length - SENT_LIMIT; i += 1) delete map[keys[i]]
        }
        safeSetStorage('local', SENT_KEY, JSON.stringify(map))
      } catch (error) {
        // 存不下只影响回显
      }
    }

    function sentOrigin(english) {
      var map = sentMap()
      var value = map[sentKey(english)]
      return typeof value === 'string' ? value : ''
    }

    // ------------------------------------------------------- 用户消息双语
    //
    // 事实（实测）：`conversation.chat.user.before` 只拿到持久化 source
    // `{kind, rpcId, clientTimeZone}`，没有正文；`conversation.chat.user.content`
    // 是单例 Factory，外部再次注册不会被选中（注册不报错、组件也不渲染）。
    // 真正能接管的是 keyed 槽位 `conversation.user.text.node` 的 `text` 键
    // ——它在气泡内部渲染正文，官方占用者是 PlainUserText，替换它不影响
    // 附件与引用行。

    /** 这一段是不是本地语言（用于判断气泡里要不要补一行原文）。 */
    function isLocalText(text, code) {
      var base = String(code || '').split('-')[0]
      var plain = String(text === null || text === undefined ? '' : text)
      if (base === 'zh') return countCjk(plain) >= 1
      if (base === 'ja') return /[\u3040-\u309f\u30a0-\u30ff]/.test(plain)
      if (base === 'ko') return /[\uac00-\ud7af]/.test(plain)
      if (base === 'ru') return /[\u0400-\u04ff]/.test(plain)
      if (base === 'ar') return /[\u0600-\u06ff]/.test(plain)
      if (base === 'he') return /[\u0590-\u05ff]/.test(plain)
      if (base === 'hi') return /[\u0900-\u097f]/.test(plain)
      if (base === 'th') return /[\u0e00-\u0e7f]/.test(plain)
      // 拉丁字母语言：和英文无法靠字符集区分，交给缓存里的译文比对
      return false
    }

    /**
     * 英文正文 → 本地语言原文：先查发送时记下的映射，再退回译文缓存。
     *
     * 映射（SENT_KEY）是主路径：发送那一刻原文是什么，我们最清楚。
     * 缓存是兜底：老消息、或重启后映射丢了，就看看有没有存着本地语言译文。
     */
    function userLocalOrigin(text) {
      var remembered = sentOrigin(text)
      if (remembered !== '') {
        // 中文/日文/韩文等：必须真的是本地文字才算原文
        if (isLocalText(remembered, localLanguage)) return remembered
        // 拉丁字母语言：只要和正文不同、且像本地译文，就认
        var base = localLanguage.split('-')[0]
        var latinOnly = ['es', 'fr', 'de', 'pt', 'it', 'nl', 'pl', 'tr', 'vi', 'id']
        if (latinOnly.indexOf(base) !== -1 && sameDraft(remembered, text) === false) return remembered
      }
      var units = ShadowMarkdown.splitUnits(text)
      var parts = []
      var base2 = localLanguage.split('-')[0]
      for (var i = 0; i < units.length; i += 1) {
        var unit = units[i]
        var target = localTargetFor(unit)
        if (target === null) continue
        var value = cachedValue(unit, localLanguage)
        if (value === null) continue
        if (isLocalText(value, localLanguage) || (['es', 'fr', 'de', 'pt', 'it', 'nl', 'pl', 'tr', 'vi', 'id'].indexOf(base2) !== -1 && !isLocalText(unit.content, 'en'))) {
          parts.push(value)
        }
      }
      return parts.join('\n\n')
    }

    /** 气泡内的用户正文：原样显示发送内容，英文时下方补一行本地语言原文。 */
    function PlainUserTextBilingual(props) {
      useStore()
      var node = props !== null && props !== undefined ? props.node : null
      var data = node !== null && node !== undefined && node.data !== null && node.data !== undefined ? node.data : null
      var text = ''
      if (data !== null) {
        if (typeof data.display === 'string' && data.display !== '') text = data.display
        else if (typeof data.text === 'string') text = data.text
      }
      if (text === '' && props !== null && props !== undefined && typeof props.raw === 'string') text = props.raw
      var body = text
      var origin = ''
      if (store.enabled === true && text.trim() !== '' && !isLocalText(text, localLanguage)) origin = userLocalOrigin(text)
      if (store.enabled === true && text.trim() !== '') pushContext('en', text)
      if (origin !== '') pushContext(localLanguage, origin)
      if (origin === '') return h('span', { className: 'sbp-user-text' }, body)
      return h(
        'span',
        { className: 'sbp-user-text' },
        body,
        h(
          'span',
          { className: 'sbp-en-user-origin' },
          h('span', { className: 'sbp-en-lang' }, localLanguageEntry(localLanguage).tag),
          h('span', null, origin),
        ),
      )
    }

    function registerUserText(ctx) {
      try {
        ctx.slots.inject('conversation.user.text.node', function () {
          return ctx.slots.register(
            { name: 'conversation.user.text.node', key: 'text' },
            PlainUserTextBilingual,
          )
        })
      } catch (error) {
        try {
          console.warn('[shadow-bilingual] 用户正文双语渲染注册失败：', error)
        } catch (ignored) {
          // 忽略
        }
      }
    }

    // ---------------------------------------------------------------- 注册

    function registerAssistant(ctx) {
      try {
        ctx.slots.inject('conversation.chat.node', function () {
          return ctx.slots.register(
            {
              name: 'conversation.chat.node',
              key: 'assistant-step',
              locale: 'chat',
              priority: -10,
            },
            function (props) {
              return h(AssistantBoundary, props, h(AssistantStep, props))
            },
          )
        })
      } catch (error) {
        try {
          console.error('[shadow-bilingual] assistant-step 注册失败：', error)
        } catch (ignored) {
          // 忽略
        }
      }
    }

    function registerLivePanel(ctx) {
      try {
        ctx.slots.inject('conversation.composer.dock', function () {
          return ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'shadow-bilingual-live',
              order: 20,
              label: function () {
                return '英文对照'
              },
            },
            LiveTranslationPanel,
          )
        })
      } catch (error) {
        try {
          console.warn('[shadow-bilingual] 输入框实时译文面板注册失败：', error)
        } catch (ignored) {
          // 忽略
        }
      }
    }

    function registerToggle(ctx) {
      try {
        ctx.slots.inject('conversation.session.header.actions', function () {
          return ctx.slots.register(
            {
              name: 'conversation.session.header.actions',
              id: 'shadow-bilingual-toggle',
              order: 60,
              label: function () {
                return '双语'
              },
            },
            ToggleButton,
          )
        })
      } catch (error) {
        try {
          console.warn('[shadow-bilingual] 会话头开关注册失败，可在 设置 → 双语 中开启：', error)
        } catch (ignored) {
          // 忽略
        }
      }
    }

    function registerSettings(ctx) {
      try {
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register(
            {
              name: 'settings.section',
              id: 'shadow-bilingual',
              order: 47,
              locale: 'shadow-bilingual',
              label: function () {
                return '双语'
              },
            },
            SettingsPage,
          )
        })
      } catch (error) {
        try {
          console.warn('[shadow-bilingual] 设置页注册失败：', error)
        } catch (ignored) {
          // 忽略
        }
      }
    }

    function apply(ctx) {
      installStyles(ctx)
      registerAssistant(ctx)
      registerLivePanel(ctx)
      registerQueueTranslator(ctx)
      registerUserText(ctx)
      installSubmitInterceptor(ctx)
      registerToggle(ctx)
      registerSettings(ctx)
      try {
        ctx.logger?.info?.('[shadow-bilingual] 浏览器半已加载')
      } catch (error) {
        // 忽略
      }
    }

    module.exports = {
      name: 'shadow-bilingual',
      // 只硬依赖 slots。sessions 走 ctx.get 惰性获取——
      // 声明成 inject 的话，该服务缺失会让整个插件加载失败，
      // 连带助手双语、输入框译文全部失效，代价太大。
      inject: ['slots'],
      apply: apply,
      __internals: {
        store: store,
        pushContext: pushContext,
        contextBrief: contextBrief,
        clearContext: function () {
          contextBuffer.length = 0
        },
        ensureTranslations: ensureTranslations,
        translationsFor: translationsFor,
        decorate: ShadowMarkdown.decorate,
        splitUnits: ShadowMarkdown.splitUnits,
        translationTarget: ShadowMarkdown.translationTarget,
        needsEnglish: ShadowMarkdown.needsEnglish,
        languageOf: ShadowMarkdown.languageOf,
        translationLooksValid: ShadowMarkdown.translationLooksValid,
        localLanguages: LOCAL_LANGUAGES,
        readLocalLanguage: readLocalLanguage,
        writeLocalLanguage: writeLocalLanguage,
      },
    }
    return module.exports
  },
})
