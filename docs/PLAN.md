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
  （2026-11-18 补记：当前发布版本已升到 `1.0.1`，见 D16 与 `CHANGELOG.md`。）
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

5. **HTTP 端口每次启动都会变**（历史值：55443 → 65285 → 51055 → 54323）。任何脚本都不能
   写死端口，要从宿主进程的监听 socket 现取，再逐个探
   `/api/shadow-bilingual/health`：
   `lsof -nP -iTCP -sTCP:LISTEN -a -p <pid> | awk 'NR>1{split($9,a,":"); print a[n]}'`。
   原来做这件事的 `scripts/restart-dsh.sh` 会顺带 `kill` 宿主，已于 2026-11-18 从仓库删除
   （见「事故复盘」与 D15）；替代品 `scripts/apply-changes.sh` 只读端口和健康接口，
   靠 `logic` 标记判断宿主是否过期，**不发任何信号**。

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
17. **助手侧中文对照恢复渲染**（D14）：`decorate()` 兜底查不带目标语言后缀的键，
    `translationsFor()` 同时写两份键——此前缓存命中了却一个字都不渲染。
18. **混排段落按主体语言判定**（D13）：客户端改用英语虚词命中，宿主改占比 0.3，
    不再「出现一个汉字就整段判中文」。
19. **译文不可用按失败处理**（D16）：`shadow.error` 落值 + 宿主 `looksEnglish()`，
    「中文夹英文标识符」既不会被误判成英文，也不会再被发送闸门永久吞掉。
20. 删除会 `kill` 宿主的 `scripts/restart-dsh.sh`，换成只读的 `scripts/apply-changes.sh`
    （D15）；发布 `1.0.1`，新增 `CHANGELOG.md` 并同步 README 计数（22 单测 / 24 发送链路）。

## D12：原文已是目标语言时不再请求模型（2026-11-17 晚）

**问题**：`~/.dsh/shadow-bilingual-errors.log` 里成片 `status=502 empty`。旧逻辑把
「模型原样返回」一律判成无效译文；当助手这次直接用中文回答、客户端又按显示语言 `zh`
请求时，模型按提示词「已经是目标语言就原样返回」，宿主却拒掉 → 重试 → 空 → 502。

**改法**（`lib/index.js`）：

1. 新增 `alreadyInTarget(text, target)`：按书写系统判断原文是否已经是目标语言。
   注意 `en` 是特殊目标，**不在** `TARGET_LANGUAGES` 里，要用 `latinDominant` 单独判。
2. `translateItems()` 先分流：已经是对应语言的段落**不进请求队列**，原样返回；
   全部被分流时不再要求已配置 Key。
3. `validTranslationText()` 的同一性校验：原样返回只有在「原文本来就是目标语言」
   或「原文没有任何字母（`—`、`1)`、emoji）」时才算有效；目标 `en` 却回中文仍判失败。

**代价**：拉丁兄弟语言之间仍分不出来，宁可显示未变形的原文，也不再把整段判成 502。

**测试**：`tests/host.test.mjs` 新增 2 组（同语言零请求 / 懒惰模型仍失败），5/5 通过；
发送链路 22/22；槽位清单不变。

## 事故复盘：DSH 反复重启（2026-11-17 晚间）

- **现象**：桌面端每隔几十秒弹「应用无法启动或已意外停止」，GUI 端口不断变化。
- **误判点**：崩溃报告的「错误详情」只是宿主 stderr 的最后一截，不是根因——
  19:06 / 19:24 两份报告的「错误」第一行竟是成功的 model listing 日志。
- **真因**：开发用的 `scripts/restart-dsh.sh`（副本 `/tmp/shadow-restart.sh`）反复执行
  `osascript quit` → `kill 宿主 PID` → `open -a`。宿主被 SIGTERM 杀死，Electron 主进程
  判定「宿主意外停止」→ 弹崩溃窗。`/tmp/shadow-restart-report.json` 的多次写入是物证。
- **结论**：不要用 kill 宿主的办法让插件生效；用插件管理的启用/停用，或正常退出重开。
- **已处置（2026-11-18）**：`scripts/restart-dsh.sh` 已从仓库删除（`/tmp` 里的副本一起删），
  仓库不再有任何杀宿主进程的脚本；替代品 `scripts/apply-changes.sh` 只重建客户端、可选跑自检，
  并通过 `/health` 的 `logic` 标记报告宿主是否需要重开，需要时提示人正常退出（见 D15）。
- 顺带确认：`dsh-desktop-automation@0.1.1` 调用 `scope.settings.register`，而宿主
  0.2.2-rc.3 的 settings 已换成 `SettingsForms`，属版本不兼容（非崩溃主因）。

## D13：混排段落不能按「出现一个汉字」判整段语言（2026-11-17 深夜）

**现象**：用户发言有双语对照，助手回复整段保持原文，没有任何中文对照。

**根因（两层，同样的错）**：

1. 客户端 `lib/markdown.cjs` 的 `languageOf()`：`han >= 1` 就 `return 'zh'`
   （全角标点也一票判中文）→ `translationTarget()` 认为这段已经是本地语言，直接返回 `null`，
   一个翻译请求都不发。
2. 宿主 `lib/index.js` 的 `alreadyInTarget()`：`SCRIPT_TEST[script].test(text)` 只要
   出现一个汉字就判「原文已是目标语言」→ 进 `passthrough`，把原文当译文返回：
   HTTP 200、错误日志无记录，完全静默。

