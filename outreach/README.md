# awesome-dsh-plugin 投稿材料

提交到 https://github.com/awesome-dsh-plugin/awesome-dsh-plugin 的条目。

## 要提交什么

一个文件 + 重新生成的 README：

```
data/plugins/Naskita__shadow-bilingual.yml   (新增)
README.md                                     (node scripts/generate-readme.mjs)
README.zh.md                                  (同上)
```

`Naskita__shadow-bilingual.yml` 就在本目录，直接拷进 `data/plugins/`。

## 已在本机验证过（2026-11-18）

在 awesome-dsh-plugin 的真实克隆上跑过它的校验：

| 检查 | 结果 |
|---|---|
| `validateEntries()`（11745 条全量） | 我的条目 0 问题 |
| `node scripts/generate-readme.mjs --check` | README.md / README.zh.md up to date |
| js-yaml 解析 | 5 个字段，`: ` 在引号内 |
| `dsh.bundle` 声明 | 有（`{"patch":"./cordis.patch.yml"}`） |
| 仓库年龄 | 创建 2026-11-17T09:31:21Z，已 1.2 天（门槛 1 天） |
| `dsh-plugin` topic | 已加 |
| icon | PNG 512×512，raw.githubusercontent/master 返回 200 image/png |
| screenshots.json | 已存在，2 张图均 200 |

## 提交步骤

```bash
# fork 后
git clone https://github.com/<you>/awesome-dsh-plugin.git
cd awesome-dsh-plugin
cp <本目录>/Naskita__shadow-bilingual.yml data/plugins/
npm ci
node scripts/generate-readme.mjs
git add data/plugins/Naskita__shadow-bilingual.yml README.md README.zh.md
git commit -m "Add Naskita/shadow-bilingual"
git push
```

然后开 PR。CI 的 Submission gate 会自己跑（需要仓库 owner 有 GITHUB_TOKEN 的 workflow_run，不用你处理）。

## 描述里的数字都可核

- 「composer draft, steering box and message queue」三条路径：
  `lib/client.template.js:1707`（`gateSend('steer', …)`）、`:2195`/`:2231`（`gateSend('composer', …)`）、
  `:2296` 起的「队列翻译」模块（无渲染组件，盯 inbox 队列就地翻译）。
- 「18 display languages」：`lib/client.template.js` 的 `LANGUAGES` 数组，
  实测 `zh, zh-TW, ja, ko, es, fr, de, pt, ru, it, nl, pl, tr, ar, hi, th, vi, id` = 18 条。

## 备注

- 分类选 `ui`（显示侧改造）；`usage` 更偏用量面板，`tools` 是工具类，都不如 `ui` 贴。
- 条目不含 `tarball:`——仓库能从源码安装（`dsh plugin add` 走 git）。
- 没有发 npm 包；这不影响收录。

## 已提交（2026-11-18）

- PR：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/16677
- 分支：`Naskita:add-shadow-bilingual`（base `main`）
- 改动：3 个文件 +9 行（条目 yml 7 行 + 两个 README 各 1 行）
- 状态：`MERGEABLE`，Submission gate 排队中

后续若被打回，反馈会以 PR 评论给出；在**同一分支**推送修复即可，不需要重开 PR。
被要求修改时会打 `held: author` 标签——那不是拒绝，是暂停等待重读。
