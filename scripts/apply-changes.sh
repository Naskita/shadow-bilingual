#!/bin/bash
# 让改动生效——安全版。
#
# 做三件事：
#   1. 重建客户端 bundle（lib/markdown.cjs + lib/client.template.js → lib/client.js）
#   2. 可选跑一遍自检（--test）
#   3. 读运行中宿主的 /health，报告「宿主那一半是不是还在跑旧代码」
#
# 不做的一件事（最重要）：**绝不向 DSH / Electron / 宿主进程发任何信号。**
# 宿主半过期时只打印「请正常退出（⌘Q）再重开」，由人来按。
# 原因见 docs/PLAN.md「事故复盘」：kill / SIGTERM 宿主会被 Electron 判成
# 「应用无法启动或已意外停止」，2026-11-17 的崩溃循环就是这么来的。
# 本仓库不再提供任何杀宿主进程的脚本。
#
# 用法：
#   ./scripts/apply-changes.sh            # 重建 + 报告
#   ./scripts/apply-changes.sh --test     # 重建 + tests/run-all.sh + 报告
#
# Agent 可以直接看退出码决定下一步：
#   0 = 客户端已重建，宿主也是当前代码（或未运行），无需人介入
#   2 = 宿主半已过期：需要人正常退出（⌘Q）并重开应用
#   1 = 构建或自检失败

set -u
cd "$(dirname "$0")/.." || exit 1

run_tests=0
for arg in "$@"; do
  case "$arg" in
    --test) run_tests=1 ;;
    -h | --help)
      sed -n '2,26p' "$0"
      exit 0
      ;;
    *)
      echo "未知参数：$arg（可用：--test、--help）" >&2
      exit 1
      ;;
  esac
done

# 宿主当前代码的标记：lib/index.js 里 /health 回报的 logic 值。
expected_logic="$(grep -m1 "logic: '" lib/index.js 2>/dev/null | sed "s/.*logic: '\([^']*\)'.*/\1/")"
[ -n "${expected_logic:-}" ] || expected_logic="unknown"

if [ "$run_tests" -eq 1 ]; then
  echo '== build + self-check =='
  bash tests/run-all.sh || exit 1
else
  echo '== build =='
  node build.mjs || exit 1
fi

echo
echo 'CLIENT=rebuilt lib/client.js (hot-reloads into the open window; press ⌘R if it does not)'

# 找宿主进程：pgrep -f 在本机匹配不到（命令行过长且路径含空格），只能用 ps + grep。
host_pid="$(ps ax -o pid=,command= 2>/dev/null \
  | grep 'dsh-desktop-host/lib/index.js' \
  | grep -v 'grep' \
  | awk '{ print $1 }' \
  | head -1)"

if [ -z "$host_pid" ]; then
  echo 'HOST=not-running'
  echo 'ACTION=open-app (启动时会直接加载当前代码)'
  exit 0
fi

echo "HOST=running pid=$host_pid"

# 端口每次启动都会变（历史值 55443 / 65285 / 51055 / 54323），逐个试监听端口。
ports="$(lsof -nP -iTCP -sTCP:LISTEN -a -p "$host_pid" 2>/dev/null \
  | awk 'NR>1 { n = split($9, a, ":"); print a[n] }' \
  | sort -u)"

live_port=""
live_logic=""
for port in $ports; do
  body="$(curl -s --max-time 2 "http://127.0.0.1:$port/api/shadow-bilingual/health" 2>/dev/null)"
  case "$body" in
    *'"ok":true'*)
      live_port="$port"
      live_logic="$(printf '%s' "$body" | sed -n 's/.*"logic":"\([^"]*\)".*/\1/p')"
      break
      ;;
  esac
done

if [ -z "$live_port" ]; then
  echo 'HOST_ROUTE=not-answering (插件可能没在这个 profile 的 bundle 清单里，或还没挂载)'
  echo 'ACTION=enable-bundle (plugin_manager set_bundle target=shadow-bilingual enabled=true；客户端已重建)'
  exit 0
fi

echo "HOST_PORT=$live_port"
echo "HOST_LOGIC=live:${live_logic:-none} expected:$expected_logic"

if [ "$live_logic" = "$expected_logic" ]; then
  echo 'ACTION=none (宿主这一半已经在跑当前代码)'
  exit 0
fi

cat <<'EOS'

宿主半（lib/index.js）在这台应用启动之后改过，而 DSH 不会因为
`plugin_manager set_bundle` / 重装就重新 import 被 symlink 的宿主模块（实测，见
docs/PLAN.md D10）。唯一安全的方式是正常退出再重开：

  1. 你自己退出应用：⌘Q（或菜单 → 退出）
  2. 从「应用程序」重新打开

本脚本不会替你做，也不会发任何信号：kill 宿主会让 Electron 报
"app stopped unexpectedly" 并弹崩溃窗——那正是 2026-11-17 反复重启的原因。
EOS
echo 'ACTION=quit-and-reopen'
exit 2
