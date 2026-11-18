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

    var ShadowMarkdown = (function () {
      var module = { exports: {} }
      var exports = module.exports
/**
 * shadow-bilingual —— Markdown 段落切分与双语拼装（纯函数，可在 Node 里单测）。
 *
 * 设计目标：**不重排原文的 Markdown 结构**，只在每段原文后面插入一段译文。
 * 因此这里做的是“行级切分 + 行尾插入”，而不是把 Markdown 解析成 AST：
 *   - 段落：在段尾插入空行 + 译文；
 *   - 列表项：在列表项自己的文字后面插入空行 + 缩进后的译文（仍属于同一个 <li>）；
 *   - 标题：译文直接拼在标题行末尾（截图里的 `3. 重要物理性质 3. Important...`）；
 *   - 引用：插入 `>` 空行 + `> 译文`；
 *   - 代码块、表格、块级公式、HTML 块：原样跳过，绝不翻译。
 *
 * 这个文件是 CommonJS；build.mjs 会把它内联进浏览器 bundle，tests 直接 require 它。
 */

'use strict'

var CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/g
var LATIN_RE = /[A-Za-z]/g

/**
 * 书写系统探测表。只用来回答「这段文字是不是英文」以及「它大概是什么语言」，
 * 不参与翻译本身——真正的译文永远由模型给出。
 */
var SCRIPT_RES = {
  kana: /[\u3040-\u309f\u30a0-\u30ff]/g, // 平假名 + 片假名
  hangul: /[\uac00-\ud7af\u1100-\u11ff]/g, // 谚文
  cyrillic: /[\u0400-\u04ff]/g,
  arabic: /[\u0600-\u06ff\u0750-\u077f]/g,
  hebrew: /[\u0590-\u05ff]/g,
  devanagari: /[\u0900-\u097f]/g,
  thai: /[\u0e00-\u0e7f]/g,
}

function countMatches(text, regex) {
  var matches = String(text).match(regex)
  return matches === null ? 0 : matches.length
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line)
}

function isHorizontalRule(line) {
  return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)
}