所以不是「开头是中文」，而是**每个段落/列表项/表格单元里只要有一个汉字**就被整段放过。
助手回复常夹中文引用、中文术语，于是大段英文永远没有译文。

**改法**（双端统一：看主体是不是英文句子，而不是看有没有汉字）：

- 客户端：`latin >= 8 && hanShare <= 0.35 && englishWordHits(plain) >= 2` → `'en'`，
  否则仍 `'zh'`。`englishWordHits()` 用 `ENGLISH_HINTS`（约 100 个英语高频虚词，
  故意不含单字母 a/i，避免 `(a) Fringing（3 分）` 被误判）。
- 宿主：新增 `SCRIPT_COUNT` + `countScript()`；`alreadyInTarget()` 改为
  `own = countScript(text, spec.script)`，`own === 0 → false`，拉丁语言目标直接 true，
  其余要求 `own >= countScript(text, 'latin')`——目标文字不输给拉丁字母才算已是目标语言。
- 兼容保留：`(a) Fringing（3 分）`、`功率因数 0.88 滞后（lagging）：`、`由 (ii)：`
  仍判 `zh`；中文段落夹 API 名/命令不会被重复翻译。

**验证**：`tests/markdown.test.mjs` 新增「混排：英文正文夹一句中文引用仍然要翻」；
`tests/host.test.mjs` 新增「英文段落里夹一句中文引用时仍然要翻」（断言真的发给模型）。
`bash tests/run-all.sh` = build + 19 个单测 + 发送链路 22/22 + 槽位 6 项，全部通过。

**生效方式**：客户端改动需要刷新页面；宿主改动需要重载插件。实测
`plugin_manager set_bundle`（停用→启用）**不会**重新 import 被 symlink 的宿主模块
（`/health` 新增的 `logic: 'mixed-v2'` 标记没有出现），所以宿主侧要正常退出重开应用
（`scripts/restart-dsh.sh` 已删除；用 `./scripts/apply-changes.sh` 判断宿主是否过期，
退出码 2 就说明该正常退出重开）。`/health` 现在会回报 `logic` 字段，
重开后可据此确认新判据已生效。

**D13 补充（同一个晚上，线上实测后）**：宿主第一版判据是「目标文字数 >= 拉丁字母数」，
把「英文正文夹一句中文引用」（占比约 0.17）判成待翻，正确；但「中文正文夹长标识符」
（如 `这个配置文件里没有 localLanguage 字段。`，占比 0.46）被判成待翻 → 模型原样返回 →
同一性校验拒绝 → 该 item 被丢弃并写 `status=502 empty`（23:06 实测日志可查）。
改为按占比 `own / (own + latin) >= 0.3` 判断「已是目标语言」，并把 `logic` 标记升到
`mixed-v2.1`。客户端那边有「英语虚词命中 >= 2」这道额外闸门，占比 0.46 的中文段落
不会被送出来，所以线上可见行为不受影响；宿主这一版随下次重启生效。

## D14：助手回复「没有中文对照」的真正原因——decorate 的键不带 target（2026-11-18 凌晨）

**症状**：用户消息正常显示英文＋ZH 徽章，助手回复整段只有英文，没有中文对照；
`/api/shadow-bilingual/translate` 手工请求完全正常，`~/.dsh/shadow-bilingual-errors.log`
也没有新记录（不是 502）。

**怎么定位的**（这套手段以后可以直接复用）：
1. GUI 无法用 curl 读（`GET /` → 401 `dsh web authentication required`），relay 也对不上
   （503 `instance-offline`），所以走 `agent-desktop snapshot --app "DeepSeek Harness"
   --timeout-ms 25000 --max-depth 40`，再用 node 遍历 `data.tree` 过滤 `native_id`。
   `list-windows` 报的 bounds 不可信（124×146 pt），页面内实测 1280×820。
2. 临时给助手外层加 `id="sbp-as-<step>"`、给 `apply()` 注入一个 1px 透明
   `div#sbp-diag-line`（`setInterval` 1s 写模块级 `diagSink`），这样能从无障碍树读到
   「这一刻的判定结果」。实测读数 `ENS u=10 t=10 m=0 cc=400 inf=0 es=0 rst=0`
   → 10 个单元都需要翻译、**missing=0**、缓存 400 条已满、没有失败 → 译文早就请求回来了。
3. 对照代码才发现：`translationsFor()` 建 map 用的键是
   `unitKey(unit, target.target)`（带目标语言后缀），而渲染处
   `ShadowMarkdown.decorate(text, map)` **没有传第三个参数 target**，
   `decorate()` 内部查的是 `translations[unitKey(unit, target)]`（target 为 undefined →
   后缀是空串）→ 键永远对不上 → 缓存命中却一个字都不渲染，且不报错、不发请求。

**修复**：
- `lib/markdown.cjs` 的 `decorate(text, translations, target)`：先按 target 精确查；
  查不到再试「不带后缀的键」；只有在**调用方没传 target** 时才进一步按 `kind\0…\0content`
  匹配任意后缀（显式传 target 时保持严格，避免同一段英文的中文 / 日文对照串台）。
- `lib/client.template.js` 的 `translationsFor()`：命中缓存后同时写两份键
  （带 target 与不带 target），老调用方也不会再漏渲染。
