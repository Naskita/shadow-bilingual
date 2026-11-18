/**
 * 滚动探测：搞清楚「对话进行到一半，视口自己往回跳几个来回」到底是哪个事件锁住了
 * 尾随（followingTail），并把现场记下来。
 *
 * 背景（读 dsh-client-ui-chat 得出，非猜测）：
 * - 尾随状态只有一处会被关掉：`ChatReading.interruptFollow()` → `follow.setFollowing(false)`，
 *   它会把 `target` 置空，之后不再追底。
 * - 触发它的是 `ChatViewport.onIntent`，监听 READING_INTENTS =
 *   [wheel, touchstart, pointerdown, keydown, beforematch]；keydown 只认
 *   SCROLL_KEYS = [ArrowUp, ArrowDown, PageUp, PageDown, Home, End, Space]，
 *   且只跳过 `[data-composer-seat]` 里的。点击会话正文、滚轮、触摸都会关掉尾随。
 * - 关掉之后要**重新**打开，需要某次 scroll 事件落到离底 25px 以内；而
 *   `onResize()` 只在 `followingTail` 已为真时才 followTail，不会自己恢复。
 * - 另有 CSS 兜底：`[data-chat-following-tail]` 存在时给滚动容器加 `overflow-anchor:none`，
 *   所以浏览器原生 scroll-anchoring 不是这个 bug 的主因（这点要实测确认）。
 *
 * 这个探测只读、只记录，不改任何行为。数据只留在本地 window.__SBP_SCROLL_LOG__，
 * 可用 __SBP_SCROLL_DUMP__() 取，__SBP_SCROLL_RESET__() 清空。
 */
