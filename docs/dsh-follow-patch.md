# 给 DeepSeek Harness 打「视口回跳」补丁：工作日志

> 这份文档是为了**应用升级后能再打一遍**而写的。升级会覆盖 `app.asar`，补丁随之消失。
> 每次升级后照第 3 节做一遍即可（通常只需要 `--dry-run` 确认，再正式跑）。

---

## 1. 这个补丁修什么

**现象**：对话进行中，视口自己往回跳；流式回复越长越明显。

**根因**（有实测证据，见 `docs/PLAN.md` D24）：

流式回复时内容不断变高、`scrollTop` 几乎不动。`@deepseek-ai/dsh-client-ui-chat`
的 `ChatReading.flushSample()` 每 500ms 调一次
`follow.sample(metrics, movedByReader)`，而 `sample()` 里这一行：

```js
if (!this.animating && movedByReader) this.following = this.nearBottom(metrics)
```

把「是否跟随到底」重算成 `nearBottom()` —— 而 `nearBottom` 是
`Math.abs(floor - top) <= threshold`，阈值来自
`useScrollFollow(state.followingTail, 25)`，**固定 25px**。

于是：用户在离底 25px 以外时，只要内容一长就被判成「不跟随了」，
视图停在原地而内容继续往下长 —— 看起来就是「自己往回跳」。
探测数据里 `tailFlips` 那条 `kind:"tick"` 的 `true→false` 就是它（没有任何用户输入）。

**两处改动**：

1. `sample()`：区分「用户真的滚了」和「内容变高造成的假移动」。
   内容高度变大、而 `scrollTop` 变化不足 1px ⇒ 不算用户移动，保留原 `following`。
2. `nearBottom` 阈值：固定 25px → `clamp(innerHeight * 6%, 25, 120)`。

---

## 2. 文件位置

| 项 | 路径 |
| --- | --- |
| 被改的 asar | `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` |
| 被改的文件（asar 内逻辑路径） | `/dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js` |
| 补丁脚本 | `shadow-bilingual/patch/follow-patch.mjs` |
| asar 读写工具 | `shadow-bilingual/patch/asar-tool.mjs` |
| 备份 | `app.asar.orig-<毫秒时间戳>`（脚本自动生成） |

---

## 3. 升级后怎么再打

```bash
cd ~/Documents/deepseek-harness/default-workspace/shadow-bilingual

# 1) 先看能不能匹配（不改任何文件）
node patch/follow-patch.mjs --dry-run

# 2) 能匹配就正式打（自动备份）
node patch/follow-patch.mjs

# 3) 重启 DeepSeek Harness 才生效（Electron 启动时读 asar）
```

三种输出：

- `已经是打过补丁的状态，跳过。` → 不用管。
- `dry-run：两个锚点都命中` → 安全，正式跑。
- `[sample 锚点没找到]` / `[threshold 锚点没找到]` → 走第 4 节。

**回滚**：

```bash
cp "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.orig-<时间戳>" \
   "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar"
```

---

## 4. 升级后重新定位（应用改了这段代码时）

锚点失效说明 DeepSeek 改了这两处代码。重新取原文的方法：

```bash
cd ~/Documents/deepseek-harness/default-workspace/shadow-bilingual
node patch/follow-patch.mjs --extract
# 目标文件被导出到 patch/_extracted/chat.client.js
```

然后在新导出的文件里搜：

```bash
grep -o "sample(metrics,movedByReader=[^}]*}[^}]*}[^}]*}" patch/_extracted/chat.client.js
grep -o "useScrollFollow(state.followingTail,[0-9]*)" patch/_extracted/chat.client.js
```

拿到新的原文后，改 `patch/follow-patch.mjs` 顶部的 `OLD_SAMPLE` / `OLD_THRESHOLD`，
以及对应的 `NEW_*`（在原文基础上套用同样的两条改动），再 `--dry-run` 验证。

**注意**：`NEW_SAMPLE` 依赖 `metrics.height` 字段存在。如果新版本的 `metrics()`
不再返回 `height`，`contentGrew` 会恒为 false，补丁退化成「和以前一样」——不会更糟，
但也没修好。这时要改用别的判据（例如对比 `scrollHeight` 或监听真实 `wheel` 事件）。

---

## 5. 已知限制

- 改的是**应用内文件**，任何 `app` 更新（含自动更新）都会覆盖，需要重打。
- 打完后 `app.asar` 的 SHA-256 与官方不一致；如果应用或系统校验完整性，可能报错或拒绝启动。
  回滚即可恢复。
- 这是**绕过**，不是上游修复。真正该改的是 DeepSeek 自己的
  `flushSample` / `nearBottom`（把「内容变高」和「用户滚动」分开）。条件允许时应上报。
- 补丁只影响 `dsh-client-ui-chat` 一个 bundle，不动 host 侧、不动插件。

---

## 6. 改动记录

| 日期 | 应用版本 | 结果 | 备注 |
| --- | --- | --- | --- |
| 2026-11-18 | 2026-11-13 构建（Electron，arm64，TeamID NAN929V4UM） | `--dry-run` 通过 | 首次打补丁；目标文件 498405 字节，改后 498853 字节（+448） |