- 回归测试（`tests/markdown.test.mjs`）：
  「译文 map 带目标语言后缀、调用方没传 target 时仍然要渲染」、
  「译文 map 只按单元建键（不带后缀）时也要渲染」；原有
  「cache keys separate the same source by target language」仍严格要求 target 隔离。

**验证**：`bash tests/run-all.sh` → build、21 个单测、发送链路 22/22、槽位 6 项全过。
线上同一渲染器热载后，助手消息 `Restart verified — the new host logic is live…`
下面已经出现 `重启已验证——新的宿主逻辑已生效，而且我已经拿到了插件的修改前后对比测量结果。`
等中文段落。诊断用的 span / `#sbp-diag-line` / store 计数已全部移除，正式修复保留。

**教训**：这条链路上「翻译成功了」与「渲染出来了」是两件事。以后排查显示问题，
先确认缓存里有没有值（diag `m=0/cc=…`），再确认查表用的键是否与建表一致。

## D15：删掉会杀宿主的重启脚本，换成只读的 apply-changes（2026-11-18）

**决定**：删除 `scripts/restart-dsh.sh`（以及 `/tmp` 里的副本），新增
`scripts/apply-changes.sh`；README 英文/中文两节与 `install.mjs` 的说明同步改写。

**理由**：那个脚本「让旧 bundle 彻底退场」的能力，靠的是 `osascript quit` 之后
`kill <宿主 PID>`。宿主被 SIGTERM 杀死时 Electron 会报 "app stopped unexpectedly" 并弹修复
对话框——2026-11-17 的崩溃循环就是它造成的（见「事故复盘」）。便利性不能建立在
「随时可能把应用打死」上，而且真正需要它的场景（旧 bundle 残留在宿主里）已经不存在了：
现在的宿主半只有一个 symlink 进来的模块，改动靠「正常退出重开」加载即可。

**新脚本做什么**：
1. `node build.mjs` 重建 `lib/client.js`（带 `--test` 时改走 `tests/run-all.sh`）；
2. 用 `ps ax -o pid=,command= | grep dsh-desktop-host/lib/index.js` 找宿主 PID
   （`pgrep -f` 在本机匹配不到，见 D10 第 4 条），用 `lsof` 列它监听的端口；
3. 逐个端口探 `/api/shadow-bilingual/health`，读出 `logic` 标记，与 `lib/index.js`
   源码里的期望值比对，报告宿主是否还在跑旧代码。

**新脚本不做什么**：不发任何信号、不退出应用、不改 profile、不写配置文件。

**Agent 约定（`git pull` 之后直接可用）**：
- 退出码 `0` → 客户端已重建，宿主也是当前代码（或应用没运行），无需人介入；
- 退出码 `2` → 宿主半过期，需要人正常退出（⌘Q）再重开；脚本已经把这句话打印出来；
- 退出码 `1` → 构建或自检失败，先修再谈生效。

**同步改动**：README 两节都改掉了「宿主侧改动需要重装」的旧说法（实测重装不会重新 import
宿主模块），并写清「绝不 kill 宿主」；自检项数 `15` → `22`；`package.json` 增加
`npm run apply` / `npm run check` 两个入口，方便 Agent 记住一条命令。

## D16：译文不可用必须按失败处理，宿主的「已经是英文」不能只看拉丁字母数量（2026-11-18 凌晨）

**现场**：用户单独发「帮我装插件hermes-loop」按 Enter 毫无反应，草稿一直留在框里。

**根因（两层，同一句话上叠加）**：
1. 宿主 `alreadyInTarget(text, 'en')` 用的是 `latinDominant()`：`latin >= foreign * 1.5`。
   这句话 latin 10（`hermes-loop`）、foreign 5（帮我装插件）→ 10 ≥ 7.5 → 判「已经是英文」
   → `translateItems` 把它塞进 `passthrough`，原样退回。
2. 客户端 `translateLooksValid()` 把「译文 == 原文」判为无效（这是对的），于是
   `usableEnglish()` 为假，`shadowRefresh` 走 `!usableEnglish` 分支：`phase = 'idle'`、
   **`error = ''`**。`gateSend()` 的逃生阀是 `shadow.error !== '' && sameDraft(...)`，
   error 为空永远不成立，于是落回最后一段「idle + 含中文」→ 再拦一次、再翻一次、
   再拿回同一段原文。**每次 Enter 都被吞，消息永远发不出去**。

**决定**：
- 客户端：`!usableEnglish` 分支按失败处理——`shadow.error = '无法生成英文改写，将按原文发送'`
  + `clearPendingSubmit()`。面板显示「翻译失败，将发送原文」，再按一次 Enter 走原生提交。
  「卡住」永远比「发原文」糟糕。
- 宿主：新增 `looksEnglish()`——先要求 `latin >= 2`；纯拉丁文本（`foreign === 0`）直接放过；
  含中日韩文字时必须再命中 **≥2 个英语虚词**且 `latinDominant` 才判「已是英文」。
  虚词表 `ENGLISH_HINTS` 与 `lib/markdown.cjs` 同一份（约 100 个，不含单字母 a/i）。
  display 目标 `zh` 的 0.3 占比判据**不动**（保住「中文夹 localLanguage 标识符」不送翻）。

