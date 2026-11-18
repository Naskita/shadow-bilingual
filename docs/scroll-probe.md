# 滚动回跳探测（临时诊断，用完即删）

## 怎么用

1. 重启 DeepSeek Harness（host 半不会热重载），刷新页面。
2. 会话头「影译 v1.0.9 ON」右边会出现一个橙色虚线小按钮 **「滚动诊断」**（只有探测构建才有）。
3. 正常跑一段长对话，等它自己往回跳一次，然后**点一下「滚动诊断」**——摘要会复制到剪贴板，粘给我。
4. 多点几次没关系，每次都是累积计数。

没有按钮 = 装的是正式构建（不含探测）。
备用路径（需要 DevTools）：`copy(__SBP_SCROLL_SUMMARY())`；原始序列 `copy(__SBP_SCROLL_DUMP())`；清零 `__SBP_SCROLL_RESET__()`。

## 记了什么

| 字段 | 含义 |
| --- | --- |
| `intents` / `intentsByType` | 有多少次会**关掉尾随**的「阅读意图」事件：`wheel` / `touchstart` / `pointerdown` / `keydown`（只算方向键、PageUp/Down、Home/End、空格）/ `beforematch` |
| `tailFlips` | `data-chat-following-tail` 这个属性的翻转点——`false` 就是「不再跟随到底」 |
| `maxGapAtIntent` | 发生阅读意图时离底部的距离（px） |
| `m.gap` | 每次采样时离底多少 px |
| `anchor.overflowAnchor` | 当前 `overflow-anchor` 计算值（`none` = 浏览器原生锚定已被关掉） |
| `scrollers` | 命中的滚动容器个数 |

## 判读方法

- **`tailFlips` 里出现 `to:false` 的那个 `kind: intent`** → 就是它锁掉的，`type` 会告诉你是滚轮、点击还是键盘。
- 如果 `tailFlips` 全是 `intent` 触发，但 `overflowAnchor` 一直是 `none`，说明不是浏览器原生 scroll-anchoring 打架，而是 shell 自己的尾随锁被关掉后没有恢复。
- 如果 `gap` 在**没有 intent** 的情况下自己变大 → 说明是内容增长 / ResizeObserver / spacer 回收的问题，方向完全不同，需要再查 `onResize` 那条路径。

## 为什么探测不会影响插件本体

整个探测包在 `try/catch` 里，任何异常只 `console.warn`，不改插件行为、不加 DOM 节点。
构建时才注入：`SBP_SCROLL_PROBE=1 node build.mjs`；**发布构建默认不含它**。
