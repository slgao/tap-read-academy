#!/usr/bin/env bash
# Tap Read 一键部署
#
#   deploy/deploy.sh              部署当前代码（默认）
#   deploy/deploy.sh rollback     回滚到上一次部署的版本
#   deploy/deploy.sh backup       立即在服务器上备份，并把备份拉回本地 deploy/backups/
#   deploy/deploy.sh status       查看服务、备份、内存状态
#   deploy/deploy.sh logs         查看程序最近的日志
#
# 部署流程：本地语法检查 → 服务器备份 → 保留当前版本 → 同步 server/ web/ → 重启
#          → 本机与公网健康检查 → 不通过则自动回滚 → 核对同机服务进程号未变
#
# 只同步代码（server/、web/），不碰服务器上的 data/ 和 content/，也不碰 Caddy 配置。
# 配置在 deploy/deploy.env（不入库），参考 deploy.env.example。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APP=/opt/tap-read

[ -f "$HERE/deploy.env" ] || { echo "缺少 $HERE/deploy.env，先复制 deploy.env.example 并填写"; exit 1; }
# shellcheck disable=SC1091
. "$HERE/deploy.env"
: "${DEPLOY_HOST:?deploy.env 里要设置 DEPLOY_HOST}"
: "${PUBLIC_URL:?deploy.env 里要设置 PUBLIC_URL}"
WATCH_SERVICES="${WATCH_SERVICES:-}"

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 "$DEPLOY_HOST")
step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
remote() { "${SSH[@]}" "bash -s" -- "$@"; }

watch_pids() {
  [ -z "$WATCH_SERVICES" ] && return 0
  "${SSH[@]}" "for s in $WATCH_SERVICES; do echo \"\$s=\$(systemctl show \$s -p MainPID --value)\"; done"
}

health() {
  # 本机：页面能打开、接口路由正常（未登录应返回 401 的 JSON）
  remote <<'R' || return 1
set -e
for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ || true)
  [ "$code" = "200" ] && break
  sleep 1
done
[ "$code" = "200" ] || { echo "本机首页返回 $code"; exit 1; }
curl -s http://127.0.0.1:3000/api/me | grep -q '"code":401' || { echo "接口没有按预期返回 401"; exit 1; }
R
  # 公网：经过 Caddy 和证书
  local pub
  pub=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$PUBLIC_URL/" || true)
  [ "$pub" = "200" ] || { echo "公网地址返回 $pub"; return 1; }
}

ensure_backup_installed() {
  rsync -az --rsync-path="sudo rsync" \
    "$HERE/server/tap-read-backup.sh" "$DEPLOY_HOST:/usr/local/bin/tap-read-backup"
  rsync -az --rsync-path="sudo rsync" \
    "$HERE/server/tap-read-backup.service" "$HERE/server/tap-read-backup.timer" \
    "$DEPLOY_HOST:/etc/systemd/system/"
  remote <<'R'
set -e
sudo chmod 755 /usr/local/bin/tap-read-backup
sudo chown root:root /usr/local/bin/tap-read-backup /etc/systemd/system/tap-read-backup.service /etc/systemd/system/tap-read-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now tap-read-backup.timer >/dev/null 2>&1
R
}