;(function (root) {
  if (root === null || root === undefined) return
  if (root.__SBP_SCROLL_PROBE__ === true) return

  var LOG_LIMIT = 4000
  var log = []
  var seq = 0

  function now() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
  }

  function record(kind, extra) {
    seq += 1
    var entry = { seq: seq, t: Math.round(now()), kind: kind }
    if (extra !== undefined && extra !== null) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) entry[key] = extra[key]
      }
    }
    log.push(entry)
    if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT)
    return entry
  }

  // 对话区的滚动容器。首屏用 [data-conversation-scroll]，会话内真正滚的是 .tnXGgG_scroll
  // （data-conversation-scroll 在会话里变成 overflow:visible 的外壳）。
  function scrollers() {
    var out = []
    var nodes = document.querySelectorAll('[data-conversation-scroll], [data-chat-root] .tnXGgG_scroll')
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i]
      if (node.scrollHeight > node.clientHeight || node.getAttribute('data-conversation-scroll') !== null) {
        out.push(node)
      }
    }
    return out
  }

  function metrics(node) {
    if (node === null || node === undefined) return null
    var height = node.clientHeight
    return {
      top: Math.round(node.scrollTop),
      height: height,
      floor: Math.round(Math.max(0, node.scrollHeight - height)),
      gap: Math.round(Math.max(0, node.scrollHeight - height - node.scrollTop)),
      sh: node.scrollHeight,
    }
  }

  // 尾随标志在 DOM 上的投影；没有它就说明「跟随到底」已经关了。
  function followingTail() {
    var root = document.querySelector('[data-chat-following-tail]')
    return root !== null
  }

  function anchorState(node) {
    var computed = window.getComputedStyle(node)
    return {
      overflowAnchor: computed.overflowAnchor || '',
      followingAttr: followingTail(),
    }
  }

  // 点按钮那一刻的现场：用户最想知道的就是「现在到底还跟不跟随、离底多远」。
  function liveState() {
    try {
      var list = scrollers()
      if (list.length === 0) return { note: 'no scroller matched', followingTail: followingTail() }
      var picked = list[list.length - 1]
      return {
        followingTail: followingTail(),
        overflowAnchor: anchorState(picked).overflowAnchor,
        m: metrics(picked),
        node: describeTarget(picked),
      }
    } catch (error) {
      return { error: String(error) }
    }
  }

  function describeTarget(target) {    if (target === null || target === undefined) return ''
    if (typeof target.tagName !== 'string') return String(target).slice(0, 40)
    var el = target
    var id = el.id ? '#' + el.id : ''
    var cls = typeof el.className === 'string' && el.className !== '' ? '.' + el.className.split(' ')[0] : ''
    return el.tagName.toLowerCase() + id + cls
  }

  function sampleAll(kind, extra) {
    var list = scrollers()
    var picked = list.length > 0 ? list[list.length - 1] : null
    var base = extra === undefined || extra === null ? {} : extra
    base.scrollers = list.length
    base.m = metrics(picked)
    base.anchor = picked === null ? null : anchorState(picked)
    return record(kind, base)
  }

  function install() {
    // 1) 会关掉尾随的「阅读意图」事件
    var intents = ['wheel', 'touchstart', 'pointerdown', 'keydown', 'beforematch']
    for (var i = 0; i < intents.length; i += 1) {
      ;(function (type) {
        document.addEventListener(
          type,
          function (event) {
            var target = event.target
            // 输入框里的按键不算阅读意图（shell 也这么判）
            var inComposer = false
            try {
              inComposer =
                target instanceof Element && target.closest('[data-composer-seat]') !== null
            } catch (error) {
              inComposer = false
            }
            var scrollerKeys = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']
            if (type === 'keydown' && scrollerKeys.indexOf(event.key) === -1) return
            sampleAll('intent', {
              type: type,
              key: type === 'keydown' ? String(event.key) : undefined,
              target: describeTarget(target),
              inComposer: inComposer,
              trusted: event.isTrusted === true,
            })
          },
          { passive: true, capture: true },
        )
      })(intents[i])
    }

    // 2) 滚动本身：看视口到底被谁挪了
    document.addEventListener(
      'scroll',
      function (event) {
        var target = event.target
        if (!(target instanceof Element)) return
        if (target.getAttribute('data-conversation-scroll') === null && !target.classList.contains('tnXGgG_scroll')) return
        sampleAll('scroll', { target: describeTarget(target), trusted: event.isTrusted === true })
      },
      { passive: true, capture: true },
    )

    // 3) 内容变大：尾随期间长高是「应该跟到底」的时刻，不跟就是问题
    if (typeof ResizeObserver !== 'undefined') {
      var observer = new ResizeObserver(function () {
        sampleAll('resize', {})
      })
      var nodes = document.querySelectorAll('[data-conversation-scroll], [data-chat-root] .tnXGgG_column')
      for (var j = 0; j < nodes.length; j += 1) observer.observe(nodes[j])
      root.__SBP_SCROLL_OBSERVER__ = observer
    }

    // 4) 流式过程中反复采样：跳变会在这些点上暴露「gap 突然变大」
    var timer = window.setInterval(function () {
      var list = scrollers()
      if (list.length === 0) return
      var picked = list[list.length - 1]
      var m = metrics(picked)
      if (m === null) return
      var last = null
      for (var k = log.length - 1; k >= 0; k -= 1) {
        if (log[k].m !== undefined && log[k].m !== null) {
          last = log[k].m
          break
        }
      }
      // 只在「状态发生变化」时记录，避免刷屏
      var changedGap = last === null || Math.abs(m.gap - last.gap) > 24
      var changedTail = last === null || followingTail() !== anchorState(picked).followingAttr
      if (!changedGap && !changedTail) return
      sampleAll('tick', { prevGap: last === null ? null : last.gap })
    }, 400)
    root.__SBP_SCROLL_TIMER__ = timer

    root.__SBP_SCROLL_INSTALLED_AT__ = new Date().toISOString()
    root.__SBP_SCROLL_LOG__ = log
    root.__SBP_SCROLL_DUMP__ = function () {
      return JSON.stringify(log, null, 0)
    }
    root.__SBP_SCROLL_SUMMARY__ = function () {
      var intents = 0
      var byType = {}
      var tailFlips = []
      var prevTail = null
      var maxGapAfterIntent = 0
      for (var i = 0; i < log.length; i += 1) {
        var e = log[i]
        if (e.kind === 'intent') {
          intents += 1
          byType[e.type] = (byType[e.type] || 0) + 1
        }
        if (e.anchor !== undefined && e.anchor !== null) {
          if (prevTail !== null && e.anchor.followingAttr !== prevTail) {
            tailFlips.push({ seq: e.seq, from: prevTail, to: e.anchor.followingAttr, kind: e.kind, type: e.type })
          }
          prevTail = e.anchor.followingAttr
        }
        if (e.kind === 'intent' && e.m !== null && e.m !== undefined && e.m.gap > maxGapAfterIntent) {
          maxGapAfterIntent = e.m.gap
        }
      }
      return JSON.stringify(
        {
          // 用户看到这个摘要时的第一眼信息：到底有没有在记、记到了什么。
          entries: log.length,
          installedAt: root.__SBP_SCROLL_INSTALLED_AT__ || null,
          now: new Date().toISOString(),
          scrollers: scrollers().length,
          live: liveState(),
          intents: intents,
          intentsByType: byType,
          tailFlips: tailFlips,
          maxGapAtIntent: maxGapAfterIntent,
          // 逐条列出最近事件：聚合计数看着「什么都没发生」，尾部原文才看得出来。
          lastEntries: log.slice(-12),
        },
        null,
        2,
      )
    }
    root.__SBP_SCROLL_RESET__ = function () {
      log.length = 0
      seq = 0
    }
    root.__SBP_SCROLL_PROBE__ = true
    record('installed', {})
  }

  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', install, { once: true })
    } else {
      install()
    }
  } catch (error) {
    // 探测失败绝不能影响插件本体
    try {
      console.warn('[shadow-bilingual] scroll probe failed', error)
    } catch (ignored) {
      // 忽略
    }
  }
})(typeof window === 'undefined' ? null : window)
