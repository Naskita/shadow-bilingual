# PLAN — Shadow Bilingual

## 目标

把 [Hemuchuan/dsh-bilingual](https://github.com/Hemuchuan/dsh-bilingual) 改造成个人版：
**对话全英文，界面双语**。仅本机长期使用，不发布、不推 Git。

验收标准（四条，均已在真实窗口验证过）：

1. 助手回复：英文正文 + 下方中文对照（沿用上游）。
2. 用户消息：发出去的是英文，气泡内下方能看到中文原文。
3. 输入框：打中文即时显示英文译文。
4. 勾选框「发送译文」默认勾选，勾着就发译文。

外加：模型侧始终用英文回复（系统提示词注入）。

## 当前状态（2026-11-17）

**四条全部通过实测。** 插件已装进 desktop profile（`shadow-bilingual@0.1.0`），
宿主路由可用，英文策略在系统提示词中生效。

## 关键决策与依据

### D1. 不重写助手侧渲染
fork 上游，保留其 `assistant-step` 双语渲染、设置页、会话头开关，只在其上叠加英文模式。
理由：上游这块已经能用，重写只会引入回归。

### D2. 用户消息中文回显：keyed 槽位 + 发送时映射
`conversation.user.text.node` 的 `key: 'text'` 是**唯一**能稳定接管用户正文的地方。

走过的弯路（不要再试）：

- `conversation.chat.user.before`（chain）：`source` 实测只有
  `{kind, rpcId, clientTimeZone}`，**没有正文**。
- `conversation.chat.user.content`（Factory，单例）：外部重复注册**不报错也不会生效**，
  组件根本不渲染（用面板暴露错误确认过：没有异常，只是没被选中）。

代价：中文原文靠发送时记录的映射（`shadow-bilingual.sent.v1`，200 条上限），
历史消息在映射被挤掉或换设备后会失去 ZH 行。**这是设计取舍，不编造原文。**

### D3. 发送拦截放在 document 捕获阶段
Enter 与点击发送按钮都汇入 `facade.submit`，但插件拿不到 facade 实例，
只能靠 DOM 捕获：`keydown Enter` / `click` → `preventDefault` →
翻译 → `setDraft(english)` → `submit()`。跳过 Shift/Alt、IME 组合态。

### D5. 插话框必须单独拦截（2026-11-17 用户指出）

**用户诊断**（m00637/m00643）：有几步中文是"DSh 运行过程中用另一个插件发送的，
那个插件和输入框不相同（插话的插件）"。

核实结果：是 `dsh-steer-note` v0.2.5，输入是 `textarea.dsh-steer-note-input`，
发送走 `sessionRemote.prompt({ mode: 'steer' })`，**与主输入框毫无关系**，
所以主拦截器完全看不到它。这就是之前那几条中文的真正来源。

关键实现细节：它是受控 React 组件，`send()` 取的是 `latestTextRef.current`（state），
不是 DOM 里读。所以拦截时不能只改 `element.value`，必须：

1. `Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el, text)`
2. `el.dispatchEvent(new Event('input', {bubbles:true}))`
3. **等约 60ms 让 React 重渲染**，再点它自己的 `button.dsh-steer-note-button`

点按钮而非直接调 send，是为了复用它的既有逻辑（附件校验、pending 状态、历史记录）。
翻译失败时同样点那个按钮——原样发出，绝不吞消息。

**实测**：中文插话"这是一条插话框翻译测试…"→ 到达模型时是
"This is an interjection box translation test; please confirm that it is sent in English"。

### D4. 英文强制用系统提示词 section
`ctx.systemPrompt.section({ name: 'bilingual:response-language', order: 9500, text })`，
由配置里的 `forceEnglish` 控制，`POST /config` 时会重装/卸载。

### D6. 消息队列单独处理（2026-11-17 用户指出）

**用户诊断**（m00838/m00859）："当你在工作的时候，你无法收到消息，消息队列里需要排队！"

这是 DSH **官方**的 inbox 队列（`InboxState['next-turn']`），与插话插件完全是两套机制：

| 机制 | 入口 | 送达时机 | 谁拦 |
|---|---|---|---|
| 主输入框 | composer（Lexical） | 我空闲时立刻 | `keydown`/`click` 捕获 |
| 插话框 | `dsh-steer-note` 的 textarea | 当前 step 结束时 | 单独拦截 + 改 value |
| 队列 | inbox `next-turn` | 整轮结束后作为下一轮 | **不走任何输入框** |

队列这条路径不经过 composer，主拦截器根本看不到它——之前队列里的中文就是这样漏的。

用户选择（m00946）：**排队时就译成英文存回去**，而不是等到送达前再拦。

实现（`QueueTranslator`，挂在 `conversation.input.dock`，`id=shadow-bilingual-queue`, order 30）：

- props 里有 `useProjection('inbox')` 读到 `next-turn` 队列行，`inject(sessionId)`
  从会话作用域取 `conversation.updateQueue`（与官方 QueueDock 完全相同的取法）。
- 发现含中文的行 → `translateDraft` → `updateQueue(id, { kind:'edit', content:[{type:'text',text:english}] })`。
- 只处理**整行都是文本**的消息；带图片/文件的行直接跳过（避免改动 content 丢附件）。
- 译完这一行不再含中文，天然不会自激；另用 `queueSeen` 表兜底防重复。
- 失败/超时 → 什么都不做，队列里保留原文，**绝不丢消息**。
- `sessions` 服务**不**写进 `inject`：声明成硬依赖时，该服务一旦缺失会让整个插件加载失败，
  连带助手双语、输入框译文全部失效。改为 `ctx.get('sessions')` 惰性获取 + try/catch，
  拿不到就静默跳过队列翻译，其余功能照常。

## 下一步（≤5 条）

1. 观察一段时间：中文原文映射 200 条上限是否够用，不够就加大或改成按会话存。
   注意插话消息也会写进这张映射（recordSent 在拦截器里统一调用）。
2. 界面产出的后续消息（"继续"/重试）不经过任何输入框，需要时再评估是否也译
   （要动宿主 `agent/pre-step`，会连带改写历史，是更大的决定）。
3. 设置页文案里还留着上游的「默认关闭」「构建 2026-11-09」等字样，与实际默认开启不符，待改。
4. `lib/index.js` 里 `ENGLISH_POLICY_TEXT` 的措辞可以按使用习惯再调。
5. 若上游 shadow-bilingual 更新了 assistant 渲染，评估是否要同步。

## D7：影子译文架构（2026-11-17，按 m01128 用户规格）

背景：用户先提出 Tab 替换并发送（照 MyTr 的影子输入），但实测 Tab 在 DSH 里
**已被补全菜单占用**（`dsh-client-ui-input-trigger/src/client/controller.ts:297`
的 `case 'tab'` 会 `pick()` 高亮项；菜单关闭时返回 `'pass'`，
`dsh-client-ui-conversation/src/client/input/editor/keymap.ts:234-238` 不阻止默认行为，
于是 Tab 会走原生焦点切换、把焦点移出输入框）。用户遂决定：**不用 Tab，保留勾选框**，
但用影子译文的呈现方式。

规格（用户原话要点）：
- 保留「发送译文」勾选框，勾选发译文、不勾发原文。
- **影子译文成功完成之前必须无法发送**；此时点发送要提示「正在翻译，翻译完成后会立即发送」。
  没有反馈会导致连点、重复发送。
- 翻译和发送进行中可以把发送按钮置为 disabled。
- 发送失败不用处理——错误显示在对话里，不在输入框里。

实现：
- `shadow = {source, english, phase:'idle'|'pending'|'ready', error, seq}`，
  `shadowListeners` + `shadowEmit()` + `shadowReset()`。
- `shadowWanted(text)`：插件开着 && 勾选框开着 && 有文本 && `hasCjk(text)`。
- `shadowRefresh(text, force)`：按停顿触发（`SHADOW_DEBOUNCE_MS = 900`），
  内部走 `translateDraft()`，**它本身已经是按段落 diff**——
  `splitUnits` 切段 → `cachedValue` 命中的段跳过 → 只把缺的段放进 payload → `replaceUnits` 还原。
  所以增量是天然具备的，不需要另写。
- `gateSend(kind, source)`：ready 且译文属于本段 → `commitShadow()`；
  pending → 记下 `pendingSubmit` 并返回 true（吞事件、不提交）；
  idle → 立即开翻 + 记下意图 + 返回 true。
- `shadowRefresh` 成功后若 `pendingSubmit` 匹配本段 → **自动 `commitShadow()`**，
  用户不需要再按一次。
- 失败/超时 → 退回 `idle`，`gateSend` 返回 false，**原文照发**。
- `SHADOW_TIMEOUT_MS = 15000`：挂死的请求到点退回 idle，避免永久挡住发送。

## D8：影子译文画到输入框里（2026-11-17，按 m01277 用户反馈）

用户实测反馈三点：
1. **看不到完整的影子翻译** —— 预览放在 dock 面板里，被 `max-height:120px;overflow:auto` 限制，长文要自己滚动。
2. **效果不自然** —— 「一会儿卡一下，又显示正在翻译」。根因是 `shadowRefresh()` 每次都把
   `shadow.english = ''` 清空，预览于是先消失、再出现「翻译中」占位。
3. **位置不好** —— 放在下方 dock 列表里，不像「影子输入」。

改法：
- `shadowRefresh()` **不再清空** `shadow.english`；重译时保留上一版，只把 `phase` 置 `pending`，
  新译文回来原地替换 → 视觉连续。
- 失败/超时同样不清空（只置 `error`），避免整块消失。
- 新增 `renderGhost()`：在输入卡片里、紧跟 `[data-input-scroll]` 之后插一个只读
  `div.sbp-en-ghost`，沿用编辑器同字号/行高/内边距，读起来是草稿正文下面的灰色续写。
- **不挂在 `[data-input-scroll]` 里面**：那容器有 14 行高度上限并自带滚动，长草稿的影子会被裁掉
  ——这正是「看不到完整译文」的原因。改为 `insertBefore(ghost, scroller.nextSibling)`。
- `ghostHost()` 优先取 `document.activeElement.closest('[data-composer-card]')`：
  页面上可能同时存在 hero 输入区和会话输入区，取第一个会画到看不见的那个上。
- ghost 由 `shadowEmit()` 直接驱动（它是纯 DOM，不受 React 调度）；
  另加 `MutationObserver` 监视卡片，React 重渲染把它摘掉时补回来。
- dock 面板瘦身：去掉预览块，只留「发送译文」勾选框 + 一句状态。

测试：`/tmp/test-ghost.cjs`（8 项）覆盖 ghost 插入、显示英文、纯英文不显示、
清空移除、长草稿可用、重译时不闪空。

## D9：改名 Shadow Bilingual v1.0.0 + 独立仓库（2026-11-17）

决定与理由：
- 名字：**Shadow Bilingual**。用户提名并经确认；「Shadow」正是输入框里那层影子译文的
  核心机制，比原来的 dsh-bilingual-en 更能说明这个定制版做了什么。
- 版本：`1.0.0`（原 0.1.0）。功能已完整且用户实测确认可用，不再是 0.x 实验态。
- 全量改名：目录 `shadow-bilingual/`、包名、插件 id、路由 `/api/shadow-bilingual`、
  localStorage 键、CSS 前缀 `dsb-` → `sbp-`、全局单例 `__shadowBilingualInterceptor`。
- 仓库：`https://github.com/Naskita/shadow-bilingual`（**私有**），首次提交 `ad52818`。

改名必须一起处理的三处联动（漏一处插件就加载不出来）：
1. `<DSH_HOME>/profiles/desktop/node_modules/shadow-bilingual` 符号链接。
2. `profiles/desktop/package.json` 的 `dependencies` + `dsh.profile.bundles`；
   **bundles 里是裸包名**，dsh-web 的客户端模块扫描只认裸包名行。
3. `profiles/desktop/pnpm-lock.yaml` 的 importer 条目（手改，未跑 pnpm install）。

数据迁移（改名后不能让历史白丢）：`loadCache()` / `readEnabled()` /
`readSendTranslation()` / `sentMap()` 都会在读到新键为空时回落到旧键并搬过来，
旧键为 `dsh-bilingual-en.*`。

教训：批量改名时把 `Hemuchuan/dsh-bilingual` 这个**上游仓库 URL** 也一起替换了，
导致 README 与 PLAN 的归属说明指向不存在的仓库。已手工修回。
改名脚本要先排除 URL、许可证与致谢段落。

## D10：改名后如何让宿主换血（实测结论，2026-11-17）

**宿主半热重载：分两种情况，结论不同。**

1. **加进来的新 bundle —— 可以不重启。**
   `plugin_manager set_bundle {target:"shadow-bilingual", enabled:false}` 再 `enabled:true`，
   新插件的宿主半会被**重新挂载**。实测：操作前 `/api/shadow-bilingual/health` 返回
   `401 unauthorized`（网关对未注册路由的统一应答），操作后立刻变成 `200` 并返回
   正确的 `configPath: /Users/naskita/.dsh/shadow-bilingual.json`。

2. **从 profile 里删掉的旧 bundle —— 必须重启。**
   `package.json` 的 `dsh.profile.bundles` 里已经没有 `dsh-bilingual-en` 了，
   `plugin_manager list_plugins` 里也搜不到它（`set_plugin` 报 `unknown-plugin`），
   但它在**启动时就挂上去了**，宿主里那个实例还在：
   - `/api/dsh-bilingual-en/*` 仍返回 200
   - 界面上出现**两个**「发送译文」复选框（新旧各注册一次 `conversation.composer.dock`，
     id 分别是 `dsh-bilingual-en-live` 与 `shadow-bilingual-live`）
   - 会话头出现**两个**「双语 v4.4 ON」复选框（两个 `conversation.session.header.actions`）
   - 新旧两套 Enter 拦截器并存，正是双重发送的温床

   它已经不在配置树里，所以 `plugin_manager` 无法寻址它——**只能重启**。
   `touch cordis.patch.yml` 也无效（实测）。

排查教训：`curl` 探路由时先打一条**确定不存在**的路由做对照。本机网关对任何
未注册的 `/api/*` 都回 `401 unauthorized`，单看这条无法区分「插件没加载」和
「路径写错」。

3. **`plugin_manager remove_bundle` + `install_bundle` 也不会重新求值宿主半。**
   实测：先 remove（profile 里真的摘掉了），再 install（pnpm 重新 link、锁文件更新），
   路由仍在应答，但返回的 JSON 里**依然没有新字段**。
   判据：`/config` 返回体里缺 `localLanguage`，而源码 `publicConfig()` 明明有。
   结论：只有**重启进程**这条路。

4. **`pgrep -f 'dsh-desktop-host/lib/index.js'` 在本机匹配不到宿主。**
   进程命令行极长且路径含空格，`pgrep` 返回空。必须用
   `ps ax -o pid=,command= | grep 'dsh-desktop-host/lib/index.js' | grep -v grep`。

5. **HTTP 端口每次启动都会变**（历史值：55443 → 65285）。重启脚本不能写死端口，
   要从宿主进程的监听 socket 现取：
   `lsof -nP -iTCP -sTCP:LISTEN -a -p <pid> | awk 'NR>1{split($9,a,":"); print a[n]}'`。
   `scripts/restart-dsh.sh` 已改成这样，并在报告里带上 `hasLocalLanguage` 作为
   「新代码是否真的跑起来」的判据。

6. **`credentials` 服务不能在 `apply()` 里取一次就缓存。**
   插件常常是在应用启动**之后**才被 `plugin_manager` 挂载的，那一刻凭据服务未必
   就绪。早先缓存了 `null`，结果 `/health` 永远 `hasKey:false`、翻译整个不可用，
   而界面上什么都不提示（设置页只显示「还没配置 Key」）。
   现在 `resolveKey()` 每次经 `credentialsService()` 现取，并加了回归测试
   `credentials service is looked up per call, not cached at apply()`。

## 未决问题

- 换设备/清 localStorage 后，旧会话没有 ZH 行——可接受，但用户应知情。
- 双语开关（会话头「双语 v4.4」）关掉时，用户消息的 ZH 行也一起关——行为一致，符合预期。

## 测试

`tests/send-path.cjs`（不碰真实界面，直接驱动拦截器判定）：

```
node tests/send-path.cjs lib/client.js
```

22 项断言，覆盖：译文未就绪时先不提交、译文就绪后自动发一次、连按只发一次、
翻译失败放行原文、失败后再次 Enter 走原生提交、翻译挂起不吞成双发、
上一段挂起的翻译不影响新消息、队列中文行被译成英文、带附件行不动、
队列翻译失败保留原文、同一行不重复翻译、document 监听器唯一。

注意：影子翻译**挂起**时不会永远挡住发送——`SHADOW_TIMEOUT_MS`（15s）到点退回
`idle` 并清掉待发意图，原文可以正常发出。

`tests/list-slots.cjs`：干跑 bundle，打印注册的全部槽位与监听器数量，改完先跑它。

## D11. 本地显示语言可选（AI 侧固定英文）

**需求（m01815）**：仓库做成中英双语；插件可选「本地语种」，AI 语种固定英语（对模型最友好）；
本地语种要多一些选择，并放进插件设置项。

**语言模型**（两套语言，互不影响）：

| 侧 | 语言 | 用途 |
| --- | --- | --- |
| AI / 模型 | 固定 `en` | 输入框、插话框、队列里的非英文内容，发送前一律换成英文 |
| 显示 / 用户 | 可选（18 种） | 助手英文正文下方补该语言对照；用户气泡下方也用它 |

**关键设计**：

1. **`translationTarget(unit, options)` 变成两模式**：`{mode:'english'}` 只产出 `target:'en'`
   （发送路径）；`{mode:'local'}` 产出 `target: localLanguage`（显示路径）。
   原来的 `source === 'zh' ? 'en' : 'zh'` 二元判断彻底删掉。
2. **`unitKey(unit, target)` 带目标语言**：同一段英文在本地语种=日文和=中文下是两条不同译文。
   不带 target 时退化为旧行为，老缓存不会因为升级全部失效。
3. **`languageOf()` 扩成书写系统探测**：假名→ja、谚文→ko、汉字→zh、西里尔→ru、阿拉伯→ar、
   希伯来→he、天城文→hi、泰文→th，最后才是拉丁→en。
4. **`detectLatinLanguage()`**：es/fr/de/pt/it/nl/pl/tr/vi/id 之间只能靠高频虚词区分
   （`¿¡`→es、`ß`→de、`ãõ`→pt、越南语声调→vi 是强信号）。**只用来回答「这段是不是英语」**，
   判错代价只是一次多余翻译请求，模型会原样返回，不会被采用。
5. **`needsEnglish(text, localLanguage)`** 取代全项目原本的 `hasCjk()` 作为发送闸门。
   这是本轮最容易漏的地方：`shadowWanted`、`interceptSteerSend`、`installSubmitInterceptor`
   里 6 处 gate、`QueueTranslator`、`translateDraft` 入口，全部换掉了。
6. **校验按目标语言的书写系统**：`translationLooksValid()` 在客户端、`validTranslationText()`
   在宿主各有一份实现（客户端不能 import 宿主模块）。中文目标要求真有汉字，日文目标要求
   假名或汉字，英文目标要求拉丁字母占优——这样「en 目标却回了中文」会被拒掉并重试。
7. **拉丁兄弟语言之间不做硬校验**：字符集分不出来，硬校验只会误杀正确译文。

**设置页**：`设置 → 双语` 新增「本地显示语言」卡片，18 项下拉框，切换即写 localStorage
（`shadow-bilingual.localLanguage`）并 `store.retry()` 触发重扫。宿主侧同名字段
`localLanguage` 落在 `~/.dsh/shadow-bilingual.json`，`/config` 的 GET/POST 都支持。

**测试**：`tests/` 从 12 项扩到 14 项，新增「多语种显示目标与书写系统校验」
「缓存键按目标语言分开」两组；宿主测试断言 `SYSTEM_PROMPT` 里列出了所有语言码、
`/config` 能读写 `localLanguage`、`zh_tw` 归一化成 `zh-TW`、未知值回落 `zh`。

## 最近改动

1. 新增 `PlainUserTextBilingual`，接管 `conversation.user.text.node` key `text`。
2. 移除无效的 `conversation.chat.user.before` 座位与单例 Factory 覆写。
3. 清理死代码：`panelDom()`、重复的 `userSourceText()`。
4. `CACHE_KEY` 升到 `v2`；`userChineseOrigin()` 加 `hasCjk` 硬校验（防英文误当中文原文）。
5. 修复拦截器重复注册（`document` 监听原先注册了两遍）。
6. 新增插话框拦截（`focusedSteerTextarea` / `interceptSteerSend` / `setSteerValue`），
   主输入框与插话框共用 `intercepting` 锁与翻译缓存。
7. **发送链路重做**（按 m00794 用户规格）：取消边打字边翻译，改为发送时翻译；
   翻译失败/超时（12s）一律原文照发，**绝不阻塞、绝不吞消息**。
8. **修复"按回车没反应"**：`intercepting` 原先只在成功路径复位，异常路径会永久卡死。
   现在 `finish()` 内 `release()` 无条件释放，另加 20s 看门狗。
9. **修复"600ms 内新消息被吞"**：`inFlight` 原先只看时间，现在按内容判断——
   只有同一段草稿才算重复发送，新草稿照常发。
10. 新增队列翻译 `QueueTranslator`（见 D6）。
11. **重写为影子译文架构**（按 m01128 用户规格，见 D7）：删除 `interceptSend()`，
    改为 `shadow` 三态（idle/pending/ready）+ `gateSend()` + `commitShadow()`；
    译文未就绪时**吞掉发送并给出提示**，就绪后**自动发出去**，不需要再按一次。
12. 修复重构中丢失的 `sentMap()` / `sentKey()`（`ReferenceError: sentKey is not defined`
    会让每次发送都抛异常，用户看到的是「点发送没反应」）。
13. 修复 `gateSend` 缺 `sameDraft(shadow.source, source)`：会把**上一段草稿的旧译文**
    当成本段译文发出去，发的内容完全不相干。
14. 修复影子挂起导致**所有后续消息永久发不出去**：加 `SHADOW_TIMEOUT_MS` 与
    「影子属于别的草稿时立即重开」两条路径。
15. **本地显示语言可选**（D11）：`translationTarget` 两模式、`unitKey` 带目标语言、
    `languageOf` 扩成书写系统探测、新增 `needsEnglish` / `detectLatinLanguage` /
    `translationLooksValid`；设置页加 18 语种下拉框；宿主加 `localLanguage` 配置与
    多语言 `SYSTEM_PROMPT`。
16. README 改写成中英双语（英文在前、中文在后）。