**验证**：
- `tests/send-path.cjs` 新增 `translateMode = 'echo'`（原样退回）+ 场景 4c：
  译文==原文时第二次 Enter 必须放行（修前 FAIL，修后 PASS，24/24）。
- `tests/host.test.mjs` 新增「中文句子夹英文标识符、目标是英文时仍然要翻」：
  `帮我装插件hermes-loop` 必须发出请求并换成英文；同时断言已经是英文的混排段落仍走 passthrough。
- `bash tests/run-all.sh` → build、22 单测、发送链路 24/24、槽位 6 项全过。

**生效方式**：客户端改动热载；宿主改动需要正常退出重开（⌘Q 后重开，**不要** kill）。
在重开之前，客户端修复已经能让这句发出去（第一次 Enter 后提示「翻译失败，将发送原文」，
再按一次即发原文）。

## D17：仓库整理成可被 awesome-dsh-plugin 收录的状态（2026-11-18 凌晨）

**背景**：用户想把本插件提交到 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。
按它的 `contributing.md`，仓库侧要求是：`package.json` 声明 `dsh.bundle`、仓库根有 `cordis.patch.yml`、
有真实代码、仓库创建满 1 天、加 topic `dsh-plugin`、描述与实际功能一致；官方 `@deepseek-ai/*`
用带预发布分支的 peer 范围。列表条目只需一个 `data/plugins/<owner>__<repo>.yml`。

**做了什么**：
1. `package.json` 补 `repository` / `bugs` / `homepage`（npm↔GitHub 映射靠它们），版本 1.0.1 → 1.0.2。
2. **删掉 `peerDependencies.react`**。React 由 DSH 客户端运行时提供（profile 里根本没装 react，插件
   照样能跑），官方客户端插件也只在 devDependencies 里放 react。留着 peer 的唯一效果是每次安装都打印
   `missing peer react`。删掉后 `pnpm peers check` 变成 `No peer dependency issues found`。
3. 重画 `docs/preview.png`：旧图写着 `dsh-bilingual`、画的是**上游布局**（中文正文下补英文），与本
   fork 的实际行为（英文正文下补中文、输入框中文草稿下补英文影子）相反。
4. README 增加面向使用者的 **Install** / **安装** 小节：`dsh plugin --profile desktop add
   github:Naskita/shadow-bilingual`（网页版用 `--profile web`），装完正常退出再重开。
5. GitHub 仓库加 topics：`dsh-plugin`、`dsh`、`deepseek-harness`、`bilingual`、`translation`。

**验证**：
- 一次性 profile 实测商店生成的命令：`DSH_HOME=/tmp/dsh-probe-home dsh plugin --profile probe add
  github:Naskita/shadow-bilingual` → 装上 `shadow-bilingual 1.0.1`，`dsh.profile.bundles` 里出现
  `shadow-bilingual`，说明 `dsh.bundle` 被正确识别。
- 删掉 react peer 后用本地 tarball 再装一次：`No peer dependency issues found`。
- `npm pack` 内容 12 个文件（lib / cordis.patch.yml / README / CHANGELOG / docs）。

**未决**：
- **仓库创建于 2026-11-17T18:15Z 左右，门禁要求满 1 天**，即 2026-11-18T09:31Z（本地 17:31）之后
  提交才会通过 CI；被挡是快照结论，之后自动重跑，不需要关掉重开 PR。
- 上游 `Hemuchuan/dsh-bilingual` **已经在列表里**，reviewer 有理由问「这是不是重复」。条目描述必须
  突出差异：本 fork 改的是**发送侧**（英文影子输入 + 三条路径全英文发送 + 本地语言对照可选），
  上游只有助手侧的双语渲染。

## D18：18 种显示语言逐语言实测；只有中文能翻（2026-11-18 凌晨）

**现场**：用户看不懂其他语言，要求把 18 种显示语言逐个实测一遍。对运行中的宿主直接
`POST /api/shadow-bilingual/translate`（脚本 `/tmp/test-langs.mjs`）：

| 目标 | 修前 | 原因 |
| --- | --- | --- |
| `zh` | ✅ | — |
| `ja` | 只有假名才翻 | `SCRIPT_COUNT.ja` 含汉字区间，纯汉字被判「已是日文」 |
| `zh-TW` | ❌ 从不转换 | 简繁共用 `script:'zh'`，占比判定把简体当已达成 |
| `ko ru ar hi th` | ✅ | 文字系统不同，占比判定有效 |
| `es fr de pt it nl pl tr vi id` | ❌ 全部原样返回 | `alreadyInTarget` 里 `if (spec.script === 'latin') return true`——出现任何拉丁字母就判「已是目标语言」 |

**决定**：

1. 宿主 `alreadyInTarget` 按目标分别判：`latin` 系语言用 `detectLatinLanguage()`（倒问号/ß/ã/õ/
   ăâđêôơư 等形态特征 + 十种语言各 30–40 个虚词计分）判断源语言是否等于目标；`zh`/`zh-TW` 用
   `looksTraditional()`（繁体字表命中 > 简体字表命中）；`ja` 必须先有假名；其余语言保持占比。
2. `looksEnglish` 的 `foreign === 0` 分支也要排除「另一个拉丁语言」，否则西语/德语草稿会被当成
   英文原样放行。
3. 客户端 `markdown.cjs` 同步：`languageOf()` 能认出十种兄弟语言与简繁，`sameLanguage()` 把
   `zh` 与 `zh-TW` 视为不同目标（此前 `source === localBase` 会把简体→繁体的请求直接吞掉）。
