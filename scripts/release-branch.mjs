#!/usr/bin/env node
// 把「发布用」的运行时文件单独提交到 release 分支（orphan，不带开发历史）。
//
// 为什么需要：market-index.json 的 git 源用 pnpm 安装，pnpm 对 git 依赖不应用
// package.json 的 files 字段。若把 master 的 commit 填进 index，用户机器上会多出
// docs/（含 app.asar 补丁日志）、tests/、patch/、build.mjs 等开发文件共约 3.4MB。
// 因此发布指向 release 分支上只含运行时文件的 commit。
//
// 用法：
//   node scripts/release-branch.mjs            # 构建 + 校验 + 写 release 分支（不 push）
//   node scripts/release-branch.mjs --push     # 同上并 push release 分支
//
// 前置：master 工作区干净、npm test 通过（脚本会自己跑 tests）。

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const BRANCH = 'release'
const PUSH = process.argv.includes('--push')

/** 发布分支只放这些顶层条目；与 package.json 的 files 保持一致。 */
const RUNTIME = ['lib/client.js', 'lib/index.js', 'lib/markdown.cjs', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE']

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: opts.quiet ? 'pipe' : 'inherit', ...opts })
}

function fail(message) {
  console.error(`\n[release] ${message}`)
  process.exit(1)
}

// 1. 前置检查：工作区必须干净，否则发布内容与 master 不一致
const dirty = run('git', ['status', '--porcelain', '--untracked-files=no'], { quiet: true }).trim()
if (dirty !== '') fail(`工作区有未提交改动，先提交再发布：\n${dirty}`)

// 2. 构建并测试。发布分支上的 lib/client.js 必须来自当前源码
console.log('[release] 构建…')
run('node', ['build.mjs'])
console.log('[release] 测试…')
const testOutput = run('bash', ['tests/run-all.sh'], { quiet: true })
if (!testOutput.includes('全部通过')) fail(`测试未全部通过：\n${testOutput.slice(-2000)}`)

const buildDirty = run('git', ['status', '--porcelain', '--untracked-files=no'], { quiet: true }).trim()
if (buildDirty !== '') fail(`构建产出了未提交的改动，先提交再发布：\n${buildDirty}`)

// 3. 在临时目录里组装发布内容
const staging = join(tmpdir(), `sbp-release-${process.pid}`)
rmSync(staging, { recursive: true, force: true })
mkdirSync(join(staging, 'lib'), { recursive: true })

for (const rel of RUNTIME) {
  const from = join(ROOT, rel)
  if (!existsSync(from)) fail(`缺少发布文件：${rel}`)
  cpSync(from, join(staging, rel))
}

// package.json 需要精简：去掉只对开发有意义的字段，保留宿主读取的全部契约字段
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
delete pkg.scripts
pkg.files = RUNTIME
writeFileSync(join(staging, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)

// 4. 把发布内容写成一个 orphan commit（不带 master 的开发历史）
const work = join(tmpdir(), `sbp-release-work-${process.pid}`)
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
run('git', ['-C', work, 'init', '--quiet', '--initial-branch', BRANCH])
run('git', ['-C', work, 'config', 'user.name', run('git', ['config', 'user.name'], { quiet: true }).trim() || 'release'])
run('git', ['-C', work, 'config', 'user.email', run('git', ['config', 'user.email'], { quiet: true }).trim() || 'release@local'])

cpSync(staging, work, { recursive: true })
run('git', ['-C', work, 'add', '-A'])
run('git', ['-C', work, 'commit', '--quiet', '-m', `release: ${pkg.name}@${pkg.version}（仅运行时，可被插件市场安装）`])
const commit = run('git', ['-C', work, 'rev-parse', 'HEAD'], { quiet: true }).trim()

// 5. 校验：发布内容里不能出现开发文件
const tracked = run('git', ['-C', work, 'ls-files'], { quiet: true }).trim().split('\n')
const forbidden = tracked.filter((f) => /^(docs|tests|patch|scripts)\//.test(f) || f === 'build.mjs' || f === 'install.mjs')
if (forbidden.length > 0) fail(`发布内容混进了开发文件：\n${forbidden.join('\n')}`)

console.log(`\n[release] 提交 ${commit}`)
console.log(`[release] 文件 ${tracked.length} 个：\n  ${tracked.join('\n  ')}`)

// 6. 把临时仓库的 commit 对象搬进当前仓库，并把 release 分支指过去。
//    git fetch <path> 要求对方是上传端点（bare 或开 uploadpack），普通工作仓库不行，
//    所以直接把对象文件拷进当前仓库的 objects/，再写 ref。
const objectsOut = run('git', ['-C', work, 'rev-list', '--objects', '--all'], { quiet: true })
const shas = new Set()
for (const line of objectsOut.trim().split('\n')) {
  const sha = line.split(' ')[0]
  if (sha) shas.add(sha)
}
const commonDir = run('git', ['rev-parse', '--git-common-dir'], { quiet: true }).trim()
const objectsDir = join(ROOT, commonDir.replace(/^\.\//, ''), 'objects')
for (const sha of shas) {
  const src = join(work, '.git', 'objects', sha.slice(0, 2), sha.slice(2))
  if (!existsSync(src)) continue
  const destDir = join(objectsDir, sha.slice(0, 2))
  mkdirSync(destDir, { recursive: true })
  const dest = join(destDir, sha.slice(2))
  if (!existsSync(dest)) cpSync(src, dest)
}
// 确认每个对象都可读，缺一个就明确报错，而不是让 update-ref 抛个没上下文的 fatal
for (const sha of shas) {
  try {
    run('git', ['cat-file', '-e', sha], { quiet: true })
  } catch {
    fail(`对象 ${sha} 没能搬进仓库（${objectsDir}）`)
  }
}
run('git', ['update-ref', `refs/heads/${BRANCH}`, commit])

rmSync(staging, { recursive: true, force: true })
rmSync(work, { recursive: true, force: true })

if (PUSH) {
  console.log('[release] push…')
  run('git', ['push', '--force', 'origin', `${commit}:refs/heads/${BRANCH}`])
}

const spec = `git+https://github.com/Naskita/shadow-bilingual.git#${commit}`
writeFileSync(join(ROOT, '.release-spec.txt'), `${spec}\n`)
console.log(`\n[release] 安装目标：\n  ${spec}`)
console.log('[release] 已写入 .release-spec.txt；把它填进 market-index.json 的 versions[0].source.commit')
