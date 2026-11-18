# 发布（release 分支）

market-index.json 里的 git 源用 pnpm 安装。**pnpm 对 git 依赖不应用 `package.json` 的
`files` 字段**，所以如果把 `master` 的 commit 填进 index，用户机器上会多出 `docs/`
（含把 vendor `app.asar` 打补丁的工作日志）、`tests/`、`patch/`、`build.mjs` 等开发文件，
共约 3.4MB。

因此发布指向 **`release` 分支**上一个只含运行时文件的 orphan commit。

## 发布什么

8 个文件，与 `package.json` 的 `files` 一致：

```
package.json  cordis.patch.yml  README.md  CHANGELOG.md  LICENSE
lib/client.js  lib/index.js  lib/markdown.cjs
```

`package.json` 在发布分支上去掉 `scripts`（构建/测试脚本不随包发布）。

## 流程

```bash
cd ~/Documents/deepseek-harness/default-workspace/shadow-bilingual

# 1. 先在 master 上把改动提交干净（脚本会拒绝脏工作区）
git status --short

# 2. 构建 release 分支（构建 → 跑 tests → 组装 → orphan commit → 本地 refs/heads/release）
node scripts/release-branch.mjs

# 3. 它会把安装目标写进 .release-spec.txt，形如
#    git+https://github.com/Naskita/shadow-bilingual.git#<sha>

# 4. 把这个 sha 填进 market-index.json 的 plugins[0].versions[0].source.commit
#    （脚本不会自动改 index，避免把「发布」和「改索引」耦合成一次不可分的动作）

# 5. 推
git push origin master
git push origin release
```

## 为什么脚本不直接改 market-index.json

改 index 等于对外宣告一个新版本。构建是本地动作、可以随便重跑；改 index 是发布动作，
应当是一次明确的、单独提交的改动。分开之后，脚本可以在不推送任何东西的前提下反复运行。

## 校验

index 必须能被 app 自带的真校验器接受。校验器在
`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 内的
`@deepseek-ai/dsh-plugin-market-index/lib/index.js`；它 `import semver`，直接跑需要先替换那个
import（`rcompare` 用 `localeCompare(...,{numeric:true})` 反序、`validRange` 原样返回即可）。

```bash
# 解出校验器后
node -e "
import('/tmp/validator/index.mjs').then(m=>{
  const raw=JSON.parse(require('fs').readFileSync('market-index.json','utf8'));
  const url='https://raw.githubusercontent.com/Naskita/shadow-bilingual/master/market-index.json';
  const ok=m.parseMarketIndex(raw,url);
  console.log('VALIDATED OK');
  console.log(JSON.stringify(m.marketInstallTarget(ok.plugins[0].name, ok.plugins[0].versions[0])));
});
"
```

## 已知限制

- **`release` 分支是快照，不会自动跟随 master。** master 上任何改动都要重跑脚本并重新推
  `release`，否则 index 指向的还是旧代码。`scripts/release-branch.mjs` 会先跑构建和 tests，
  所以推出去的快照至少是通过测试的。
- **图标不在 release 分支里。** index 的 `icon` 指向 `master` 上的
  `docs/icon.png`（raw.githubusercontent 绝对 URL），否则装完的用户看不到图标。
- **推 release 用 `--force`**（脚本 `--push` 会带），因为每次都是全新的 orphan commit。