function isFenceStart(line) {
  return /^\s*(`{3,}|~{3,})/.test(line)
}

var BLOCK_TAG_RE = /^\s*<(?:address|article|aside|blockquote|details|div|dl|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|main|nav|ol|p|pre|section|summary|table|ul|video|audio|iframe|script|style|svg)\b/i

function isBlockStart(line) {
  return (
    /^(#{1,6})\s+/.test(line) ||
    /^\s*>/.test(line) ||
    isFenceStart(line) ||
    /^\s*\$\$/.test(line) ||
    isHorizontalRule(line) ||
    /^\s*([-*+]|\d+[.)])\s+/.test(line) ||
    BLOCK_TAG_RE.test(line)
  )
}

/**
 * 把一段 Markdown 切成可翻译单元。
 * 返回的每个单元都带 lineStart / lineEnd（0 基、含端点）与 content。
 */
function splitUnits(text) {
  var source = typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : ''
  var lines = source.split('\n')
  var units = []
  var i = 0

  while (i < lines.length) {
    var line = lines[i]

    if (line.trim() === '') {
      i += 1
      continue
    }

    // 代码围栏：整块跳过（含未闭合的尾巴）
    if (isFenceStart(line)) {
      var fenceMatch = line.match(/^\s*(`{3,}|~{3,})/)
      var fenceChar = fenceMatch[1].charAt(0)
      var fenceLen = fenceMatch[1].length
      i += 1
      while (i < lines.length) {
        var closeMatch = lines[i].match(/^\s*(`{3,}|~{3,})\s*$/)
        if (closeMatch !== null && closeMatch[1].charAt(0) === fenceChar && closeMatch[1].length >= fenceLen) {
          i += 1
          break
        }
        i += 1
      }
      continue
    }

    // 块级公式 $ ... $
    if (/^\s*\$\$/.test(line)) {
      i += 1
      while (i < lines.length && !/\$\$\s*$/.test(lines[i])) i += 1
      i += 1
      continue
    }

    // 表格：表头 + 分隔行 + 连续含 | 的行。整表作为一个单元，
    // 译文以一张完整的表追加在原文表格下方（保持行/列不变）。
    if (line.indexOf('|') !== -1 && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      var tableStart = i
      var tableLines = [line, lines[i + 1]]
      i += 2
      while (i < lines.length && lines[i].trim() !== '' && lines[i].indexOf('|') !== -1) {
        tableLines.push(lines[i])
        i += 1
      }
      var tableContent = tableLines.join('\n').trim()
      if (tableContent !== '') {
        units.push({
          kind: 'table',
          lineStart: tableStart,
          lineEnd: i - 1,
          content: tableContent,
        })
      }
      continue
    }

    // 块级 HTML：整块跳过
    if (BLOCK_TAG_RE.test(line)) {
      i += 1
      while (i < lines.length && lines[i].trim() !== '') i += 1
      continue
    }

    // 标题
    var headingMatch = line.match(/^(#{1,6})\s+(.*)$/)
    if (headingMatch !== null) {
      var headingContent = headingMatch[2].replace(/\s+#+\s*$/, '').trim()
      if (headingContent !== '') {
        units.push({
          kind: 'heading',
          lineStart: i,
          lineEnd: i,
          content: headingContent,
        })
      }
      i += 1
      continue
    }

    // 列表项
    var listMatch = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
    if (listMatch !== null) {
      var indent = listMatch[1].length
      var marker = listMatch[2]
      var contentIndent = indent + marker.length + 1
      var j = i + 1
      while (j < lines.length) {
        var next = lines[j]
        if (next.trim() === '') break
        var lead = next.match(/^\s*/)[0].length
        var nextIsMarker = /^(\s*)([-*+]|\d+[.)])\s+/.test(next)
        if (nextIsMarker) break
        if (lead <= indent) break
        j += 1
      }
      var contentLines = lines.slice(i, j)
      var firstContent = listMatch[3]
      var rest = contentLines.slice(1).map(function (part) {
        return part.replace(new RegExp('^\\s{0,' + contentIndent + '}'), '')
      })
      var listContent = [firstContent].concat(rest).join('\n').trim()
      if (listContent !== '') {
        units.push({
          kind: 'list',
          lineStart: i,
          lineEnd: j - 1,
          content: listContent,
          indent: indent,
          contentIndent: contentIndent,
        })
      }
      i = j
      continue
    }

    // 引用
    if (/^\s*>/.test(line)) {
      var q = i
      var quoteParts = []
      while (q < lines.length && /^\s*>/.test(lines[q])) {
        quoteParts.push(lines[q].replace(/^\s*>\s?/, ''))
        q += 1
      }
      var quoteContent = quoteParts.join('\n').trim()
      if (quoteContent !== '') {
        units.push({
          kind: 'quote',
          lineStart: i,
          lineEnd: q - 1,
          content: quoteContent,
        })
      }
      i = q
      continue
    }

    // 分隔线
    if (isHorizontalRule(line)) {
      i += 1
      continue
    }

    // 缩进代码块（4 空格 / Tab 开头，且不是列表）：整块跳过
    if (/^( {4,}|\t)/.test(line) && !/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      i += 1
      while (i < lines.length && (lines[i].trim() === '' || /^( {4,}|\t)/.test(lines[i]))) i += 1
      continue
    }

    // 普通段落
    var p = i
    var paragraphParts = []
    while (p < lines.length && lines[p].trim() !== '') {
      if (p > i && isBlockStart(lines[p])) break
      if (p > i && lines[p].indexOf('|') !== -1 && p + 1 < lines.length && isTableSeparator(lines[p + 1])) break
      paragraphParts.push(lines[p])
      p += 1
    }
    if (p === i) {
      i += 1
      continue
    }
    var paragraphContent = paragraphParts.join('\n').trim()
    if (paragraphContent !== '') {
      units.push({
        kind: 'paragraph',
        lineStart: i,
        lineEnd: p - 1,
        content: paragraphContent,
      })
    }
    i = p
  }

  return units
}

/** 译文缓存键：同文不同结构（标题 / 列表 / 段落）分开存，避免缓存串味。
 *  第三个参数是目标语言——同一段英文在「本地语种 = 日文」和「本地语种 = 中文」
 *  下是两条不同的译文，必须分开存，否则切换语种会读到上一种语言的旧译文。 */
function unitKey(unit, target) {
  var suffix = typeof target === 'string' && target !== '' ? target : ''
  return unit.kind + '\u0000' + suffix + '\u0000' + unit.content
}

/** 去掉 Markdown 标记后再判断语言，避免代码/公式/链接干扰。 */
function textForLanguage(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\$[^$]*\$/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_~>#]/g, ' ')
}

/**
 * 简繁判别：显示语言选 zh 或 zh-TW 时，得先知道原文是哪一种，
 * 否则「简体 → 繁体」（或反过来）这件事永远不会发生。
 * 只数两种字形的命中数，不做整段转换——真正的转换交给模型。
 */
var TRAD_ONLY = '這個們進學國說時對為與關開發還會讓樣點產區嚴選總認識語譯話龍麼後來問見現實際應該無係東車書寫讀聽獨'
var SIM_ONLY = '这个们进学国说时对为与关开发还会让样产区严选总认识语译话龙么后来问见现实际应该无系东车书写读听独'

function looksTraditional(text) {
  var src = String(text)
  var trad = 0
  var sim = 0
  for (var i = 0; i < src.length; i += 1) {
    var ch = src[i]
    if (TRAD_ONLY.indexOf(ch) !== -1) trad += 1
    else if (SIM_ONLY.indexOf(ch) !== -1) sim += 1
  }
  return trad > sim
}

/**
 * 英语高频虚词：混排段落判「是不是英文正文里夹了中文」时用。
 * 拉丁字母足够多、且命中两个以上虚词时，主体就是英文句子。
 * 单字母 a / i 故意不算：「(a) Fringing（3 分）」这类中文标题里的编号会被误判。
 */
var ENGLISH_HINTS = [
  'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'and', 'or', 'but', 'if', 'then', 'than',
  'that', 'this', 'these', 'those', 'which', 'who', 'whom', 'whose', 'what', 'when', 'where', 'why', 'how',
  'of', 'to', 'in', 'on', 'at', 'for', 'with', 'without', 'from', 'by', 'as', 'it', 'its', 'we', 'you',
  'they', 'he', 'she', 'not', 'no', 'can', 'will', 'would', 'should', 'could', 'do', 'does', 'did',
  'have', 'has', 'had', 'there', 'their', 'our', 'your', 'my', 'me', 'them', 'us', 'about', 'into',
  'over', 'after', 'before', 'because', 'so', 'also', 'only', 'just', 'more', 'most', 'some', 'any',
  'all', 'one', 'two', 'new', 'use', 'used', 'using', 'while', 'see', 'get', 'got', 'make', 'made',
  'need', 'needs', 'want', 'like', 'well', 'still', 'even', 'up', 'out', 'back', 'now', 'here',
]
// 反查表：判拉丁语系时跳过英文虚词，避免把英文句误判成西语。
var ENGLISH_HINT_SET = Object.create(null)
ENGLISH_HINTS.forEach(function (word) { ENGLISH_HINT_SET[word] = true })

/** 命中的英语虚词条数（按非字母切词、小写比较）。 */
function englishWordHits(text) {
  var tokens = String(text).toLowerCase().split(/[^a-z]+/)
  var hits = 0
  for (var i = 0; i < tokens.length; i += 1) {
    if (tokens[i] !== '' && ENGLISH_HINTS.indexOf(tokens[i]) !== -1) hits += 1
  }
  return hits
}

/**
 * 判断一段文字的主要语言：'zh' / 'en' / null（不翻）。
 *
 * 中日韩书写系统是强信号，但**不能按「出现一个汉字」判整段中文**：
 * 「英文正文里引用一句中文」的段落一旦判成中文，英文部分就永远不会被翻译
 * （2026-11-17 线上：助手回复开头只有一句中文，后面整段英文保持原文）。
 * 混排时改用英语虚词判断主体语言。
 */
function languageOf(text) {
  var plain = textForLanguage(text)
  var kana = countMatches(plain, SCRIPT_RES.kana)
  var hangul = countMatches(plain, SCRIPT_RES.hangul)
  var han = countMatches(plain, CJK_RE)
  var cyrillic = countMatches(plain, SCRIPT_RES.cyrillic)
  var arabic = countMatches(plain, SCRIPT_RES.arabic)
  var hebrew = countMatches(plain, SCRIPT_RES.hebrew)
  var devanagari = countMatches(plain, SCRIPT_RES.devanagari)
  var thai = countMatches(plain, SCRIPT_RES.thai)
  var latin = countMatches(plain, LATIN_RE)
  var total = kana + hangul + han + cyrillic + arabic + hebrew + devanagari + thai + latin
  if (total < 2) return null

  // 日文先判：出现假名就是日文（正文里的汉字可能是当用汉字）
  if (kana >= 1) return 'ja'
  if (hangul >= 1) return 'ko'
  if (han >= 1) {
    // 混排：拉丁字母够多、汉字占比不高、且命中英语虚词，说明主体是英文句子，
    // 夹在里面的中文引用不该让整段跳过翻译（也不能靠全角标点一票判中文）。
    var hanShare = han / (han + latin)
    if (latin >= 8 && hanShare <= 0.35 && englishWordHits(plain) >= 2) return 'en'
    // 其余仍按中文处理：“功率因数 0.88 滞后（lagging）：”、“(a) Fringing（3 分）”
    // 简繁要分开：显示语言是 zh-TW 时，繁体正文不该再送去翻（简体才要）。
    return looksTraditional(plain) ? 'zh-TW' : 'zh'
  }
  if (cyrillic >= 1 && cyrillic / total > 0.3) return 'ru'
  if (arabic >= 1 && arabic / total > 0.3) return 'ar'
  if (hebrew >= 1 && hebrew / total > 0.3) return 'he'
  if (devanagari >= 1 && devanagari / total > 0.3) return 'hi'
  if (thai >= 1 && thai / total > 0.3) return 'th'

  var latinRatio = latin / total
  if (latinRatio > 0.6 && /\s/.test(plain.trim())) {
    // 西/法/德/葡/意/荷/波/土/越/印尼语也用拉丁字母：认出来才不会把
    // 「西语正文」当成英文再翻一遍，也不会让它们永远拿不到显示语言译文。
    var sibling = detectLatinLanguage(plain)
    if (sibling !== null) return sibling
    return 'en'
  }
  return null
}

/**
 * 拉丁字母写成的语言（西/法/德/葡/意/荷/波/土/越/印尼）光靠书写系统分不出来，
 * 这里用一小组高频虚词做判别。**只用来回答一个问题：这段草稿是不是英语？**
 * 判错的代价很小——多花一次翻译请求，模型会原样返回，不会被当成译文采用。
 */
var LATIN_HINTS = {
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




/** 拉丁字母段落的语言猜测：命中至少两个高频虚词才算，否则当作英语。 */
function detectLatinLanguage(text) {
  var plain = textForLanguage(text).toLowerCase()
  if (plain.trim() === '') return null
  // 强信号：西语倒问号/倒叹号、德语 ß、葡语 ã/õ、越南语声调符号
  if (/[¿¡]/.test(plain)) return 'es'
  if (/ß/.test(plain)) return 'de'
  if (/[ãõ]/.test(plain)) return 'pt'
  if (/[ăâđêôơư]/i.test(plain)) return 'vi'
  var tokens = plain.split(/[^a-z\u00c0-\u024f]+/)
  var best = ''
  var bestScore = 0
  var secondScore = 0
  Object.keys(LATIN_HINTS).forEach(function (code) {
    var hints = LATIN_HINTS[code]
    var score = 0
    for (var i = 0; i < tokens.length; i += 1) {
      if (tokens[i] === '' || ENGLISH_HINT_SET[tokens[i]] === true) continue
      if (hints.indexOf(tokens[i]) !== -1) score += 1
    }
    if (score > bestScore) {
      secondScore = bestScore
      bestScore = score
      best = code
    } else if (score > secondScore) {
      secondScore = score
    }
  })
  // 只有一个命中、或两种语言打平，都不足以断定「这是别的语言」：
  // 宁可当成英文，也不能把英文误判成西语。
  if (bestScore < 2 || bestScore <= secondScore) return null
  return best
}

/**
 * 这段文字需不需要先译成英文才能发给模型。
 *
 * 只在「用户输入 / 队列消息」这一侧使用：AI 侧固定英文（对模型最友好），
 * 所以只要用户打的不是英文，就得先换成英文。
 */
function needsEnglish(text, localLanguage) {
  var local = typeof localLanguage === 'string' && localLanguage !== '' ? localLanguage : 'zh'
  if (local === 'en') return false
  var detected = languageOf(text)
  if (detected === null) return false
  if (detected !== 'en') return true
  // 拉丁字母：可能是西语/法语/德语…，用虚词判一下
  var guess = detectLatinLanguage(text)
  return guess !== null && guess !== 'en'
}

/**
 * 这个单元该翻成什么语言。
 *
 * 两种模式（用户 m01815 定的策略：**AI 侧固定英文，显示侧由用户选**）：
 *   - `mode: 'english'` —— 用户输入 / 队列消息 / 插话，发给模型之前要变成英文；
 *   - `mode: 'local'`   —— 助手回复（英文正文）要补一行用户选的本地语言。
 *
 * `localLanguage` 是 BCP-47 风格的短码（zh / zh-TW / ja / de / …）。
 * 返回 null 表示「这段不用翻」，调用方保持原样。
 */
/** 原文语言是否就是显示语言（简繁算两种不同语言）。 */
function sameLanguage(source, local) {
  if (source === null || source === undefined) return false
  if (source === local) return true
  var sourceBase = String(source).split('-')[0]
  var localBase = String(local).split('-')[0]
  if (sourceBase === 'zh' && localBase === 'zh') return false
  return sourceBase === localBase
}

function translationTarget(unit, options) {
  if (unit === null || unit === undefined) return null
  if (['heading', 'paragraph', 'list', 'quote', 'table'].indexOf(unit.kind) === -1) return null
  var opts = options !== null && options !== undefined ? options : {}
  var mode = opts.mode === 'english' ? 'english' : 'local'
  var local = typeof opts.localLanguage === 'string' && opts.localLanguage !== '' ? opts.localLanguage : 'zh'
  var localBase = local.split('-')[0]

  var content = String(unit.content || '').trim()
  if (content.length < 2) return null
  if (/^(https?:\/\/|www\.)\S+$/i.test(content)) return null
  if (/^\s*!?\[[^\]]*\]\([^)]*\)\s*$/.test(content)) return null
  // 纯代码 / 纯符号：没有汉字且代码符号占比高；表格的 | 和 --- 不算代码
  var noCjk = countMatches(content, CJK_RE) === 0
  var symbols = countMatches(content, /[{}[\]();=<>|\\]/g)
  if (unit.kind !== 'table' && noCjk && content.length > 0 && symbols / content.length > 0.22) return null
  if (unit.kind !== 'table' && noCjk && /^\s*(?:const|let|var|function|class|import|export|def|return|if|for|while|async|await)\b/.test(content)) return null
  if (unit.kind !== 'table' && noCjk && /(?:=>|\{\s*$)/.test(content)) return null

  var source = languageOf(content)
  if (source === null) return null

  if (mode === 'english') {
    // 已经是英文（而且不像西语/法语等拉丁兄弟语言）就不用翻
    if (source === 'en' && !needsEnglish(content, local)) return null
    return { source: source, target: 'en' }
  }

  // local：已经是本地语言就跳过；否则补本地语言
  // 注意不能只比基础码：zh 与 zh-TW 都是 "zh"，但那是要转换的两种语言。
  if (sameLanguage(source, local)) return null
  return { source: source, target: local }
}

/**
 * 一条译文是否真的像目标语言。
 *
 * 只做「粗筛」：空串、原样返回、明显不是目标书写系统的都拒掉。
 * 拉丁字母语言之间（es/fr/de/…）无法靠字符集区分，只能放过——
 * 宁可偶尔留一条没翻对的，也不要因为误判把整段译文丢掉。
 */
function translationLooksValid(text, target, source) {
  if (typeof text !== 'string' || text.trim() === '') return false
  if (typeof source === 'string' && source.trim() !== '') {
    var normalizedText = text.replace(/\s+/g, ' ').trim()
    var normalizedSource = source.replace(/\s+/g, ' ').trim()
    if (normalizedText === normalizedSource) return false
  }
  var base = String(target || '').split('-')[0].toLowerCase()
  if (base === 'en') {
    var latinEn = countMatches(text, LATIN_RE)
    if (latinEn < 2) return false
    // 目标英文却回了一大段中日韩：拒掉
    var foreign = countMatches(text, CJK_RE) + countMatches(text, SCRIPT_RES.kana) + countMatches(text, SCRIPT_RES.hangul)
    return latinEn >= foreign * 1.5
  }
  if (base === 'zh') return countMatches(text, CJK_RE) >= 1
  if (base === 'ja') return countMatches(text, SCRIPT_RES.kana) >= 1 || countMatches(text, CJK_RE) >= 1
  if (base === 'ko') return countMatches(text, SCRIPT_RES.hangul) >= 1
  if (base === 'ru') return countMatches(text, SCRIPT_RES.cyrillic) >= 1
  if (base === 'ar') return countMatches(text, SCRIPT_RES.arabic) >= 1
  if (base === 'he') return countMatches(text, SCRIPT_RES.hebrew) >= 1
  if (base === 'hi') return countMatches(text, SCRIPT_RES.devanagari) >= 1
  if (base === 'th') return countMatches(text, SCRIPT_RES.thai) >= 1
  // 拉丁字母目标语言（es/fr/de/pt/it/nl/pl/tr/vi/id…）：字符集分不出来，只看有没有拉丁字母
  return countMatches(text, LATIN_RE) >= 2
}

/** 去掉模型可能带回来的结构前缀 / 说明前缀。 */
function cleanTranslation(raw, kind) {
  var text = String(raw === null || raw === undefined ? '' : raw).trim()
  if (text === '') return ''
  text = text.replace(/^```(?:json|markdown|md|text)?\s*/i, '').replace(/\s*```$/, '').trim()
  text = text.replace(/^(?:译文|翻译|Translation|Translated text)\s*[:：]\s*/i, '').trim()
  if (kind === 'heading') text = text.replace(/^#{1,6}\s+/, '').replace(/\s*\n+\s*/g, ' ')
  if (kind === 'list') text = text.replace(/^\s*([-*+]|\d+[.)])\s+/, '')
  if (kind === 'quote') text = text.replace(/^\s*>\s?/, '')
  return text.trim()
}

/**
 * 把译文**替换**回原文（用于「发送译文」：把输入框里的中文换成英文再发）。
 *
 * 与 decorate 共用 splitUnits，因此代码块、表格、公式、HTML 块原样保留；
 * 标题 / 列表 / 引用的 Markdown 前缀沿用原行的写法，只换文字内容。
 * 未命中译文的单元保持原文，保证结果永远是可发送的完整文本。
 */
function replaceUnits(text, translations, target) {
  var source = typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : ''
  var lines = source.split('\n')
  var units = splitUnits(source)
  var replace = Object.create(null)

  for (var u = 0; u < units.length; u += 1) {
    var unit = units[u]
    if (unit.kind === 'table' || unit.kind === 'fence' || unit.kind === 'html') continue
    var translated = translations !== null && translations !== undefined ? translations[unitKey(unit, target)] : undefined
    if (translated === undefined || translated === null) continue
    var clean = cleanTranslation(translated, unit.kind)
    if (clean === '') continue

    var original = lines[unit.lineStart] || ''
    var indentMatch = original.match(/^(\s*)/)
    var indent = indentMatch === null ? '' : indentMatch[1]

    if (unit.kind === 'heading') {
      var hashes = original.match(/^\s*(#{1,6})\s+/)
      replace[unit.lineStart] = {
        end: unit.lineEnd,
        lines: [indent + (hashes === null ? '#' : hashes[1]) + ' ' + clean.replace(/\s+/g, ' ')],
      }
      continue
    }

    if (unit.kind === 'list') {
      var marker = original.match(/^\s*((?:[-*+]|\d+[.)])\s+)/)
      var bullet = marker === null ? '- ' : marker[1]
      var pad = indent + new Array(bullet.length + 1).join(' ')
      var listLines = clean.split('\n')
      var built = [indent + bullet + listLines[0]]
      for (var li = 1; li < listLines.length; li += 1) built.push(pad + listLines[li])
      replace[unit.lineStart] = { end: unit.lineEnd, lines: built }
      continue
    }

    if (unit.kind === 'quote') {
      var quoteLines = clean.split('\n').map(function (part) {
        return indent + '> ' + part
      })
      replace[unit.lineStart] = { end: unit.lineEnd, lines: quoteLines }
      continue
    }

    var plainLines = clean.split('\n')
    if (indent !== '' && plainLines.length > 0) plainLines[0] = indent + plainLines[0]
    replace[unit.lineStart] = { end: unit.lineEnd, lines: plainLines }
  }

  var out = []
  var index = 0
  while (index < lines.length) {
    var hit = replace[index]
    if (hit === undefined) {
      out.push(lines[index])
      index += 1
      continue
    }
    Array.prototype.push.apply(out, hit.lines)
    index = hit.end + 1
  }
  return out.join('\n')
}

/**
 * 把译文插回原文。translations 是 { [unitKey(unit)]: translatedText }。
 * 未命中的单元保持原样；同一个原文出现多次时共用一条译文。
 */
function decorate(text, translations, target) {
  var source = typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : ''
  var lines = source.split('\n')
  var units = splitUnits(source)
  var append = Object.create(null)

  for (var u = 0; u < units.length; u += 1) {
    var unit = units[u]
    var translated = translations !== null && translations !== undefined ? translations[unitKey(unit, target)] : undefined
    // 兼容：调用方没传 target 时，兜底按「不带目标语言后缀的键」再查一次，
    // 或者按 kind/content 匹配任意后缀的键。显式传了 target 就严格按 target 取，
    // 保证同一段英文的中文 / 日文对照不会串台。
    // （助手正文曾经整段没译文：map 按「单元 + target」建键，调用方忘了传 target。）
    var noTarget = target === undefined || target === null || target === ''
    if (translated === undefined && translations !== null && translations !== undefined) {
      translated = translations[unitKey(unit)]
    }
    if (noTarget && translated === undefined && translations !== null && translations !== undefined) {
      var head = unit.kind + '\u0000'
      var tail = '\u0000' + unit.content
      var mapKeys = Object.keys(translations)
      for (var k = 0; k < mapKeys.length; k += 1) {
        var mapKey = mapKeys[k]
        if (mapKey.indexOf(head) === 0 && mapKey.slice(-tail.length) === tail) {
          translated = translations[mapKey]
          break
        }
      }
    }
    if (translated === undefined || translated === null) continue
    var clean = cleanTranslation(translated, unit.kind)
    if (clean === '') continue

    if (unit.kind === 'heading') {
      lines[unit.lineStart] = lines[unit.lineStart].replace(/\s+#+\s*$/, '') + ' ' + clean
      continue
    }

    if (unit.kind === 'list') {
      var pad = new Array(unit.contentIndent + 1).join(' ')
      var listBlock = clean
        .split('\n')
        .map(function (part) {
          return pad + part
        })
        .join('\n')
      // 末尾留一个换行：下一项之前保持一个空行（与截图的列表间距一致）
      append[unit.lineEnd] = '\n\n' + listBlock + '\n'
      continue
    }

    if (unit.kind === 'quote') {
      var quoteBlock = clean
        .split('\n')
        .map(function (part) {
          return '> ' + part
        })
        .join('\n')
      append[unit.lineEnd] = '\n>\n' + quoteBlock
      continue
    }

    append[unit.lineEnd] = '\n\n' + clean
  }

  var out = ''
  for (var i = 0; i < lines.length; i += 1) {
    out += lines[i]
    if (append[i] !== undefined) out += append[i]
    if (i < lines.length - 1) out += '\n'
  }
  return out
}

module.exports = {
  splitUnits: splitUnits,
  unitKey: unitKey,
  languageOf: languageOf,
  translationTarget: translationTarget,
  translationLooksValid: translationLooksValid,
  needsEnglish: needsEnglish,
  detectLatinLanguage: detectLatinLanguage,
  cleanTranslation: cleanTranslation,
  decorate: decorate,
  replaceUnits: replaceUnits,
  isTableSeparator: isTableSeparator,
  isBlockStart: isBlockStart,
}

      return module.exports
    })()

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

    /**
     * 滚动探测的读取入口。只有带探测构建（SBP_SCROLL_PROBE=1）才存在，
     * 正式构建里 __SBP_SCROLL_SUMMARY__ 是 undefined，这个按钮就返回 null 不渲染。
     * 作用是把探测结果落到剪贴板，省得用户开 DevTools（那里被其它组件报错干扰）。
     */
    function ProbeButton() {
      var pair = React.useState('')
      var setNote = pair[1]
      if (typeof window === 'undefined' || typeof window.__SBP_SCROLL_SUMMARY__ !== 'function') return null
      return h(
        'button',
        {
          type: 'button',
          className: 'sbp-probe',
          title: '复制滚动探测摘要到剪贴板（诊断用，正式版没有这个按钮）',
          onClick: function () {
            var text = ''
            try {
              text = window.__SBP_SCROLL_SUMMARY__()
            } catch (error) {
              text = 'summary failed: ' + String(error)
            }
            var done = function (ok) {
              setNote(ok ? '已复制' : '复制失败，请手动展开')
            }
            try {
              if (navigator.clipboard !== undefined && navigator.clipboard !== null) {
                navigator.clipboard.writeText(text).then(
                  function () {
                    done(true)
                  },
                  function () {
                    done(false)
                  },
                )
              } else {
                done(false)
              }
            } catch (error) {
              done(false)
            }
          },
        },
        '滚动诊断',
      )
    }

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
        'span',
        { className: 'sbp-toggle-group' },
        h(
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
          h('span', { className: 'sbp-toggle-label' }, '影译'),
          h('span', { className: 'sbp-toggle-build' }, 'v1.0.9'),
          enabled === true ? h('span', { className: 'sbp-toggle-state' }, 'ON') : null,
        ),
        h(ProbeButton, null),
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
      '.sbp-toggle-group{display:inline-flex;align-items:center;gap:6px}',
      '.sbp-probe{display:inline-flex;align-items:center;height:24px;padding:0 8px;border:1px dashed var(--dsw-alias-state-warning-primary,#d99a1f);border-radius:999px;background:transparent;color:var(--dsw-alias-state-warning-primary,#d99a1f);font:11px/1 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer;white-space:nowrap}',
      '.sbp-probe:hover{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d99a1f) 12%,transparent)}',
      '.sbp-toggle{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);font:12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer;white-space:nowrap;transition:background-color .15s ease,border-color .15s ease,color .15s ease}',

      '.sbp-en-status{display:inline-flex;align-items:center;margin:4px 2px 0;padding:0 2px;font:11px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:.08em;color:var(--dsw-alias-label-secondary,#5f6672);opacity:.72;cursor:default}',
      '.sbp-en-status[data-phase="ready"]{color:var(--dsw-alias-brand-primary,#4c6ef5);font-weight:600;opacity:1}',
      '.sbp-en-status[data-phase="pending"]{opacity:.9}',
      '.sbp-send-toggle{display:inline-flex;align-items:center;gap:5px;font:12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--dsw-alias-label-secondary,#5f6672);cursor:pointer;user-select:none;white-space:nowrap}',
      '.sbp-send-toggle input{width:12px;height:12px;margin:0;accent-color:var(--dsw-alias-brand-primary,#4d6bfe);cursor:pointer}',
      '.sbp-send-toggle-label{font-size:12px;font-weight:500}',
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
    /**
     * 首屏兜底提交「暂时不可用」的截止时间戳。
     *
     * 之前是一个布尔量，一次失败就永久生效：首屏再点发送永远走 no-actions
     * 放行分支 —— 而放行后应用又因为草稿是中文而拒绝提交，于是框里永远是中文、
     * 按钮怎么点都没反应。改成带过期的：放行一次原文让用户先发出去，
     * 但下一次点击仍有机会重新接管。
     */
    var heroFallbackBrokenUntil = 0
    /** 首屏兜底「暂时不接管」的冷却时间：只跳过这一下，不永久退化。 */
    var HERO_COOLDOWN_MS = 8000
    var lastBlock = ''
    var lockAt = 0
    var sendSeq = 0
    var intercepting = false
    /**
     * 我们自己触发的合成点击（domSubmit / nativeSendNow 里对发送按钮的 click()）。
     *
     * 拦截器挂在 document 捕获阶段，`button.click()` 同样会被自己的 onClick 看到。
     * 那一刻 intercepting 还是 true 且草稿可能还没同步成英文，于是 inFlight 判真、
     * 事件被 swallow —— 应用永远收不到这次发送，随后锁释放、草稿还原成中文，
     * 用户看到的就是「点了翻译、再点没反应」。
     */
    var replayingSend = false

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

    /** 当前正在编辑的那个富文本编辑器（主 composer 或新会话的首屏输入框）。 */
    function liveEditorElement() {
      if (typeof document === 'undefined') return null
      var active = document.activeElement
      if (active !== null && active !== undefined && typeof active.closest === 'function') {
        var own = active.closest('[contenteditable="true"]')
        if (own !== null && own !== undefined) return own
      }
      var lexical = document.querySelector('[data-lexical-editor="true"]')
      return lexical === null || lexical === undefined ? null : lexical
    }

    /** 在编辑器里找到「发送」按钮；新会话的首屏输入框没有 inputActions 时靠它兜底。 */
    function composerSendButton() {
      if (typeof document === 'undefined') return null
      var element = liveEditorElement()
      var card = element !== null && typeof element.closest === 'function' ? element.closest('[data-composer-card]') : null
      var list = card !== null && card !== undefined ? card.querySelectorAll('button') : document.querySelectorAll('button')
      if (list === null || list === undefined) return null
      for (var i = 0; i < list.length; i += 1) {
        if (isSendButton(list[i])) return list[i]
      }
      return null
    }

    /** 把当前草稿原样发出去：翻译失败/超时后兑现「失败也发原文」，不让用户再按一次。 */
    function nativeSendNow() {
      var actions = composerBridge.actions
      if (actions !== null && actions !== undefined && typeof actions.submit === 'function') {
        try {
          actions.submit()
          return true
        } catch (error) {
          return false
        }
      }
      var button = composerSendButton()
      if (button === null || button === undefined) return false
      replayingSend = true
      try {
        button.click()
        return true
      } catch (error) {
        return false
      } finally {
        replayingSend = false
      }
    }

    /** 只要「写得进编辑器 + 点得到发送按钮」，即使没有 inputActions 也能把英文发出去。 */
    function canNativeCommit() {
      if (liveEditorElement() === null) return false
      return composerSendButton() !== null
    }

    /**
     * 把文本写进编辑器，并**确认真的写进去了**。
     *
     * 之前只要 `execCommand('insertText')` 返回 true 就当真了。在 Lexical 里那不够：
     * execCommand 改的是 DOM 文本，而编辑器按自己的 state 重渲染，下一帧就把
     * 中文又paint 回去。于是发送时点的是「中文草稿」，应用拒绝提交，框里永远留着
     * 中文 —— 用户看到的就是「点一次翻译、再点没反应」。
     *
     * 所以这里写完必须回读：读到的不是目标文本就算失败，交给调用方决定兜底。
     */
    function writeEditorText(element, text) {
      try {
        element.focus()
        var wrote = false
        if (typeof document.execCommand === 'function') {
          var range = document.createRange()
          range.selectNodeContents(element)
          var selection = window.getSelection === undefined ? null : window.getSelection()
          if (selection !== null && selection !== undefined) {
            selection.removeAllRanges()
            selection.addRange(range)
          }
          wrote = document.execCommand('insertText', false, text) === true
        }
        if (wrote !== true) {
          element.textContent = text
          element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
        }
        // 关键：不管走哪条路，都回读一次确认 DOM 里真的是这段文本。
        var now = String(element.innerText === undefined ? element.textContent : element.innerText)
        return sameDraft(now, text) === true
      } catch (error) {
        return false
      }
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
            // 译文不可用（模型原样退回、或只回了半句）：按失败处理，绝不能静默。
            // 必须留下非空 error：gateSend 的「已经翻过这段、并且失败了：不能再挡」
            // 分支只认 error !== ''，error 为空就会落回「idle + 含中文」再拦一次 ——
            // 用户每按一次 Enter 都被吞掉、再拿回同一段原文，消息永远发不出去。
            shadow.english = ''
            shadow.phase = 'idle'
            shadow.error = '无法生成英文改写，将按原文发送'
            clearPendingSubmit()
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
          // 这次翻译失败时用户已经按过发送：把原文原样发出去，
          // 兑现「翻译失败也发原文，不把用户卡住」，而不是让他再按一次。
          var wasPending = pendingSubmit.source !== '' && sameDraft(pendingSubmit.source, source)
          // 失败保留上一版译文，只标记错误；清空会让预览整块消失
          shadow.error = String(error && error.message ? error.message : error)
          clearPendingSubmit()
          // 失败也回到 idle：宁可发原文，也不能把用户卡住
          shadow.phase = 'idle'
          shadow.error = String(error && error.message ? error.message : error)
          shadowEmit()
          if (wasPending === true) nativeSendNow()
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
      // 主输入框拿不到 actions、也没有可点的发送按钮时不能接管：
      // 否则吞掉事件又发不出去（消息静默丢失）。
      // 新会话首屏输入框就是这种情况的对立面：actions 还没挂上，但编辑器 + 发送按钮都在，
      // 于是用 DOM 兜底把英文写进去再点发送（见 commitShadow）。
      if (kind === 'composer' && (composerBridge.actions === null || composerBridge.actions === undefined) && (canNativeCommit() !== true || Date.now() < heroFallbackBrokenUntil)) {
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

      // DOM 兜底：把英文写进编辑器，等按钮真正可用再点它自己的发送。
      // 首屏（新会话）与「actions.submit() 是空操作」两种情况都靠它。
      function domSubmit() {
        var editor = liveEditorElement()
        var button = composerSendButton()
        if (editor === null || button === null) return false
        var original = readLiveDraft()
        if (writeEditorText(editor, english) !== true) return false
        var attempts = 0

        /** 兜底整体失败：撤掉自己留下的英文、放行原文，并且把「暂时不接管」也撤掉。 */
        function giveUp() {
          // 只把自己写进去的英文撤回去，别把用户后来打的新内容也冲掉。
          var now = readLiveDraft()
          if ((now === '' || sameDraft(now, english)) && original !== '') writeEditorText(editor, original)
          // 放行一次原文（用户至少能发出去），并且**立刻取消**「不接管」状态：
          // 下一次点击重新走完整流程，而不是永久退化。
          heroFallbackBrokenUntil = Date.now() + 1
          release()
        }

        var poll = function () {
          attempts += 1
          var target = composerSendButton()
          var disabled = target === null || target === undefined || target.disabled === true || target.getAttribute('aria-disabled') === 'true'
          if (disabled !== true) {
            var clicked = false
            replayingSend = true
            try {
              target.click()
              clicked = true
            } catch (error) {
              clicked = false
            } finally {
              replayingSend = false
            }
            if (clicked !== true) {
              giveUp()
              return
            }
            submittedAt = Date.now()
            submittedDraft = english
            release()
            // 点完要**回查**：编辑器里还是英文、草稿也没被清空，说明应用根本没收到这次发送。
            if (later === null) return
            later(function () {
              var still = readLiveDraft()
              if (still === '') return
              if (sameDraft(still, english) !== true) return
              giveUp()
            }, 600)
            return
          }
          if (attempts >= 10) {
            // 十次都没等到按钮可用：把原文放回去，让下一次点击直接发给应用本身。
            giveUp()
            return
          }
          if (later !== null) later(poll, 120)
          else giveUp()
        }
        if (later === null) poll()
        else later(poll, 120)
        return true
      }

      if (actions === null || actions === undefined) {
        // 首屏输入框（新会话）没有 inputActions，只能走 DOM。
        if (domSubmit() !== true) {
          heroFallbackBrokenUntil = Date.now() + HERO_COOLDOWN_MS
          release()
        }
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
        var fired = false
        try {
          actions.submit()
          fired = true
        } catch (error) {}
        submittedAt = Date.now()
        submittedDraft = english
        // 先放锁：连按的第二下要能正常被「重复提交」挡住，而不是撞在锁上。
        release()
        if (fired !== true || later === null) return
        // 首屏的 submit 可能是空操作：草稿还在就用 DOM 再试一次，绝不吞消息。
        later(function () {
          if (submittedDraft !== english) return
          var still = readLiveDraft()
          if (still === '' || sameDraft(still, english) !== true) return
          if (domSubmit() !== true) heroFallbackBrokenUntil = Date.now() + HERO_COOLDOWN_MS
        }, 520)
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
        // 我们自己合成出来的那次点击（domSubmit / nativeSendNow）必须原样放行。
        // 否则捕获阶段的拦截会把插件的兜底提交也吞掉：点了翻译、再点没反应。
        if (replayingSend === true) return
        // 非真人触发的点击（脚本、测试、其它插件）不接管：接管了也没法回放，
        // 只会把发送吞掉。isTrusted 缺失时按真人处理，保持旧行为。
        if (event !== null && event !== undefined && event.isTrusted === false) return
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

    function composerDraftOf(props) {
      var useInput = props !== null && props !== undefined && typeof props.useInput === 'function' ? props.useInput : null
      if (useInput === null) return ''
      return useInput(function (state) {
        return state !== null && state !== undefined && typeof state.draft === 'string' ? state.draft : ''
      })
    }

    /**
     * 「发送译文」勾选框：住在输入框自己的工具行里（`conversation.input.left`），
     * 不再挂在输入框下方的状态条上——那里空间有限，只留一个短状态。
     */
    function SendToggle(props) {
      useStore()
      useShadow()
      var draft = composerDraftOf(props)
      var pair = React.useState(readSendTranslation())
      // 工具行在首屏就挂上了、并且带 inputActions：接住它，
      // 首屏发送才能改到应用的草稿 state（而不是只改 DOM）。
      React.useEffect(function () {
        var actions = captureInputActions(props)
        if (actions === null) return undefined
        composerBridge.actions = actions
        return function () {
          if (composerBridge.actions === actions) composerBridge.actions = null
        }
      }, [props])
      var checked = pair[0]
      var setChecked = pair[1]
      var text = typeof draft === 'string' ? draft : ''
      var normalized = String(text === null || text === undefined ? '' : text)

      if (store.enabled !== true) return null

      return h(
        'label',
        {
          className: 'sbp-send-toggle',
          title: checked ? '先翻成英文再发送；关掉则发送你写的原文' : '发送你写的原文（英文影子只作预览）',
        },
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
        h('span', { className: 'sbp-send-toggle-label' }, '发送译文'),
      )
    }

    /**
     * 从插槽 props 里接住输入框的 actions（`props.inputActions`）。
     *
     * **这是首屏（hero）能不能发英文的关键。**
     * 之前只有 `conversation.composer.dock` 的 LiveTranslationPanel 会写
     * composerBridge.actions，而那个插槽是会话建立后才挂上的——首屏没有它，
     * actions 永远是 null，于是 commitShadow 走 DOM 兜底。
     *
     * DOM 兜底根本行不通：`execCommand('insertText')` 只改 DOM 文本，
     * 而应用提交时读的是**它自己的 React state**（仍是中文）。结果就是
     * 「点一下翻译、再点一下把中文发出去了」。
     *
     * `conversation.input.left` 的输入框工具行在首屏就有，而且带 inputActions
     * （voice-mode 的麦克风按钮就是这么拿到它的），所以由它来喂 bridge。
     */
    function captureInputActions(props) {
      var actions = props !== null && props !== undefined ? props.inputActions : undefined
      if (actions === undefined || actions === null) return null
      return actions
    }

    function LiveTranslationPanel(props) {
      var draft = composerDraftOf(props)
      useStore()
      useShadow()
      React.useEffect(function () {
        var actions = captureInputActions(props)
        if (actions === null) return undefined
        composerBridge.actions = actions
        return function () {
          if (composerBridge.actions === actions) composerBridge.actions = null
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
      }, [normalized])

      // 影子画在输入框里（见 renderGhost），面板只留勾选框 + 一句状态
      React.useEffect(function () {
        renderGhost(normalized)
      }, [normalized, shadow.phase, shadow.english, shadow.seq])

      if (store.enabled !== true) return null

      var showTranslation = normalized.trim() !== '' && needsEnglish(normalized, localLanguage)
      var pending = shadow.phase === 'pending'
      var ready = shadow.phase === 'ready'
      // 菜单栏只放一个短标记：「发送译文」勾选框已经搬进输入框工具行。
      var mark = pending ? '···' : ready && showTranslation === true ? 'EN' : shadow.error !== '' && showTranslation === true ? '!' : ''
      if (mark === '') return null
      var hint = pending
        ? '正在翻成英文，完成后自动发送'
        : ready && showTranslation === true
          ? '英文译文已就绪，发送的就是它'
          : '翻译失败，将按原文发送'
      return h('div', { className: 'sbp-en-status', id: 'sbp-en-status', 'data-phase': shadow.phase, title: hint }, mark)
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

    function registerSendToggle(ctx) {
      try {
        ctx.slots.inject('conversation.input.left', function () {
          return ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'shadow-bilingual-send',
              order: 50,
              label: function () {
                return '发送译文'
              },
            },
            SendToggle,
          )
        })
      } catch (error) {
        try {
          console.warn('[shadow-bilingual] 发送译文勾选框注册失败：', error)
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

  function describeTarget(target) {
    if (target === null || target === undefined) return ''
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
          entries: log.length,
          intents: intents,
          intentsByType: byType,
          tailFlips: tailFlips,
          maxGapAtIntent: maxGapAfterIntent,
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


    function apply(ctx) {
      installStyles(ctx)
      registerAssistant(ctx)
      registerLivePanel(ctx)
      registerSendToggle(ctx)
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
