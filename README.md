# Shadow Bilingual

个人使用的 DSH 插件：**对话全英文 + 界面双语**。

从 [Hemuchuan/dsh-bilingual](https://github.com/Hemuchuan/dsh-bilingual) fork 后改造的个人版，
仅本机使用。上游的助手双语渲染沿用，其余为本地定制。

## 它做什么

| 能力 | 位置 | 状态 |
| --- | --- | --- |
| 助手回复：英文正文 + 下方中文对照 | `conversation.chat.node` (key `assistant-step`) | 沿用上游 |
| 用户消息：发送的是英文，气泡内下方显示中文原文 | `conversation.user.text.node` (key `text`) | 本定制新增 |
| 「发送译文」勾选框，默认勾选 | `conversation.composer.dock` | 本定制新增 |
| 插话框（dsh-steer-note）里打中文也译成英文再发 | `textarea.dsh-steer-note-input` | 本定制新增 |
| 排队中的消息（我干活时你发的）就地译成英文 | `conversation.input.dock` id `shadow-bilingual-queue` | 本定制新增 |
| 模型始终用英文回复 | 系统提示词 section `bilingual:response-language` (order 9500) | 本定制新增 |

## 关键实现（改之前先读这段）

- **用户消息的中文原文怎么来的**：发出前拦截器把 `英文 → 中文原文` 记进 localStorage
  (`shadow-bilingual.sent.v1`，上限 200 条，键是空白归一化后的英文全文)。
  渲染时用消息正文去查这张表；查不到就退回译文缓存里**确实是中文**的条目。
  查不到就不显示 ZH 行——不会编造。
- **为什么不用 `conversation.chat.user.before`**：实测该 chain 槽位拿到的 `source`
  只有 `{kind, rpcId, clientTimeZone}`，没有正文（见 `docs/PLAN.md` 记录）。
- **为什么不用 `conversation.chat.user.content`**：它是单例 Factory，外部重复注册
  不报错但也不会被选中（实测）。只有 **keyed** 槽位能稳定接管。
- **发送拦截**：`document` 捕获阶段监听 `keydown Enter` 与 `click` 发送按钮，
  命中后 `preventDefault` → 翻译 → `inputActions.setDraft(english)` → `inputActions.submit()`。
  跳过 Shift/Alt、IME 组合态 (`isComposing` / `keyCode 229`)。
- **插话框是第二套输入**（`dsh-steer-note` 插件的 `textarea.dsh-steer-note-input`），
  和主输入框完全无关，走的是 `sessionRemote.prompt({mode:'steer'})`。
  它是**受控 React 组件**，`send()` 读的是 `latestTextRef`（state），不是 DOM——
  所以必须用原生 setter + `input` 事件让 React 更新，等一帧再点它的按钮。
  只改 DOM 文本是没用的。

- **三条发送路径都要管**（缺一条就会漏中文）：

  | 路径 | 入口 | 送达时机 | 怎么拦 |
  | --- | --- | --- | --- |
  | 主输入框 | composer | 我空闲时立刻 | 影子译文预览 → 点发送时提交译文 |
  | 插话框 | `dsh-steer-note` 的 textarea | 当前 step 结束 | 改 value + input 事件 → 点它自己的按钮 |
  | 消息队列 | DSH 官方 inbox `next-turn` | 整轮结束后作为下一轮 | `useProjection('inbox')` + `updateQueue({kind:'edit'})` |

  队列这条**不经过任何输入框**：我在干活时你发的消息进的是官方 inbox，
  主拦截器根本看不到它。之前队列里的中文就是这样漏出去的。

- **影子译文在输入框里**：你打字停下 900ms 后，草稿正文下面会直接出现灰色的英文续写。
  它按段落做 diff，已经翻过的段直接命中缓存，只把新出现的段落发出去——不是每次整段重译。
  重译时上一版译文不会消失，只是淡化并标注「更新中…」，所以看不到闪烁。
- **译文没出来之前发不出去**。这时点发送，面板会显示「正在翻译…（翻译完成后发送）」，
  事件被吞掉、不会提交；译文一就绪就**自动替你发出去**，不需要再点一次。
  这是为了避免「中文先发、英文再发」的双发。
- **翻译失败或卡住不算数**：失败立刻退回、原文照发；卡住 15 秒后同样退回。
  宁可发中文，也不把你锁死在输入框前。
- **排队消息只处理纯文本行**：带图片/文件的行跳过（改 content 会丢附件）。
  这类消息会以中文送达，是有意的取舍。

## 已知边界（不是 bug，是设计取舍）

- **只拦截「人经这三条路径发出的字」**。
  由界面或宿主自己产生的消息（"继续"这类续跑、重试）不经过以上任何路径，仍会以原文发出。
- 纯英文草稿不翻译、不替换。
- 单段超过 5000 字符的草稿跳过翻译（避免一次请求过大）。
- 翻译失败时**原样发送**，不会卡住发送（插话框同样：翻译失败就点它自己的按钮原样发）。
- 助手侧英文正文 + 中文对照是上游行为，已按你的要求保留。

## 配置

- 宿主配置：`~/.dsh/shadow-bilingual.json`（API Key / 模型 / Base URL / `forceEnglish`）
- Key 优先级：插件配置 > `DEEPSEEK_API_KEY` 环境变量 > DSH 凭据服务
- 路由：`/api/shadow-bilingual/{config,translate,test,health}`
- 设置页：设置 → 双语

## 构建与安装

```bash
cd /Users/naskita/Documents/deepseek-harness/default-workspace/shadow-bilingual
node build.mjs     # lib/markdown.cjs + lib/client.template.js → lib/client.js
```

安装（改完 `lib/client.js` 后客户端通常会自动热加载，宿主侧改动需要重装）：

```
plugin_manager install_bundle target=/Users/naskita/Documents/deepseek-harness/default-workspace/shadow-bilingual
```

## 自检

两个不碰界面的脚本，改完 bundle 先跑它们，比在界面上试错快：

```bash
node /tmp/list-slots.cjs lib/client.js                      # 打印注册的全部槽位与监听器
node /tmp/test-send-path.cjs lib/client.js                  # 23 项发送链路断言
```

`test-send-path.cjs` 覆盖：单次 Enter 只提交一次、翻译在飞时连按不重复、翻译失败发原文、
翻译挂起超时发原文、超时后锁已释放、队列中文行被译成英文、带附件行不动、
队列翻译失败保留原文、同一行不重复翻译、document 监听器唯一。

界面上没有 devtools，验证靠无障碍树：

```bash
agent-desktop snapshot --window-id <DSH 窗口 id> --timeout-ms 25000
```
