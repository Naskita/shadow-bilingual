#!/bin/bash
# 一次跑完三种自检：单元测试 + 发送链路断言 + 槽位清单。
# 改完 bundle 先跑这个，比在界面上试错快得多。
set -u
cd "$(dirname "$0")/.." || exit 1

fail=0

echo '== build =='
node build.mjs || exit 1

echo
echo '== unit tests =='
node --test tests/*.test.mjs || fail=1

echo
echo '== send path =='
node tests/send-path.cjs lib/client.js || fail=1

echo
echo '== slots =='
node tests/list-slots.cjs lib/client.js || fail=1

echo
[ "$fail" -eq 0 ] && echo '✅ 全部通过' || echo '❌ 有失败项'
exit "$fail"
