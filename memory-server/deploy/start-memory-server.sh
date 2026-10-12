#!/usr/bin/env bash
# =============================================================================
# memory-server 安全启动脚本
#
# 为什么需要它：
#   线上 memory-server 目前是「手动启动的一次性进程」（进程链 npm start ->
#   sh -c node server.js），而且那 4 个 MEMORY_* 环境变量**不在** .bashrc /
#   .profile / /etc/profile / /etc/environment 里，是启动时临时给的。
#   后果：VPS 一旦重启，服务不会自动回来；即使手动重启，只要漏掉那两个
#   *_WRITES_ENABLED，事实层/计划层就会**静默停止写入** —— 没有任何报错，
#   召回也一切正常，你根本不会发现。
#   本脚本把那 4 个变量固化下来，消除这个隐患。
#
# 用法（在 VPS 上，root）：
#   bash /root/memory-server/start-memory-server.sh          # 启动（已在跑则不重复启动）
#   bash /root/memory-server/start-memory-server.sh status   # 查看状态与当前环境变量
#   bash /root/memory-server/start-memory-server.sh stop     # 停止
#
# 想开机自启（可选，二选一）：
#   crontab -e  然后加一行：
#     @reboot bash /root/memory-server/start-memory-server.sh >> /root/memory-server/boot.log 2>&1
#
# 安全说明：本脚本只启动/停止进程并读取状态，不修改、不删除数据库或任何文件。
# =============================================================================

set -u

APP_DIR="/root/memory-server"
LOG_FILE="$APP_DIR/memory-server.log"
TOKEN_FILE="$APP_DIR/.memory-api-token"
PORT="8765"

# ⚠️ 以下 4 个值是从线上正在运行的进程 /proc/<pid>/environ 里读出来的实际配置，请勿随手更改。
export MEMORY_ORGANIZATION_INCREMENTAL_ENABLED=true
export MEMORY_RECALL_GATE_ENABLED=false
export MEMORY_ACTIVE_EVENT_WRITES_ENABLED=true
export MEMORY_CURRENT_FACT_WRITES_ENABLED=true

running() {
  pgrep -f 'node server\.js' >/dev/null 2>&1
}

show_status() {
  if running; then
    echo "状态：正在运行"
    ps -eo pid,etime,cmd | grep '[n]ode server.js'
    echo "--- 当前进程的 MEMORY_* 环境变量 ---"
    for p in $(pgrep -f 'node server\.js'); do
      tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | grep -E '^MEMORY_' || echo "(PID $p 没有 MEMORY_* 变量)"
    done
    echo "--- 两层是否在写入（count 大于 0 说明有数据）---"
    local token
    token="$(cat "$TOKEN_FILE" 2>/dev/null)"
    curl -s -H "Authorization: Bearer $token" \
      "http://127.0.0.1:$PORT/memory/current-facts?includeInactive=true&limit=1" | head -8
  else
    echo "状态：没有在运行"
  fi
}

cd "$APP_DIR" || { echo "找不到目录：$APP_DIR"; exit 1; }

case "${1:-start}" in
  status)
    show_status
    exit 0
    ;;
  stop)
    if running; then
      pkill -f 'node server\.js' && echo "已发送停止信号。" || echo "停止失败。"
    else
      echo "本来就没有在运行。"
    fi
    exit 0
    ;;
  start|"")
    ;;
  *)
    echo "未知参数：$1（可用：start / stop / status）"
    exit 2
    ;;
esac

if running; then
  echo "memory-server 已在运行，不重复启动。"
  echo "要查看状态请执行：bash $0 status"
  exit 0
fi

echo "正在启动 memory-server（日志：$LOG_FILE）..."
nohup node server.js >> "$LOG_FILE" 2>&1 &
sleep 3

if running; then
  echo "启动成功。"
  echo "--- 关键验证：写入开关必须是 true ---"
  for p in $(pgrep -f 'node server\.js'); do
    tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | grep -E '^MEMORY_(ACTIVE_EVENT|CURRENT_FACT)_WRITES_ENABLED'
  done
  echo "--- 接口自检 ---"
  token="$(cat "$TOKEN_FILE" 2>/dev/null)"
  curl -s -H "Authorization: Bearer $token" \
    "http://127.0.0.1:$PORT/memory/current-facts?includeInactive=true&limit=1" | head -8
else
  echo "启动失败，日志末尾 20 行："
  tail -20 "$LOG_FILE"
  exit 1
fi
