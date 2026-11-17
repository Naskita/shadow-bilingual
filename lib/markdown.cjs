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

    // 块级公式 $$ ... $$
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
  Object.keys(LATIN_HINTS).forEach(function (code) {
    var hints = LATIN_HINTS[code]
    var score = 0
    for (var i = 0; i < tokens.length; i += 1) {
      if (tokens[i] !== '' && hints.indexOf(tokens[i]) !== -1) score += 1
    }
    if (score > bestScore) {
      bestScore = score
      best = code
    }
  })
  if (bestScore < 2) return null
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
