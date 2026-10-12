#!/usr/bin/env bash
# =============================================================================
# memory-server 应急启动脚本（⚠️ 平时不要用这个）
#
# 【真正的管理者是 PM2】线上服务由 PM2 托管，4 个环境变量也存在 PM2 的配置里。
# 日常运维请用这些命令（进程名：memory-server）：
#
#     pm2 list                            # 看状态
#     pm2 restart memory-server           # 重启（自动带上 4 个环境变量）
#     pm2 logs memory-server --lines 50   # 看日志
#     pm2 describe memory-server          # 看详情（cwd / watch / 环境变量）
#     pm2 save                            # 保存进程表快照（开机自启就是从这个快照恢复的）
#
# 已确认：systemctl is-enabled pm2-root → enabled（开机自启有效）
#         pm2 describe → watch & reload ✘（改文件不会触发意外重启）
#         pm2 env 0 → 4 个 MEMORY_* 变量都在
#
# 【本脚本只在 PM2 彻底不可用时应急】（PM2 被卸载 / daemon 起不来 / 临时裸跑）
# 平时它的 stop 是无效的：PM2 会在几百毫秒内把进程重新拉起来，看起来像"停不掉"。
# 所以 stop 分支会先探测 PM2，若发现 PM2 在管就直接拒绝执行并提示正确命令。
#
# 用法：
#   bash start-memory-server.sh           # 启动（已在跑则不重复启动）
#   bash start-memory-server.sh status    # 查看状态与当前环境变量
#   bash start-memory-server.sh stop      # 停止（PM2 在管时会拒绝执行）
#
# 安全说明：只启动/停止进程并读取状态，不修改、不删除数据库或任何文件。
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
    # PM2 在管的时候，pkill 会在几百毫秒内被 PM2 撤销，看起来像"停不掉"。
    # 所以先探测 PM2，发现它在管就直接拒绝，并给出正确命令。
    if command -v pm2 >/dev/null 2>&1; then
      pm2_pid="$(pm2 pid memory-server 2>/dev/null | tr -d '[:space:]')"
      if [ -n "$pm2_pid" ] && [ "$pm2_pid" != "0" ]; then
        echo "⚠️ PM2 正在管理 memory-server（pid $pm2_pid），本脚本的 stop 会被它立刻撤销。"
        echo "   要真正停止或重启，请用："
        echo "     pm2 stop memory-server"
        echo "     pm2 restart memory-server"
        exit 3
      fi
    fi
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