4. 两端的 `LATIN_HINTS` 必须逐字一致，否则「客户端认为该翻、宿主认为已达标」会静默空转。

**验证**：

- `bash tests/run-all.sh` → build + 25 单测 + 发送链路 24/24 + 槽位 6 项全过。
- 真实 API 端到端（`/tmp/probe18.mjs`，复用 `~/.dsh` 的真 Key，直接 import `lib/index.js`）：
  18 种目标全部 `ok`、`status 200`、1.2–1.9 s 真实模型调用；额外验证西语/日语/中文草稿发
  `target:en` 都被正确改成英文。报告 `/tmp/probe18.json`。
- 运行中的应用仍是旧宿主代码，界面上的这 10 种语言要正常退出重开后才生效。

**同批**：插件中文名定为 **影译**；`docs/icon.png`（512×512，深色圆角 + 白「文」蓝「A」）；
`docs/preview.png` 换成运行时真实截图；会话头开关从继承来的「双语 v4.4」改成「影译 + 本包版本号」，
版本号由 `build.mjs` 从 `package.json` 注入（`__SBP_VERSION__`），避免与另一个双语插件混淆。

## D19：截图必须用中性演示会话，且演示会话要显式要求英文（2026-11-18 凌晨）

**背景**：D18 里换上的 `docs/preview.png` 是从本开发会话裁的，用户否掉了——
「that would expose our development work」。

**决定**：

1. 商店/README 截图一律在**新建的中性会话**里拍，只裁对话列，绝不带侧栏私有标题、费用、账号名。
2. 演示会话必须自己在提示里写「用英文回答」：助手的回复语言跟**对话上下文**走，不是插件决定的。
   本开发会话一直英文，是因为用户早前说过 `Reply in English for the upcoming work arrangements`。
3. 中性会话的第一条消息不要用来演示：插件在会话建立前还没接管输入框。

**两个实测发现（前者是缺陷，待修）**：

- **新会话的第一条消息不会翻译**：composer 下方连 `EN / 翻译中` 都不出现，直接 Enter 就把原文发出去，
  模型收到中文、也用中文回。等第一轮结束、`conversation.composer.dock` 的 shadow 面板挂上后，
  后续消息才正常。演示脚本因此先发一句 `hi` 建立会话，再发真正要展示的那条。
- **助手默认说中文**：插件只保证「模型读到英文」，不强制模型回答的语种；要英文回答必须写在提示里。

**结果**：`docs/preview.png`（1200×931）来自会话 `Remote work focus and interru…`：
用户气泡 = 英文（实际发出的）+ `ZH` 徽章 + 中文原文；助手两条英文要点下方各有中文对照；
顶部 `影译 v1.0.3 ON`。无侧栏、无费用、无账号信息。

**补充（用户指出）**：上游本来就有「助手英文正文 + 中文对照」，所以单看对话截图区分不出我们的东西。
真正属于这个 fork 的是**发送侧**：composer 里中文草稿下方那行灰色英文影子，发出去的就是它。
因此截图拆成两张，并且先放发送侧：

- `docs/preview-input.png`（1240×213）：composer 卡片，中文草稿 + 灰色英文影子 + 模型选择器。
- `docs/preview.png`（1200×931）：对话区，用户气泡英文（实发）+ `ZH` + 中文原文；助手两段英文 + 各自中文对照。
- `screenshots.json` 顺序改为 `["docs/preview-input.png", "docs/preview.png"]`，README 两半都加了
  “Send side / Display side” 说明，先展示发送侧。

## D20：「发送译文」搬进输入框工具行，状态条只留一个短标记（2026-11-18 凌晨）

**用户反馈**（m02542）：勾选框应该属于输入框本身，放在下方菜单栏里截图不好讲；状态可以留在菜单栏，
但要用一个短状态表示，菜单栏位置很宝贵。

**做法**：

- 新增槽位注册 `conversation.input.left` id `shadow-bilingual-send` order 50，`SendToggle` 组件
  与 `+`、权限、推理档位同一行；样式 `.sbp-send-toggle`（12px、12×12 勾选框、不换行）。
- `conversation.composer.dock` 的 `LiveTranslationPanel` 只负责两件事：驱动影子译文的防抖刷新 /
  ghost 渲染，以及渲染一个短状态 `.sbp-en-status`：`EN`（就绪）、`···`（翻译中）、`!`（失败）。
  详细说明改成 `title` 提示，不再占位。
- 顺手删掉面板里已不再使用的 `checked/setChecked`，避免 `checked is not defined` 这类残留。
- 测试：`tests/client.test.mjs` 期望槽位列表补 `conversation.input.left`（6 → 7 项）。

**验证**：`bash tests/run-all.sh` → build + 25 单测 + 发送链路 24/24 + 槽位 7 项全过；
截图 `docs/preview-input.png` 重拍（输入框内勾选框 + 灰色英文影子），版本 1.0.4。

## D21：新会话首条消息不翻译——首屏输入框没有 inputActions（2026-11-18 凌晨）

**症状**：全新会话里输入中文，直接 Enter 就按原文发出，模型收到中文、也用中文回；等这一轮结束后
（会话建立、composer 的 dock 面板挂上）后续消息才正常。

