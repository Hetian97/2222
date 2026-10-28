#!/usr/bin/env bash
# =============================================================================
# backup-vps.sh —— 一键备份 memory-server 相关资产（在 VPS 上以 root 运行）
#
# 备份内容：
#   1) 代码 + 配置 + 系统资产（memory-server/*.js、PM2 进程表、token、Chroma 脚本、
#      唤醒桥、健康 MCP、nginx/systemd 配置、健康数据、tailscale 状态、.ssh）
#   2) 数据库一致快照（sqlite3 .backup，绝不在写库时直接 cp）
#   3) 向量库（chroma-data；打包期间暂停 chroma，结束后自动恢复）
#
# 用法：
#   bash backup-vps.sh               # 完整备份（配置 + 数据库 + 向量库）
#   bash backup-vps.sh --db-only     # 只备数据库（最快，日常用这个）
#   bash backup-vps.sh --no-chroma   # 配置 + 数据库（不碰 chroma）
#   OUT_DIR=/root/my-backup bash backup-vps.sh    # 自定义输出目录
#
# 安全说明：
#   · 只读取数据、只在 OUT_DIR 里创建文件；不会删除任何已有备份
#     （唯一会删的是它自己刚生成的 .db 中间文件）
#   · 打包 chroma 前 pm2 stop、结束后无论成功失败都会 pm2 start 回去
#   · 数据库快照会做 pragma integrity_check，不通过就立即中止
#
# 产物：/root/vps-backup/{config,db,chroma}-<日期-时间>.{tar.gz,db.gz}
# =============================================================================
set -uo pipefail

APP_DIR="${APP_DIR:-/root/memory-server}"
OUT_DIR="${OUT_DIR:-/root/vps-backup}"
DB_FILE="$APP_DIR/memory.db"
CHROMA_DIR_NAME="chroma-data"
STAMP="$(date +%F-%H%M)"
PREFIX="[backup]"

say()  { echo "$PREFIX $*"; }
warn() { echo "$PREFIX ⚠️  $*" >&2; }
die()  { echo "$PREFIX ✗ $*" >&2; exit 1; }

MODE="full"
case "${1:-}" in
  ""|--full|full) MODE="full" ;;
  --db-only|db)   MODE="db" ;;
  --no-chroma|nochroma) MODE="nochroma" ;;
  -h|--help)
    sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *) die "未知参数：$1（可用：--db-only / --no-chroma / --full / --help）" ;;
esac

[ -f "$DB_FILE" ] || die "找不到数据库：$DB_FILE"
command -v sqlite3 >/dev/null 2>&1 || die "没装 sqlite3"
mkdir -p "$OUT_DIR" || die "无法创建输出目录：$OUT_DIR"

PKGS=()

