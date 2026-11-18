/**
 * 修「视口自己往回跳」——对已安装的 DeepSeek Harness 的 app.asar 打补丁。
 *
 * 根因见 docs/PLAN.md D24。一句话：
 *   流式回复时内容不断变高，scrollTop 几乎不动，但 ChatReading.flushSample()
 *   每 500ms 用 follow.sample(metrics, movedByReader) 把「是否跟随到底」重算成
 *   nearBottom()（离底 <=25px），于是只要用户在流式中途离底稍远，跟随就被关掉，
 *   视图停在原地而内容继续长 —— 表现为自己往回跳。探测里 tailFlips 那条
 *   kind:"tick" 的 true→false 就是它。
 *
 * 改两处（都在 @deepseek-ai/dsh-client-ui-chat/lib/client.js）：
 *   1. sample()：区分「用户真的滚了」和「内容变高造成的假移动」。
 *      内容高度变大、而 scrollTop 变化不足 1px ⇒ 不算用户移动，保留原 following。
 *   2. nearBottom 的固定 25px 阈值改为随视口高度缩放：clamp(innerHeight*6%, 25, 120)。
 *
 * 用法：
 *   node patch/follow-patch.mjs --dry-run   只检查能不能匹配（不改任何文件）
 *   node patch/follow-patch.mjs --extract   把目标文件导出到 patch/_extracted/ 便于人工核对
 *   node patch/follow-patch.mjs            真打补丁（自动备份 app.asar.orig-<ts>）
 *
 * 幂等：已经打过就跳过。应用升级后先 --dry-run，若报「目标串没找到」，
 * 按 docs/dsh-follow-patch.md 的「升级后重新定位」章节更新 OLD_* 常量。
 */
import { readAsar, readEntry, rewriteWithFile, listFiles } from './asar-tool.mjs'
import { existsSync, copyFileSync, renameSync, mkdirSync, writeFileSync } from 'node:fs'

const APP = '/Applications/DeepSeek Harness.app'
const ASAR = `${APP}/Contents/Resources/app.asar`
const TARGET = '/dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js'

const OLD_SAMPLE =
  'sample(metrics,movedByReader=this.sampledTop===void 0||Math.abs(metrics.top-this.sampledTop)>.5){this.sampledTop=metrics.top;if(!this.animating&&movedByReader)this.following=this.nearBottom(metrics);return this.active}'

const NEW_SAMPLE =
  'sample(metrics,movedByReader=this.sampledTop===void 0||Math.abs(metrics.top-this.sampledTop)>.5){const prevHeight=this.sampledHeight;const prevTop=this.sampledTop;this.sampledTop=metrics.top;if(metrics.height!==void 0)this.sampledHeight=metrics.height;const contentGrew=prevHeight!==void 0&&metrics.height!==void 0&&metrics.height>prevHeight;const topMoved=prevTop===void 0||Math.abs(metrics.top-prevTop)>=1;const userMoved=movedByReader&&(!contentGrew||topMoved);if(!this.animating&&userMoved)this.following=this.nearBottom(metrics);return this.active}'

const OLD_THRESHOLD = 'const follow=useScrollFollow(state.followingTail,25)'
const NEW_THRESHOLD =
  'const follow=useScrollFollow(state.followingTail,Math.max(25,Math.min(120,Math.round((typeof window!=="undefined"&&window.innerHeight?window.innerHeight:800)*.06))))'

export const MARKERS = {
  sample: 'const contentGrew=',
  threshold: 'Math.min(120,Math.round(',
}

export function inspect(asarPath = ASAR) {
  const asar = readAsar(asarPath)
  const entry = readEntry(asar, TARGET)
  if (entry === null) {
    return { ok: false, reason: `目标文件不在 asar 里：${TARGET}（应用结构可能变了）` }
  }
  const source = entry.toString('utf8')
  const patched = source.includes(MARKERS.sample) && source.includes(MARKERS.threshold)
  return {
    ok: true,
    patched,
    hasSampleAnchor: source.includes(OLD_SAMPLE),
    hasThresholdAnchor: source.includes(OLD_THRESHOLD),
    bytes: source.length,
    source,
    asar,
  }
}

function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const extract = args.includes('--extract')

  if (!existsSync(ASAR)) {
    console.error(`找不到 app.asar：${ASAR}`)
    process.exit(2)
  }

  const state = inspect()
  if (!state.ok) {
    console.error(state.reason)
    process.exit(3)
  }

  console.log(`目标文件：${TARGET}`)
  console.log(`字节数：${state.bytes}`)

  if (extract) {
    mkdirSync(new URL('./_extracted/', import.meta.url), { recursive: true })
    const out = new URL('./_extracted/chat.client.js', import.meta.url)
    writeFileSync(out, state.source, 'utf8')
    console.log(`已导出到 ${out.pathname}`)
  }

  if (state.patched) {
    console.log('已经是打过补丁的状态，跳过。')
    return
  }

  if (!state.hasSampleAnchor) {
    console.error(
      '\n[sample 锚点没找到] 应用版本可能变了。\n' +
        '请按 docs/dsh-follow-patch.md「升级后重新定位」重新取一段原文，更新 OLD_SAMPLE。',
    )
    process.exit(4)
  }
  if (!state.hasThresholdAnchor) {
    console.error(
      '\n[threshold 锚点没找到] useScrollFollow 的 25 没找到。\n' +
        '请按 docs/dsh-follow-patch.md「升级后重新定位」更新 OLD_THRESHOLD。',
    )
    process.exit(5)
  }

  if (dryRun) {
    console.log('dry-run：两个锚点都命中，可以安全打补丁。')
    return
  }

  const backup = `${ASAR}.orig-${Date.now()}`
  copyFileSync(ASAR, backup)
  console.log(`已备份：${backup}`)

  const next = state.source.replace(OLD_SAMPLE, NEW_SAMPLE).replace(OLD_THRESHOLD, NEW_THRESHOLD)
  const tmp = `${ASAR}.tmp`
  const result = rewriteWithFile(state.asar, TARGET, next, tmp)

  // 写回前自检：新文件必须能读、目标文件必须已改、其它文件数量一致。
  const check = readAsar(tmp)
  const checkEntry = readEntry(check, TARGET)
  if (checkEntry === null || !checkEntry.toString('utf8').includes(MARKERS.sample)) {
    console.error('自检失败：新 asar 读不回补丁内容，已放弃写入（原文件未动）。')
    process.exit(6)
  }
  if (listFiles(check.header).length !== listFiles(state.asar.header).length) {
    console.error('自检失败：文件条目数变化，已放弃写入（原文件未动）。')
    process.exit(7)
  }

  renameSync(tmp, ASAR)
  console.log(`已写入 ${ASAR}（${result.outBytes} 字节，+${result.delta}）`)
  console.log('重启 DeepSeek Harness 后生效。')
  console.log(`回滚：把 ${backup} 拷回 ${ASAR}`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
