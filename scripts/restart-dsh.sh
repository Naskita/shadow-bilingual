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
URL=http://127.0.0.1:55443

sleep "$WAIT"

probe() {  # $1 = path -> 打印 HTTP 状态码
  curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$URL$1" 2>/dev/null || echo 000
}

OLD_PID="$(pgrep -f 'dsh-desktop-host/lib/index.js' | head -1)"

# 1) 先请应用正常退出，让它把会话落盘
osascript -e 'quit app "DeepSeek Harness"' >/dev/null 2>&1

for _ in $(seq 1 20); do
  sleep 1
  pgrep -f 'dsh-desktop-host/lib/index.js' >/dev/null 2>&1 || break
done

# 2) 还没退干净就强杀宿主
if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
  kill "$OLD_PID" 2>/dev/null
  sleep 3
fi

# 3) 重新打开
open -a "$APP" >/dev/null 2>&1

# 4) 等宿主把 HTTP 端口拉起来，再探两条路由
NEW=000
for _ in $(seq 1 60); do
  sleep 2
  NEW="$(probe /api/shadow-bilingual/health)"
  [ "$NEW" = "200" ] && break
done

OLD="$(probe /api/dsh-bilingual-en/health)"

printf '{"at":"%s","oldHostPid":"%s","newRouteHttp":"%s","oldRouteHttp":"%s"}\n' \
  "$(date -u +%FT%TZ)" "$OLD_PID" "$NEW" "$OLD" > "$REPORT"
