import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const md = require('../lib/markdown.cjs')

function translationsFor(source, map, target) {
  const units = md.splitUnits(source)
  const out = {}
  for (const unit of units) {
    if (Object.prototype.hasOwnProperty.call(map, unit.content)) {
      out[md.unitKey(unit, target)] = map[unit.content]
    }
  }
  return out
}

/** 显示侧默认语言是中文；本地语种相关的断言自己传 options。 */
const LOCAL_ZH = { mode: 'local', localLanguage: 'zh' }
const ENGLISH = { mode: 'english', localLanguage: 'zh' }

test('heading translation is appended on the same line', () => {
  const source = '### 3. 重要物理性质'
  const out = md.decorate(source, translationsFor(source, { '3. 重要物理性质': '3. Important physical properties' }))
  assert.equal(out, '### 3. 重要物理性质 3. Important physical properties')
})

test('paragraph translation is inserted as the next paragraph', () => {
  const source = '磁通量是标量。\n\n它有正负之分。'
  const out = md.decorate(
    source,
    translationsFor(source, {
      '磁通量是标量。': 'Magnetic flux is a scalar quantity.',
      '它有正负之分。': 'It can be positive or negative.',
    }),
  )
  assert.equal(out, '磁通量是标量。\n\nMagnetic flux is a scalar quantity.\n\n它有正负之分。\n\nIt can be positive or negative.')
})

test('list item translation stays inside the same bullet and keeps nesting', () => {
  const source = '- **标量性**：磁通量是标量。\n- **高斯磁定律**：净磁通量恒为零。'
  const out = md.decorate(
    source,
    translationsFor(source, {
      '**标量性**：磁通量是标量。': '**Scalar nature**: Magnetic flux is a scalar quantity.',
      '**高斯磁定律**：净磁通量恒为零。': "**Gauss's Law of Magnetism**: The net flux is always zero.",
    }),
  )
  assert.equal(
    out,
    "- **标量性**：磁通量是标量。\n\n  **Scalar nature**: Magnetic flux is a scalar quantity.\n\n- **高斯磁定律**：净磁通量恒为零。\n\n  **Gauss's Law of Magnetism**: The net flux is always zero.\n",
  )
})

test('nested list item is translated separately and does not duplicate the parent', () => {
  const source = '- 父项\n  - 子项'
  const units = md.splitUnits(source)
  assert.deepEqual(units.map((u) => u.kind + ':' + u.content), ['list:父项', 'list:子项'])
  const out = md.decorate(source, translationsFor(source, { 父项: 'Parent', 子项: 'Child' }))
  assert.match(out, /- 父项\n\n  Parent\n/)
  assert.match(out, /  - 子项\n\n    Child/)
})

test('code fences and block math are skipped, tables become translatable units', () => {
  const source = [
    '```js',
    'const a = 1',
    '```',
    '',
    '| 名称 | 值 |',
    '| --- | --- |',
    '| a | 1 |',
    '',
    '$$',
    'E = mc^2',
    '$$',
    '',
    '正文。',
  ].join('\n')
  const units = md.splitUnits(source)
  assert.deepEqual(units.map((u) => u.kind), ['table', 'paragraph'])
  const table = units[0].content
  assert.match(table, /\| 名称 \| 值 \|/)
  const translatedTable = '| Name | Value |\n| --- | --- |\n| a | 1 |'
  const out = md.decorate(source, translationsFor(source, { [table]: translatedTable, '正文。': 'Body.' }))
  assert.match(out, /\| 名称 \| 值 \|\n\| --- \| --- \|\n\| a \| 1 \|\n\n\| Name \| Value \|/)
  assert.match(out, /```js\nconst a = 1\n```/)
})

test('language detection and target selection', () => {
  assert.equal(md.languageOf('磁通量是标量。'), 'zh')
  assert.equal(md.languageOf('Magnetic flux is a scalar quantity.'), 'en')
  assert.equal(md.languageOf('功率因数 0.88 滞后（lagging）：'), 'zh')
  assert.equal(md.languageOf('由 (ii)：'), 'zh')
  assert.equal(md.languageOf('(a) Fringing（3 分）'), 'zh')
  // 显示侧（local）：英文正文补本地语言
  assert.deepEqual(md.translationTarget({ kind: 'paragraph', content: 'Magnetic flux is a scalar quantity.' }, LOCAL_ZH), { source: 'en', target: 'zh' })
  assert.equal(md.translationTarget({ kind: 'paragraph', content: '磁通量是标量。' }, LOCAL_ZH), null)
  assert.deepEqual(
    md.translationTarget({ kind: 'paragraph', content: 'Magnetic flux is a scalar quantity.' }, { mode: 'local', localLanguage: 'ja' }),
    { source: 'en', target: 'ja' },
  )
  assert.deepEqual(
    md.translationTarget({ kind: 'table', content: '| Name | Value |\n| --- | --- |\n| a | 1 |' }, LOCAL_ZH),
    { source: 'en', target: 'zh' },
  )
  // AI 侧（english）：本地语言在发送前换成英文
  assert.deepEqual(md.translationTarget({ kind: 'paragraph', content: '磁通量是标量。' }, ENGLISH), { source: 'zh', target: 'en' })
  assert.deepEqual(md.translationTarget({ kind: 'paragraph', content: '功率因数 0.88 滞后（lagging）：' }, ENGLISH), { source: 'zh', target: 'en' })
  assert.equal(md.translationTarget({ kind: 'paragraph', content: 'Magnetic flux is a scalar quantity.' }, ENGLISH), null)
  // 两种模式共有的跳过规则
  for (const options of [LOCAL_ZH, ENGLISH]) {
    assert.equal(md.translationTarget({ kind: 'paragraph', content: '12345' }, options), null)
    assert.equal(md.translationTarget({ kind: 'paragraph', content: 'const x = { a: 1 };' }, options), null)
    assert.equal(md.translationTarget({ kind: 'paragraph', content: 'https://example.com/a' }, options), null)
  }
})