**根因**：`installSubmitInterceptor` 的 `gateSend('composer', …)` 在 `composerBridge.actions === null`
时直接 `return false`（放行），而 `composerBridge.actions` 只由 `conversation.composer.dock` 的
`LiveTranslationPanel` 从 `props.inputActions` 写入。首屏（hero）输入框没有这个 owner prop，
于是拦截器认定「接管了也发不出去」→ 放手 → 原文原样发出。

**修法**（不依赖插槽挂载顺序）：

1. 新增 `liveEditorElement()`（activeElement 的 `[contenteditable="true"]`，退回 `[data-lexical-editor="true"]`）、
   `composerSendButton()`（在 `[data-composer-card]` 内按 `aria-label` 找发送按钮）、`canNativeCommit()`。
2. `gateSend` 的放行条件改成「既没有 actions、也没有可点的发送按钮」才放弃；只要编辑器 + 按钮都在就接管。
3. `commitShadow` 的 composer 分支在没有 actions 时走 DOM 兜底：`writeEditorText()`（`execCommand('insertText')`，
   失败退回 `textContent + InputEvent('input')`）→ 等 60ms 让 Lexical 同步 state → 点自己的发送按钮。
4. 回归测试：`tests/send-path.cjs` 新增场景 1b（假 document 提供 `__buttons`）断言「首屏无 actions 时先接管、
   英文写进编辑器、点了发送按钮」；原有场景 1（真拿不到按钮时不吞消息）保持通过。

**版本**：1.0.5。**验证**：`bash tests/run-all.sh` 全绿（26 项发送链路 + 25 单测 + 7 槽位）。


## D22：英文译文被误判成西语 → 502，新会话第一条永远发不出去（2026-11-18 凌晨）

**现场**：`~/.dsh/shadow-bilingual-errors.log` 03:33:28
`status=502 empty model=deepseek-chat items=[{"id":1,"text":"我需要你帮我用英文回答…","target":"en"}]`，
而同一行的 `content=` 里模型明明给出了合格英文。

**根因**：`validTranslationText` 对 `target: 'en'` 调 `looksEnglish`，后者在 `foreign === 0` 时要求
`detectLatinLanguage(text) === null`。`detectLatinLanguage` 用 `LATIN_HINTS` 给十种拉丁语言计分，
`me`、`no`、`de`、`la` 这类词同时在英文和西语里出现；`Help me … Let me …` 就让西语拿到 2 分 →
判成 `es` → 校验失败 → `translateItems` 抛 `502 empty`。客户端 `gateSend` 于是把消息一直扣着。

**修法**：计分时跳过 `ENGLISH_HINTS` 里的英文虚词；并要求最佳语言**严格多于**第二名，
一个命中或打平一律返回 `null`（当作「不是别的语言」）。`lib/index.js` 与 `lib/markdown.cjs` 同步。

**验证**：`tests/host.test.mjs` 新增 `英文译文里出现 me / no 这类共用词时不能判成西语`；
真实 API 探针四条全 200（中文→英、长句中文→英、英→西、中文夹标识符原样）。
**版本**：1.0.7。

## D23：首屏发送其实是中文——DOM 兜底从根上行不通（2026-11-18 上午）

**症状**（用户截图 + 口述）：新会话首屏输入「早上好！」，影子已经显示 `Good morning!`；
点发送 → 会话里发出去的是**中文**「早上好！」，不是英文。再点也没有改观。

**根因**（两处叠加）：

1. `composerBridge.actions` 只由 `conversation.composer.dock` 的 `LiveTranslationPanel`
   从 `props.inputActions` 写入。首屏没有这个插槽 → actions 永远是 null → 走 DOM 兜底。
2. DOM 兜底从设计上就不成立：`execCommand('insertText')` 只改 DOM 文本，
   而应用提交时读的是**它自己的 React state**（仍是中文）。于是「写英文 → 点发送」
   点的是中文草稿，发出去的就是中文。D21 记的修法（1.0.5/1.0.6）建立在这个错误假设上，
   所以首屏从来没真正发过英文——只有模拟测试因为不模拟 state 而一路 PASS。

**关键证据**：`/tmp/gate-order.cjs` 把应用建模成「submit 读自己的 state」后，
原版 1.0.8 在首屏路径输出 `submittedText="早上好！"`（复现用户截图），
改了喂 bridge 的方式后同一场景输出 `submittedText="Good morning!"`。

**修法**：

1. 新增 `captureInputActions(props)`；`SendToggle`（住在 `conversation.input.left`，
   **首屏就有**，且带 `inputActions`）与 `LiveTranslationPanel` 都往 `composerBridge.actions` 喂。
   voice-mode 的麦克风按钮就是从 `conversation.input.right` 这样拿到 actions 的，照抄这条既定契约。
2. `writeEditorText()` 写完**回读校验**，不再是 `execCommand` 返回 true 就当成功。
3. `heroFallbackBroken` 布尔量改成 `heroFallbackBrokenUntil`（带冷却），不再一次失败永久退化。
4. 拦截器不再吞自己合成的点击（`replayingSend`），也不接管 `isTrusted === false` 的点击。
5. 回归测试：`tests/send-path.cjs` 新增场景 1c（首屏工具行带 actions → 必须发英文、不发中文）。

**教训**：涉及受控组件的路径，**只能用模拟测试验证「事件有没有被吞」，不能验证「发出去的是什么」**——
后者取决于应用自己的 state。要验内容，必须把「应用从 state 提交」这件事建模进去。