cmd_deploy() {
  step "本地检查"
  local f
  for f in "$ROOT"/server/src/*.js "$ROOT"/web/*.js; do node --check "$f"; done
  ok "语法检查通过"
  local rev dirty=""
  rev=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)
  git -C "$ROOT" diff --quiet -- server web 2>/dev/null || dirty="+未提交改动"
  ok "版本 $rev$dirty"
  [ -n "$dirty" ] && printf '  \033[33m!\033[0m server/ 或 web/ 有未提交的改动，也会一起部署\n'

  step "连接服务器"
  "${SSH[@]}" "systemctl is-active tap-read >/dev/null" && ok "$DEPLOY_HOST 上 tap-read 正在运行"
  local before; before=$(watch_pids)
  [ -n "$before" ] && ok "记录同机服务：$(echo $before)"

  step "部署前备份"
  ensure_backup_installed
  "${SSH[@]}" "sudo tap-read-backup" | sed 's/^/  /'

  step "保留当前版本（用于回滚）"
  remote <<R
set -e
sudo mkdir -p $APP/.prev
sudo rsync -a --delete $APP/server/ $APP/.prev/server/
sudo rsync -a --delete $APP/web/ $APP/.prev/web/
[ -f $APP/REVISION ] && sudo cp $APP/REVISION $APP/.prev/REVISION || true
R
  ok "已存到 $APP/.prev"

  step "同步代码"
  local rs=(rsync -az --delete --rsync-path="sudo rsync" --chown=tapread:tapread --exclude node_modules)
  "${rs[@]}" "$ROOT/server/" "$DEPLOY_HOST:$APP/server/"
  "${rs[@]}" "$ROOT/web/" "$DEPLOY_HOST:$APP/web/"
  "${SSH[@]}" "echo '$rev$dirty $(date -u +%FT%TZ)' | sudo tee $APP/REVISION >/dev/null"
  ok "server/ web/ 已同步（data/ content/ 未动）"

  step "重启并健康检查"
  "${SSH[@]}" "sudo systemctl restart tap-read"
  local reason
  if reason=$(health 2>&1); then
    ok "本机与公网检查都通过"
  else
    bad "健康检查失败：$reason"
    step "自动回滚"
    do_rollback
    exit 1
  fi

  if [ -n "$before" ]; then
    local after; after=$(watch_pids)
    if [ "$before" = "$after" ]; then ok "同机服务进程号未变：$(echo $after)"
    else bad "同机服务进程号变了！之前：$(echo $before)  现在：$(echo $after)"; fi
  fi
  printf '\n\033[32m部署完成\033[0m  %s  →  %s\n' "$rev$dirty" "$PUBLIC_URL"
}

do_rollback() {
  remote <<R
set -e
[ -d $APP/.prev/server ] || { echo "没有可回滚的版本"; exit 1; }
sudo rsync -a --delete $APP/.prev/server/ $APP/server/
sudo rsync -a --delete $APP/.prev/web/ $APP/web/
[ -f $APP/.prev/REVISION ] && sudo cp $APP/.prev/REVISION $APP/REVISION || true
sudo chown -R tapread:tapread $APP/server $APP/web
sudo systemctl restart tap-read
R
  if health >/dev/null 2>&1; then ok "已回滚并恢复服务（$("${SSH[@]}" "cat $APP/REVISION 2>/dev/null" || echo 版本未知)）"
  else bad "回滚后健康检查仍失败，请执行 deploy.sh logs 排查"; return 1; fi
}

cmd_rollback() { step "回滚到上一次部署"; do_rollback; }

cmd_backup() {
  step "服务器上立即备份"
  ensure_backup_installed
  "${SSH[@]}" "sudo tap-read-backup" | sed 's/^/  /'
  step "拉回本地"
  mkdir -p "$HERE/backups"
  rsync -az --rsync-path="sudo rsync" "$DEPLOY_HOST:/var/backups/tap-read/" "$HERE/backups/"
  ok "本地 deploy/backups/ 现有 $(ls -1 "$HERE"/backups/tap-read-*.tar.gz 2>/dev/null | wc -l) 份，最新：$(ls -1t "$HERE"/backups/tap-read-*.tar.gz | head -1 | xargs basename)"
}

cmd_status() {
  "${SSH[@]}" "WATCH='$WATCH_SERVICES' bash -s" <<'R'
echo "== 版本 =="; cat /opt/tap-read/REVISION 2>/dev/null || echo "（首次部署前手工安装，无记录）"
echo "== 服务 =="
for s in tap-read caddy $WATCH; do printf '  %-10s %-8s PID %s\n' "$s" "$(systemctl is-active $s)" "$(systemctl show $s -p MainPID --value)"; done
echo "== 备份 =="
systemctl list-timers tap-read-backup.timer --no-legend 2>/dev/null | awk '{print "  下次："$1" "$2" "$3}'
sudo ls -1t /var/backups/tap-read/ 2>/dev/null | head -3 | sed 's/^/  /'
echo "  共 $(sudo ls -1 /var/backups/tap-read/ 2>/dev/null | wc -l) 份"
echo "== 内存 =="; free -m | awk 'NR==2{printf "  已用 %s / %s MB，可用 %s MB\n",$3,$2,$7} NR==3{printf "  swap 已用 %s MB\n",$3}'
echo "== 磁盘 =="; df -h / | awk 'NR==2{print "  已用 "$3" / "$2}'
R
}

cmd_logs() { "${SSH[@]}" "sudo journalctl -u tap-read -n ${1:-50} --no-pager -o short-iso"; }

case "${1:-deploy}" in
  deploy)   cmd_deploy ;;
  rollback) cmd_rollback ;;
  backup)   cmd_backup ;;
  status)   cmd_status ;;
  logs)     cmd_logs "${2:-50}" ;;
  -h|--help|help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) echo "未知命令：$1（可用：deploy rollback backup status logs）"; exit 1 ;;
esac