test('cleanTranslation removes headings, bullets and labels', () => {
  assert.equal(md.cleanTranslation('### 3. Important properties', 'heading'), '3. Important properties')
  assert.equal(md.cleanTranslation('- **Scalar nature**: text', 'list'), '**Scalar nature**: text')
  assert.equal(md.cleanTranslation('译文：Magnetic flux.', 'paragraph'), 'Magnetic flux.')
  assert.equal(md.cleanTranslation('```md\nHello\n```', 'paragraph'), 'Hello')
})

test('same source text shares one translation across units', () => {
  const source = '- 重复\n- 重复'
  const out = md.decorate(source, translationsFor(source, { 重复: 'Repeated' }))
  assert.equal((out.match(/Repeated/g) || []).length, 2)
})

test('multi-language display targets and script validation', () => {
  const english = { kind: 'paragraph', content: 'Magnetic flux is a scalar quantity.' }

  // 同一段英文，换本地语种就换目标语言
  for (const code of ['zh', 'ja', 'ko', 'de', 'es', 'ru', 'ar']) {
    assert.equal(md.translationTarget(english, { mode: 'local', localLanguage: code }).target, code)
  }

  // 已经是本地语言就跳过（显示侧不需要「中译中」）
  assert.equal(md.translationTarget({ kind: 'paragraph', content: '磁通量是标量。' }, { mode: 'local', localLanguage: 'zh' }), null)
  assert.equal(md.translationTarget({ kind: 'paragraph', content: '磁束はスカラーです。' }, { mode: 'local', localLanguage: 'ja' }), null)

  // 书写系统识别
  assert.equal(md.languageOf('磁束はスカラー量です。'), 'ja')
  assert.equal(md.languageOf('자기 선속은 스칼라입니다.'), 'ko')
  assert.equal(md.languageOf('Магнитный поток является скаляром.'), 'ru')
  assert.equal(md.languageOf('التدفق المغناطيسي كمية قياسية.'), 'ar')

  // needsEnglish：AI 侧只认英文
  assert.equal(md.needsEnglish('磁通量是标量。', 'zh'), true)
  assert.equal(md.needsEnglish('磁束はスカラーです。', 'ja'), true)
  assert.equal(md.needsEnglish('El flujo magnético es una cantidad escalar.', 'zh'), true)
  assert.equal(md.needsEnglish('Magnetic flux is a scalar quantity.', 'zh'), false)
  assert.equal(md.needsEnglish('12345', 'zh'), false)

  // 拉丁兄弟语言靠高频虚词区分；英语应当判不出来（= 不用翻译）
  assert.equal(md.detectLatinLanguage('El flujo magnético es una cantidad escalar.'), 'es')
  assert.equal(md.detectLatinLanguage('Der magnetische Fluss ist eine skalare Größe.'), 'de')
  assert.equal(md.detectLatinLanguage('Magnetic flux is a scalar quantity.'), null)

  // 译文粗筛：目标语言的书写系统必须对
  assert.equal(md.translationLooksValid('磁束はスカラー量です。', 'ja', 'src'), true)
  assert.equal(md.translationLooksValid('磁束はスカラー量です。', 'en', 'src'), false)
  assert.equal(md.translationLooksValid('자기 선속은 스칼라입니다.', 'ko', 'src'), true)
  assert.equal(md.translationLooksValid('Магнитный поток.', 'ru', 'src'), true)
  assert.equal(md.translationLooksValid('same text', 'en', 'same text'), false)
  assert.equal(md.translationLooksValid('', 'zh', 'src'), false)
})

test('cache keys separate the same source by target language', () => {
  const unit = { kind: 'paragraph', content: 'Magnetic flux is a scalar quantity.' }
  assert.notEqual(md.unitKey(unit, 'zh'), md.unitKey(unit, 'ja'))
  assert.equal(md.unitKey(unit, 'zh'), md.unitKey(unit, 'zh'))
  // 不传 target 时保持旧行为，老缓存不会因为升级全部失效
  assert.equal(md.unitKey(unit), md.unitKey(unit, ''))

  // decorate 按 target 取译文：同一段英文可以同时有中文与日文两条对照
  const source = 'Magnetic flux is a scalar quantity.'
  const zh = { [md.unitKey(unit, 'zh')]: '磁通量是标量。' }
  const ja = { [md.unitKey(unit, 'ja')]: '磁束はスカラー量です。' }
  assert.match(md.decorate(source, zh, 'zh'), /磁通量是标量。/)
  assert.match(md.decorate(source, ja, 'ja'), /磁束はスカラー量です。/)
  assert.doesNotMatch(md.decorate(source, ja, 'zh'), /磁束はスカラー量です。/)

  // 输入侧替换：同段中文换成英文
  const zhUnit = { kind: 'paragraph', content: '磁通量是标量。' }
  const englishMap = { [md.unitKey(zhUnit, 'en')]: 'Magnetic flux is a scalar quantity.' }
  assert.equal(md.replaceUnits('磁通量是标量。', englishMap, 'en'), 'Magnetic flux is a scalar quantity.')
})
