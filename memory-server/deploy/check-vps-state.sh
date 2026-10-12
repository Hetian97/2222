#!/usr/bin/env bash
# =============================================================================
# memory-server VPS 只读自查脚本
#
# 目的：确认 VPS 上 memory-server 的【部署方式】【代码版本】【数据库状态】
#       【环境变量】—— 这三项决定了「事实/计划层」要不要动、怎么动。
#
# 用法（二选一）：
#   A. 从电脑上传后执行：
#        scp memory-server/deploy/check-vps-state.sh root@<VPS地址>:/tmp/
#        ssh root@<VPS地址> "bash /tmp/check-vps-state.sh"
#   B. 直接 root 登录 VPS，把本文件内容整段粘贴进终端。
#
# 安全说明：本脚本【只读】，不修改/不删除任何文件，不重启任何服务。
# =============================================================================

set -u

line() { printf '\n========== %s ==========\n' "$1"; }

# ---------------------------------------------------------------------------
line "1. 主机与时间"
date
hostname

# ---------------------------------------------------------------------------
line "2. node 进程（看启动时间与完整命令）"
ps -eo pid,ppid,etime,cmd | grep -E '[n]ode' || echo '(没有 node 进程)'

# ---------------------------------------------------------------------------
line "3. systemd 服务"
systemctl list-units --type=service --all 2>/dev/null | grep -iE 'memory|ephone|mcp' || echo '(没有匹配的 systemd 服务)'
echo '--- 可能相关的 unit 文件 ---'
grep -rlE 'memory|8790|8765|server\.js' /etc/systemd/system/ 2>/dev/null || echo '(无)'

# ---------------------------------------------------------------------------
line "4. Docker 容器"
docker ps --format '{{.Names}} | {{.Image}} | {{.Status}} | {{.Ports}}' 2>/dev/null || echo '(没有 docker 或未运行)'

# ---------------------------------------------------------------------------
line "5. 监听端口"
ss -ltnp 2>/dev/null | grep -E '8765|8790|:(3000|8080|8000)' || echo '(未发现相关端口)'

# ---------------------------------------------------------------------------
line "6. memory-server 代码目录（靠新文件定位）"
echo '--- 若以下为空，说明 VPS 上根本没有这两个文件 = 跑的是旧代码 ---'
find / -path /proc -prune -o -path /sys -prune -o -path /dev -prune -o \
     -name 'memory-current-fact-shadow.js' -print 2>/dev/null
find / -path /proc -prune -o -path /sys -prune -o -path /dev -prune -o \
     -name 'memory-active-event-shadow.js' -print 2>/dev/null
echo '--- 所有 memory-server 目录（最多 5 个）---'
find / -path /proc -prune -o -path /sys -prune -o -path /dev -prune -o \
     -type d -name 'memory-server' -print 2>/dev/null | head -5

# ---------------------------------------------------------------------------
line "7. 反向代理路由（nginx / caddy）"
grep -rnE 'location|proxy_pass' /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null \
  | grep -iE 'memory|8765|8790|/health|/mcp' || echo '(nginx 未匹配)'
if [ -f /etc/caddy/Caddyfile ]; then
  echo '--- Caddyfile ---'
  grep -nE 'handle|reverse_proxy' /etc/caddy/Caddyfile 2>/dev/null | head -20
fi

# ---------------------------------------------------------------------------
line "8. 数据库文件"
for d in $(find / -path /proc -prune -o -path /sys -prune -o -path /dev -prune -o \
                -maxdepth 6 -name 'memory.db' -print 2>/dev/null | head -10); do
  ls -la "$d" "${d}-wal" 2>/dev/null
done

# ---------------------------------------------------------------------------
line "9. 环境变量（关键：两个写入开关）"
for p in $(pgrep -f 'node .*server\.js' 2>/dev/null); do
  echo "--- PID $p ---"
  tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | grep -E '^MEMORY_|^NODE_ENV' || echo '(该进程没有 MEMORY_* 变量)'
done
echo '--- 常见 env 文件 ---'
ls -la /etc/*memory*.env /etc/*ephone*.env 2>/dev/null || echo '(无)'
echo '--- systemd unit 里的 Environment ---'
for u in $(systemctl list-units --type=service --all 2>/dev/null | grep -iE 'memory|ephone|mcp' | awk '{print $1}'); do
  systemctl show "$u" -p Environment 2>/dev/null
done

# ---------------------------------------------------------------------------
line "10. 数据库表与行数（判断这两层是否真的跑过）"
for d in $(find / -path /proc -prune -o -path /sys -prune -o -path /dev -prune -o \
                -maxdepth 6 -name 'memory.db' -print 2>/dev/null | head -10); do
  echo "--- $d ---"
  if command -v sqlite3 >/dev/null 2>&1; then
    for t in memories memory_search_logs memory_active_events memory_current_facts; do
      printf '  %-24s = %s\n' "$t" "$(sqlite3 "$d" "select count(*) from $t;" 2>&1)"
    done
    echo "  最近一条记忆 createdAt = $(sqlite3 "$d" 'select max(createdAt) from memories;' 2>&1)  (毫秒时间戳)"
  else
    echo '  (没有 sqlite3 命令；请在 memory-server 目录执行下面这行)'
    echo "  node -e \"const D=require('better-sqlite3');const db=new D('$d',{readonly:true});for(const t of ['memories','memory_search_logs','memory_active_events','memory_current_facts']){try{console.log(t,db.prepare('select count(*) c from '+t).get().c)}catch(e){console.log(t,'ERR',e.message)}}\""
  fi
done

# ---------------------------------------------------------------------------
line "11. 代码版本（如果是 git 部署）"
for g in $(find / -path /proc -prune -o -path /sys -prune -o -path /dev -prune -o \
               -maxdepth 5 -type d -name '.git' -print 2>/dev/null | head -10); do
  app="${g%/.git}"
  case "$app" in /root/.cache*|/root/.*|/home/*/.*) continue ;; esac
  echo "--- $app ---"
  git -C "$app" rev-parse --abbrev-ref HEAD 2>&1
  git -C "$app" log --oneline -3 2>&1
  git -C "$app" status --short 2>&1 | head -5
done

# ---------------------------------------------------------------------------
line "怎么看结果"
cat <<'EOF'
第 6 节为空            -> VPS 跑的是旧代码，本次必须把 memory-server 代码传上去。
第 6 节有文件但没 .git  -> 代码是 scp 上传的，本次同样用 scp + 重启。
第 9 节没有这两个变量   -> 事实层/计划层从未写入过（默认 false），这解释了「记不住」：
                          MEMORY_ACTIVE_EVENT_WRITES_ENABLED
                          MEMORY_CURRENT_FACT_WRITES_ENABLED
第 10 节表不存在        -> 服务从未用新代码重启过（表会在启动时自动创建）。
第 10 节有表但 0 行     -> 表建了、开关没开。
第 10 节有行           -> 数据一直在写，问题纯粹在「没有注入通道」。

请把本脚本的完整输出发回来。
EOF