## D25 — 插件市场发布走 release 分支（2026-11-18）

**决定**：market-index.json 的 git 源指向 `release` 分支的 orphan commit，不指向 master。

**理由**：pnpm 对 git 依赖**不应用** `package.json` 的 `files` 字段，这是 npm pack 才有的过滤。
指向 master 会把 `docs/`（含 `dsh-follow-patch.md`——记录如何给 vendor 的 `app.asar` 打补丁）、
`tests/`、`patch/`、`build.mjs` 一起装到用户机器上，3.4MB，且含不该外发的物料。
实测：master 克隆 3.4MB，release 分支克隆 484KB、8 个文件。

**为什么不选 npm**：需要账号和发布令牌；且 commit SHA 比 semver 版本更硬——npm 在 72 小时内
允许同版本重发，commit 无法被重指。代价是每次 master 改动都要重跑
`scripts/release-branch.mjs` 并重推 release（快照不会自动跟随）。

**实现**：`scripts/release-branch.mjs` —— 构建 → 跑 tests（必须「全部通过」）→ 组装 8 个运行时
文件 → 在临时仓库做 orphan commit → 把对象文件搬进当前仓库 objects/（`git fetch <工作仓库>`
不可用，对方不是上传端点）→ `update-ref refs/heads/release`。`--push` 才推远端。
脚本只写 `.release-spec.txt`，**不自动改 market-index.json**：构建是本地动作、可反复重跑，
改 index 是对外宣告版本，应单独提交。

**索引校验**：用 app.asar 里的真校验器 `@deepseek-ai/dsh-plugin-market-index`（需替换其
`import semver`），`parseMarketIndex` → `VALIDATED OK`，`marketInstallTarget` 产出
`git+https://...#<release-sha>`。

**图标**：release 分支不含 `docs/icon.png`，index 的 icon 指向 master 的 raw.githubusercontent
绝对 URL，否则装完看不到图标。

**流程说明**：`docs/release.md`。

## D24 视口自己往回跳：是 `flushSample` 把「跟随」关掉了（2026-11-18）

**现象**：对话进行中，视口自己往回跳几个来回；鼠标刚滚上去时也会。

**探测数据**（`lib/scroll-probe.template.js`，用户点了两次「滚动诊断」，334 条事件）：

```
intents: 182   (wheel 106 / pointerdown 26 / keydown 50)
tailFlips:
  seq 3    false -> true   kind scroll
  seq 22   true  -> false  kind intent type wheel
  seq 66   false -> true   kind scroll
  seq 77   true  -> false  kind tick          <-- 没有任何用户输入
  seq 265  false -> true   kind intent type wheel
maxGapAtIntent: 5705
```

**关键发现**：`seq 77` 那个 `true -> false` 的 `kind` 是 **`tick`**——不是滚轮、不是点击。
也就是说「跟随」是被**应用自己的采样定时器**关掉的，不是用户的阅读意图关掉的。
之前我给的「唯一关闭路径是 `interruptFollow`」的结论是**错的**：它只是其中一条路径。

**真正的代码路径**（`@deepseek-ai/dsh-client-ui-chat/lib/client.js`，解包在 `/tmp/asarx/chat.client.js`）：

```js
flushSample = () => {
  if (!this.pending) return
  this.cancelPending()
  const scroll = this.viewport.readScroll()
  if (scroll === null) return
  const followingTail = this.follow.sample(scroll.metrics, scroll.movedByReader)
  let position = null
  if (!scroll.movedByReader && followingTail) this.followTail()
  else { ...; this.publish({ initialized: true, followingTail, activeTurn }) }
  this.sampled?.(...)
}

sample(metrics, movedByReader = this.sampledTop === undefined || Math.abs(metrics.top - this.sampledTop) > .5) {
  this.sampledTop = metrics.top
  if (!this.animating && movedByReader) this.following = this.nearBottom(metrics)  // 只在「离底 <=25px」时才算跟随
  return this.active
}
```

`onScroll` 里：只要 `movedByReader` 为真且离底 ≥1px，就把 `this.sampleTimer ??= setTimeout(this.flushSample, 500)`；
500ms 后 `flushSample` 调 `sample()`，把 `following` **重算成 `nearBottom()` 的结果**——
内容还在流式增长时 `scrollTop` 几乎不动，于是 `movedByReader` 由**内容变高**（而非用户滚动）置真，
`nearBottom` 为假 → 跟随被关 → `publish({followingTail:false})` → 就是那个 `kind: tick` 的翻转。

**为什么 1.0.9 之前没这么明显**：`maxGapAtIntent: 5705` 说明用户确实在离底很远时滚过，
但即便如此，`nearBottom` 用的是**绝对 25px 阈值**，流式增长期间每一帧都可能越过它。

**修法方向**（未实施，需要用户确认）：
这是 shell 的行为（`dsh-client-ui-chat`），直接改会被升级覆盖。可选：
① 插件侧兜底：监听 `data-chat-following-tail` 消失 + 无用户意图 → 强制 `scrollTop = scrollHeight`（会抢用户滚动，风险高）；
② 提交上游 / patch shell，把 `flushSample` 的 `movedByReader` 判据改成「只认真实用户滚动」（`scrollend` 或 `wheel` 标记），
   并让 `nearBottom` 阈值随视口高度缩放而不是固定 25px；
