#!/bin/bash
# 延迟重启 DSH，让旧插件 dsh-bilingual-en 彻底退场、shadow-bilingual 独占加载。
#
# 为什么必须重启而不是重载：
#   profile 已经从 package.json 里摘掉了 dsh-bilingual-en，但启动时挂上去的那个实例
#   仍留在宿主进程里，且因为不在 bundle 清单中而**无法被 plugin_manager 寻址**。
#   实测后果有三条：
#     - /api/dsh-bilingual-en/* 仍在应答
#     - 界面上出现两个「发送译文」复选框（新旧两套客户端 bundle 各注册一个
#       conversation.composer.dock）
#     - 新旧两套 Enter 拦截器并存，可能重复提交
#
# 为什么要延迟：调用它的 agent 自己就跑在这个进程里，立刻重启会把还没说完的话截断。
#   先 sleep，让调用方把话说完再动手。
#
# 用法（必须脱离进程组，否则会跟着应用一起被杀）：
#   setsid nohup restart-dsh.sh 30 >/tmp/shadow-restart.log 2>&1 &
#
# 结果写进 /tmp/shadow-restart-report.json，重启后可以直接读。

set -u
WAIT="${1:-30}"
REPORT=/tmp/shadow-restart-report.json
APP="/Applications/DeepSeek Harness.app"
# 端口每次启动都可能变（历史值见过 55443 / 65285），所以不写死：
# 从宿主进程实际监听的 TCP 端口里认。
# 注意：pgrep -f 在这台机器上匹配不到宿主（命令行超过 pgrep 的匹配长度，
# 且路径里带空格）。实测唯一可靠的是 ps + grep。
find_host_pid() {
  ps ax -o pid=,command= 2>/dev/null \
    | grep 'dsh-desktop-host/lib/index.js' \
    | grep -v 'grep' \
    | awk '{ print $1 }' \
    | head -1
}

detect_port() {
  local pid="$1"
  [ -n "$pid" ] || return 1
  lsof -nP -iTCP -sTCP:LISTEN -a -p "$pid" 2>/dev/null \
    | awk 'NR>1 { n=split($9, a, ":"); print a[n] }' \
    | sort -u | head -1
}

sleep "$WAIT"

probe() {  # $1 = path -> 打印 HTTP 状态码
  [ -n "${URL:-}" ] || { echo 000; return; }
  curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$URL$1" 2>/dev/null || echo 000
}

OLD_PID="$(find_host_pid)"
URL=""

# 1) 先请应用正常退出，让它把会话落盘
osascript -e 'quit app "DeepSeek Harness"' >/dev/null 2>&1

for _ in $(seq 1 20); do
  sleep 1
  [ -n "$(find_host_pid)" ] || break
done

# 2) 还没退干净就强杀宿主
if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
  kill "$OLD_PID" 2>/dev/null
  sleep 3
fi

# 3) 重新打开
open -a "$APP" >/dev/null 2>&1

# 4) 等宿主起来，自动认出端口，再探两条路由
NEW=000
NEW_PID=""
PORT=""
for _ in $(seq 1 60); do
  sleep 2
  NEW_PID="$(find_host_pid)"
  [ -n "$NEW_PID" ] || continue
  PORT="$(detect_port "$NEW_PID")"
  [ -n "$PORT" ] || continue
  URL="http://127.0.0.1:$PORT"
  NEW="$(probe /api/shadow-bilingual/health)"
  [ "$NEW" = "200" ] && break
done

OLD="$(probe /api/dsh-bilingual-en/health)"
# 新宿主代码的标志：/config 里必须出现 localLanguage
HAS_LANG="$(curl -s --max-time 3 "$URL/api/shadow-bilingual/config" 2>/dev/null \
  | grep -c '"localLanguage"')"

printf '{"at":"%s","oldHostPid":"%s","newHostPid":"%s","port":"%s","newRouteHttp":"%s","oldRouteHttp":"%s","hasLocalLanguage":%s}\n' \
  "$(date -u +%FT%TZ)" "$OLD_PID" "$NEW_PID" "$PORT" "$NEW" "$OLD" \
  "$([ "${HAS_LANG:-0}" -gt 0 ] && echo true || echo false)" > "$REPORT"
