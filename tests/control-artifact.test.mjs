/**
 * 控制标记残渣过滤的回归测试。
 *
 * 背景：ollama-cloud 上的 deepseek-v4.1-flash 偶发「一次回复里，tool-call 之外
 * 再吐一个只有收尾标签的文本块」，实测原文就是 "\n</ invoke>\n</ calls>"。
 * 它在真实会话里被原样渲染成可见文字，用户反复截图投诉。
 *
 * 这不是插件造成的（插件源码/构建产物里都搜不到这些字串），但插件是唯一
 * 能看到这个块并把它藏掉的一层，所以由插件做**纯显示层**过滤。
 *
 * 判据必须窄：整块去掉控制标记与空白后为空才算残渣。只要还剩一个正常字符
 * 就原样保留 —— 否则「我们讨论这串标签」这类正文会被吞掉。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const TEMPLATE = path.join(import.meta.dirname, '..', 'lib', 'client.template.js')

/** 从模板里抠出 isControlArtifact 单独求值，避免为了测一个纯函数去加载整个插件。 */
function loadDetector() {
  const src = readFileSync(TEMPLATE, 'utf8')
  const start = src.indexOf('    var CONTROL_ARTIFACT_TAGS')
  const end = src.indexOf('    function usableEnglish')
  assert.ok(start > 0 && end > start, '在 client.template.js 里找不到 isControlArtifact 定义')
  // 保留 `var CONTROL_ARTIFACT_TAGS` 原样（eval 在函数作用域里，改成 globalThis
  // 反而会让函数体里的裸标识符解析不到），只把函数挂到全局供测试取用。
  const snippet = src
    .slice(start, end)
    .replace('function isControlArtifact', 'globalThis.__isControlArtifact = function')
  // eslint-disable-next-line no-eval
  ;(0, eval)(snippet)
  return globalThis.__isControlArtifact
}

const isControlArtifact = loadDetector()

test('整块只有收尾标签时判为残渣', () => {
  // 真实会话里抓到的原文（session 701a694d，assistant/message）
  assert.equal(isControlArtifact('\n</ invoke>\n</ calls>'), true)
  // 空格/换行/管道符变体
  assert.equal(isControlArtifact('</invoke></calls>'), true)
  assert.equal(isControlArtifact('  </ invoke>  '), true)
  assert.equal(isControlArtifact('</ | DSML | invoke>\n</ | DSML | calls>'), true)
  assert.equal(isControlArtifact('</tool_call>'), true)
})

test('有任何正常内容就原样保留', () => {
  assert.equal(isControlArtifact(''), false)
  assert.equal(isControlArtifact('   '), false)
  assert.equal(isControlArtifact('Hello'), false)
  assert.equal(isControlArtifact('Let me check that.'), false)
  // 讨论这串标签的正文不能被吞 —— 这是这个判据最重要的边界
  assert.equal(isControlArtifact('我上一条回复里泄出了 `</ | DSML | invoke>` 这类片段'), false)
  assert.equal(isControlArtifact('The reply contained </ invoke> verbatim.'), false)
  // 正常的 HTML/Markdown 标记也不该被当成残渣
  assert.equal(isControlArtifact('<div>hi</div>'), false)
  assert.equal(isControlArtifact('```js\nconst a = 1\n```'), false)
})

test('不是字符串时不抛错', () => {
  assert.equal(isControlArtifact(undefined), false)
  assert.equal(isControlArtifact(null), false)
  assert.equal(isControlArtifact(42), false)
})

test('渲染器确实调用了过滤器（不是死代码）', () => {
  // 前两个用例只验纯函数。如果渲染路径没接上，它们照样全绿 ——
  // 这正是本项目反复吃过的「假绿」。所以这里直接盯调用点。
  const src = readFileSync(TEMPLATE, 'utf8')
  const callSite = /if \(isControlArtifact\(text\)\) continue/
  assert.match(src, callSite, 'text 分支里没有调用 isControlArtifact —— 过滤器没接进渲染路径')

  // 调用点必须在「拼装 text 块」之前，否则丢了也没意义
  const textBranch = src.indexOf("if (block.kind === 'text') {")
  const callIndex = src.search(callSite)
  assert.ok(textBranch > 0, '找不到 text 块分支')
  assert.ok(
    callIndex > textBranch,
    'isControlArtifact 的调用不在 text 块分支内部',
  )
})