③ 先只保留探测，继续观察。

**教训**：`maxGapAtIntent: 5705` 一开始让我以为是「用户滚远后跟随被关」，但 `tailFlips` 里
`kind: tick` 的那一条才是根因证据。**看聚合量会误导，必须看翻转点的 `kind`。**

## D26 — HTTP 路由没有访问检查：任意网页都能改写 baseURL（2026-11-19）

**发现途径**：不是自查出来的，是 awesome-dsh-plugin 的维护者 `fkysly` 在合并 PR #16677 时读代码发现的。
他把这句写进了条目描述（中英文各一句），并给了修法。这是我该在发布前自己抓到的缺陷。

**问题**：`lib/index.js` 的 `ctx.webServer.register` 路由从未调用 `ctx.connection.requestRejection(req)`，
而 DSH 正是靠它区分「已授权的浏览器会话」和「随便一个网页」。

**危害（比信息泄露严重）**：`POST /config` 接受 `baseURL`。攻击者只需两步：
1. 在你开着的任意网页里对 `http://127.0.0.1:<port>/api/shadow-bilingual/config` 发 `POST`，把 `baseURL` 改成自己的域名；
2. 等你下次翻译，插件就会把 **API Key** 发到那个域名。
另有 `POST /translate`、`POST /test` 可白嫖 Key 消耗，`GET /config` 泄露 `configPath` 绝对路径。

**已复现**：在 1.0.9 实跑上一个跨域 `POST /config`，`baseURL` 变成 `https://attacker.example.com` 且响应回显。
（复现后立刻改回 `https://api.deepseek.com` 并核对落盘配置。）

**修法（1.0.10）**：handler 里任何路由分发**之前**先过 `requestRejectionOf(ctx, req)`；`inject` 加 `connection`；
403 回 `FORBIDDEN`；`GET /health` 增加 `guard: true|false`，宿主没提供 `connection` 时自报降级，
避免「静默退回不设防」。

**验证**：`tests/guard.test.mjs` 四例；先移除 guard 验证过，两个安全用例在修复前失败、修复后通过
（不是「怎么改都绿」的假测试）。

**教训**：
1. 发布前除了验「功能对不对」，还要验「对外暴露面在不在宿主的权限模型里」。我此前只验了发送链路、
   槽位、翻译，从没问过「这些 HTTP 路由谁可以调」。
2. 修完必须**先证伪**：把修复拿掉，测试要能红。这次做到了，才敢说修好。
3. 复现漏洞时优先用**不起副作用的读**；本次因为线上跑的是旧代码、只能靠写接口复现，
   所以复现后必须立刻还原并核对落盘配置。

## D27 — 回复里冒出 `</ invoke> </ calls>`：不是插件产生的，但插件该藏（2026-11-19）

**现象**：用户多次截图，我的回复末尾渲出一行 `</ | DSML | invoke> </ | DSML | calls>`。

**定位（用会话 transcript 定量，不是猜）**：解压
`~/.dsh/sessions/.../session-701a694d.../session.v4.jsonl.zstd` 后统计：
- 14 处命中里，8 处是 assistant 文本块，**全部来自 `ollama-cloud/deepseek-v4.1-flash`**；
  另一个 provider `deepseek-account/deepseek-flash`（77 条消息）零命中。
- 4 处是「纯垃圾块」：`content` 只有一个 text 块，原文就是 `"\n</ invoke>\n</ calls>"`；
  其中一处还紧挨着一个**正常**的 tool-call（所以不是整轮坏掉，是多吐了一个块）。
- 另 4 处是我自己在正文/摘要里引用这串标签（讨论它），属正常文本。

**结论**：模型侧偶发的畸形输出，插件源码与构建产物里搜不到这些字串（`grep -r DSML lib/` 零命中）。

**修法（1.0.11）**：插件做**纯显示层**过滤，判据刻意窄 ——
`isControlArtifact(text)`：把控制标记与 `[\s|`]` 全部去掉后**必须为空**才丢块。
只要剩一个正常字符就原样保留，所以「讨论这串标签」的正文不会被吞。
正则 `CONTROL_ARTIFACT_TAGS = /<\s*\/?\s*(?:[\w.-]*\s*\|\s*)*[\w.:-]*\s*>/gi`
—— 前缀段允许为空名（`</ | DSML | invoke>` 的首段是裸 `|`），这一条是踩过两次才对的。

**验证（这次没有假绿）**：`tests/control-artifact.test.mjs` 4 个用例，其中第 4 个
**断言渲染分支里确实调用了 `isControlArtifact`**。把调用点删掉，前 3 个纯函数用例照样全绿，
只有第 4 个会红 —— 这就是防「假绿」的那道锁。实测：删调用点 → `pass 3 / fail 1`；
恢复 → `pass 4 / fail 0`。

**教训**：
1. 纯函数测得好 ≠ 接进了产品。凡是「加一个过滤器/守卫」的修复，必须有一条测试盯**调用点**。
2. 正则里「可选前缀」很容易写成只有一段；`</ | DSML | invoke>` 这种带裸管道的形式要单独验。
3. 用户的抱怨里如果夹着一个我以为是「生成侧噪声」的东西，也要把它查成定量事实
   （哪个 provider、几条、是纯垃圾还是引用），否则会一直复现。