# ---------------------------------------------------------------------------
# 1) 代码 + 配置 + 系统资产
# ---------------------------------------------------------------------------
if [ "$MODE" != "db" ]; then
  CFG="$OUT_DIR/config-$STAMP.tar.gz"
  say "打包代码 / 配置 / 系统资产…"
  tar czf "$CFG" --ignore-failed-read \
    "$APP_DIR"/*.js "$APP_DIR"/*.json \
    "$APP_DIR/start-chroma.sh" "$APP_DIR/.memory-api-token" \
    /root/aisay-wake /root/galatea-garden-wake-bridge \
    /root/.pm2/dump.pm2 /opt/ephone-health-mcp /etc/ephone-health-mcp.env \
    /etc/nginx/sites-enabled /etc/nginx/conf.d \
    /etc/systemd/system/*.service \
    /var/lib/ephone-health /var/lib/tailscale/tailscaled.state \
    /root/.ssh /root/.bashrc \
    2>/dev/null
  [ -s "$CFG" ] || die "配置包是空的，打包失败"
  CFG_SIZE=$(stat -c %s "$CFG" 2>/dev/null || echo 0)
  [ "$CFG_SIZE" -gt 1024 ] || die "配置包只有 $CFG_SIZE 字节，明显不对"
  # 关键资产抽样检查（Gadgetbridge/tailscale/ssh 至少各一个）
  KEY_COUNT=$(tar tzf "$CFG" 2>/dev/null | grep -cE 'Gadgetbridge|tailscaled|\.ssh')
  say "  → $(du -h "$CFG" | cut -f1)，关键资产命中 $KEY_COUNT 项 $([ "$KEY_COUNT" -ge 3 ] && echo '✓' || echo '⚠️ 偏少，请检查')"
  PKGS+=("$CFG")
fi

# ---------------------------------------------------------------------------
# 2) 数据库一致快照（三种模式都要做 —— 数据库永远是核心资产）
# ---------------------------------------------------------------------------
if true; then
  DB_SNAP="$OUT_DIR/db-$STAMP.db"
  DB_GZ="$DB_SNAP.gz"
  rm -f "$DB_SNAP" "$DB_GZ"
  say "创建数据库一致快照（sqlite3 .backup）…"
  sqlite3 "$DB_FILE" ".backup '$DB_SNAP'" || die "sqlite3 .backup 失败"
  CHECK=$(sqlite3 "$DB_SNAP" "pragma integrity_check;" 2>/dev/null | head -1)
  [ "$CHECK" = "ok" ] || die "备份完整性检查失败：$CHECK（已保留 $DB_SNAP 供排查）"
  gzip -c "$DB_SNAP" > "$DB_GZ" || die "gzip 失败"
  rm -f "$DB_SNAP"
  ROWS=$(sqlite3 "$DB_FILE" "select count(*) from memories;" 2>/dev/null || echo '?')
  say "  → $(du -h "$DB_GZ" | cut -f1)，integrity ok，记忆条数 $ROWS"
  PKGS+=("$DB_GZ")
fi

# ---------------------------------------------------------------------------
# 3) 向量库（打包期间暂停 chroma）
# ---------------------------------------------------------------------------
if [ "$MODE" = "full" ]; then
  if [ -d "$APP_DIR/$CHROMA_DIR_NAME" ]; then
    CH="$OUT_DIR/chroma-$STAMP.tar.gz"
    have_pm2=0
    command -v pm2 >/dev/null 2>&1 && have_pm2=1

    restore_chroma() {
      if [ "$have_pm2" = "1" ]; then
        pm2 start chroma >/dev/null 2>&1 || warn "chroma 自动恢复失败，请手动：pm2 start chroma"
      fi
    }

    say "暂停 chroma（打包期间向量检索不可用）…"
    if [ "$have_pm2" = "1" ]; then
      pm2 stop chroma >/dev/null 2>&1 || warn "pm2 stop chroma 失败，继续尝试打包"
      trap restore_chroma EXIT
      sleep 2
    else
      warn "没找到 pm2，无法自动暂停 chroma；仍尝试打包（可能拿到写一半的文件）"
    fi

    say "打包 $CHROMA_DIR_NAME…"
    if ! tar czf "$CH" -C "$APP_DIR" "$CHROMA_DIR_NAME" 2>/dev/null; then
      restore_chroma; trap - EXIT
      die "chroma 打包失败"
    fi
    restore_chroma; trap - EXIT
    sleep 3
    say "  → $(du -h "$CH" | cut -f1)"
    [ "$have_pm2" = "1" ] && pm2 list | sed -n '1,6p'
    PKGS+=("$CH")
  else
    warn "没有 $APP_DIR/$CHROMA_DIR_NAME，跳过向量库"
  fi
fi

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------
[ "${#PKGS[@]}" -gt 0 ] || die "没有生成任何备份包"

echo
say "===== 校验值（下载到本地后逐个对比）====="
for p in "${PKGS[@]}"; do sha256sum "$p"; done

echo
say "===== 在本地 cmd 里下载 ====="
echo "  mkdir D:\\app\\0-ephone-backup\\$STAMP"
echo "  cd /d D:\\app\\0-ephone-backup\\$STAMP"
for p in "${PKGS[@]}"; do
  echo "  scp root@<VPS地址>:${p} ."
done
echo "  certutil -hashfile ${PKGS[0]##*/} SHA256   （其余同理）"

echo
say "===== 本地校验无误后，再删 VPS 上的这些包 ====="
for p in "${PKGS[@]}"; do echo "  rm -f $p"; done

echo
say "备份目录占用：$(du -sh "$OUT_DIR" | cut -f1)（$OUT_DIR）"
say "完成。⚠️ config 包含 API token / SSH 私钥，别放公共网盘。"
