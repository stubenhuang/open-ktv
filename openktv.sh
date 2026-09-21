#!/usr/bin/env bash
#
# Open KTV 服务管理脚本
#
#   ./openktv.sh start            启动（生产模式：单进程，先自动构建前端）
#   ./openktv.sh start --dev      启动开发模式（Vite HMR + 后端 --watch，改代码自动生效）
#   ./openktv.sh stop             关闭
#   ./openktv.sh stop --force     关闭，并且顺手清掉占着端口的残留进程
#   ./openktv.sh restart          重启（沿用上次的模式）
#   ./openktv.sh status           查看状态（运行中退出码 0，没运行退出码 1）
#   ./openktv.sh logs             跟踪日志（Ctrl+C 退出，不会关服务）
#
# 环境变量：
#   PORT      后端端口，默认 8787
#   WEB_PORT  开发模式下 Vite 端口，默认 5173
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

RUN_DIR="$ROOT/.run"
PID_FILE="$RUN_DIR/openktv.pid"
MODE_FILE="$RUN_DIR/openktv.mode"
LOG_FILE="$RUN_DIR/openktv.log"

PORT="${PORT:-8787}"
WEB_PORT="${WEB_PORT:-5173}"

# ---------------------------------- 输出风格 ---------------------------------

if [[ -t 1 ]]; then
  C_DIM=$'\033[2m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'; C_OFF=$'\033[0m'
else
  C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_CYAN=''; C_OFF=''
fi

info()  { printf '%s▶%s %s\n' "$C_CYAN" "$C_OFF" "$*"; }
ok()    { printf '%s✔%s %s\n' "$C_GREEN" "$C_OFF" "$*"; }
warn()  { printf '%s!%s %s\n' "$C_YELLOW" "$C_OFF" "$*" >&2; }
err()   { printf '%s✖%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; }
dim()   { printf '%s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }

usage() {
  # 打印文件开头的注释块（shebang 之后、第一行非注释之前）
  awk 'NR > 1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
}

# ---------------------------------- 工具函数 ---------------------------------

# 端口上的监听进程 pid（可能多个，一行一个）
port_pids() {
  local port="$1"
  command -v lsof >/dev/null 2>&1 || return 0
  lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true
}

# 把多行 pid 拼成一行，方便打日志
join_pids() {
  printf '%s' "$1" | tr '\n' ' ' | sed 's/ *$//'
}

# pid 文件存在且进程活着
is_running() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(awk 'NR==1{print $1}' "$PID_FILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

read_pid_file() {
  # 设置全局 PID / MODE
  PID=""; MODE=""
  [[ -f "$PID_FILE" ]] || return 0
  read -r PID MODE < "$PID_FILE" || true
}

# 轮询等待某个端口有服务在应答
wait_http() {
  local url="$1" limit="${2:-60}" waited=0
  while [[ "$waited" -lt "$limit" ]]; do
    if curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null; then
      return 0
    fi
    sleep 0.5
    waited=$((waited + 1))
  done
  return 1
}

wait_port() {
  local port="$1" limit="${2:-60}" waited=0
  while [[ "$waited" -lt "$limit" ]]; do
    [[ -n "$(port_pids "$port")" ]] && return 0
    sleep 0.5
    waited=$((waited + 1))
  done
  return 1
}

tail_log() {
  [[ -f "$LOG_FILE" ]] || return 0
  err "日志尾部（完整日志：${LOG_FILE}）："
  tail -n 25 "$LOG_FILE" | sed 's/^/    /' >&2
}

preflight() {
  command -v node >/dev/null 2>&1 || { err "找不到 node，请先装 Node.js ≥ 22.6"; exit 1; }
  command -v ffmpeg  >/dev/null 2>&1 || { err "找不到 ffmpeg，请先安装并放进 PATH"; exit 1; }
  command -v ffprobe >/dev/null 2>&1 || { err "找不到 ffprobe（通常在 ffmpeg 包里）"; exit 1; }
  if [[ ! -d "$ROOT/node_modules" ]]; then
    err "还没装依赖，先执行：npm install"
    exit 1
  fi
  # curl 只用来做健康检查，没有就降级成「只看端口有没有在监听」
  command -v curl >/dev/null 2>&1 || \
    warn "没找到 curl，将跳过 HTTP 健康检查，只按端口监听判断是否就绪"
}

# 等后端真正能应答（拿不到 curl 时退化成等端口）
wait_backend_ready() {
  local limit="${1:-60}"
  if command -v curl >/dev/null 2>&1; then
    wait_http "http://127.0.0.1:${PORT}/api/health" "$limit"
  else
    wait_port "$PORT" "$limit"
  fi
}

# 启动前确认要用的端口是空的，避免起来之后才发现绑不上
ensure_ports_free() {
  local ports=("$@") port pids
  for port in "${ports[@]}"; do
    pids="$(port_pids "$port")"
    if [[ -n "$pids" ]]; then
      err "端口 $port 已被占用（pid $(join_pids "$pids"))"
      dim "  先关掉它，或者换个端口：PORT=9000 WEB_PORT=5273 $0 start" >&2
      exit 1
    fi
  done
}

# 真正把进程拉起来
spawn_daemon() {
  local mode="$1"; shift
  # 刻意不经过 npm：npm 会再套一层进程，$! 拿到的就不是服务本身，信号也传不干净
  nohup "$@" < /dev/null >> "$LOG_FILE" 2>&1 &
  DAEMON_PID=$!
  printf '%s %s\n' "$DAEMON_PID" "$mode" > "$PID_FILE"
}

# ----------------------------------- start -----------------------------------

cmd_start() {
  local mode="prod"
  local arg
  for arg in "$@"; do
    case "$arg" in
      --dev|-d)  mode="dev" ;;
      --prod|-p) mode="prod" ;;
      -h|--help) usage; exit 0 ;;
      *) err "未知参数：$arg"; echo; usage; exit 2 ;;
    esac
  done

  if is_running; then
    read_pid_file
    warn "服务已经在运行了（pid ${PID}，模式 ${MODE}）"
    dim "  要重启就用：$0 restart" >&2
    exit 0
  fi

  preflight
  mkdir -p "$RUN_DIR"
  # 记下模式：即使服务已经停了，restart 也能沿用上次的选择
  printf '%s\n' "$mode" > "$MODE_FILE"

  if [[ "$mode" == "dev" ]]; then
    ensure_ports_free "$PORT" "$WEB_PORT"
  else
    ensure_ports_free "$PORT"
  fi

  {
    echo ""
    echo "========== $(date '+%Y-%m-%d %H:%M:%S') 启动（模式：${mode}） =========="
  } >> "$LOG_FILE"

  if [[ "$mode" == "prod" ]]; then
    info "构建前端（很快，改了代码也能生效）…"
    if ! npm run build >> "$LOG_FILE" 2>&1; then
      err "前端构建失败"
      tail_log
      exit 1
    fi
    spawn_daemon "$mode" node --disable-warning=ExperimentalWarning server/src/index.ts
  else
    spawn_daemon "$mode" node scripts/dev.mjs
  fi

  info "等待服务就绪…"
  if ! wait_backend_ready 60; then
    if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
      err "服务启动后立刻退出了"
    else
      err "等待超时，服务没能就绪"
    fi
    kill -TERM "$DAEMON_PID" 2>/dev/null || true
    rm -f "$PID_FILE"
    tail_log
    exit 1
  fi

  if [[ "$mode" == "dev" ]] && ! wait_port "$WEB_PORT" 40; then
    warn "后端起来了，但前端（${WEB_PORT}）还没就绪，看下日志"
  fi

  echo
  ok "Open KTV 已启动（pid ${DAEMON_PID}，模式 ${mode}）"
  if [[ "$mode" == "dev" ]]; then
    echo "   打开：${C_CYAN}http://127.0.0.1:$WEB_PORT${C_OFF}"
    dim "   开发模式：改代码自动生效（前端热更新、后端 --watch 重启）"
  else
    echo "   打开：${C_CYAN}http://127.0.0.1:$PORT${C_OFF}"
    dim "   生产模式：单进程同时托管前端和 API"
  fi
  dim "   日志：$LOG_FILE"
  dim "   关闭：$0 stop"
}

# ------------------------------------ stop -----------------------------------

cmd_stop() {
  local force=0 quiet=0 arg
  for arg in "$@"; do
    case "$arg" in
      --force|-f) force=1 ;;
      --quiet|-q) quiet=1 ;;
      -h|--help)  usage; exit 0 ;;
      *) err "未知参数：$arg"; exit 2 ;;
    esac
  done

  local stopped=0

  if [[ -f "$PID_FILE" ]]; then
    read_pid_file
    if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
      info "正在停止服务（pid ${PID}，模式 ${MODE:-未知}）…"
      kill -TERM "$PID" 2>/dev/null || true

      # dev 模式下 dev.mjs 会把信号转发给 vite 和 node；给它们一点时间
      local waited=0
      while kill -0 "$PID" 2>/dev/null && [[ "$waited" -lt 40 ]]; do
        sleep 0.25
        waited=$((waited + 1))
      done

      if kill -0 "$PID" 2>/dev/null; then
        warn "优雅退出超时，强制结束"
        kill -KILL "$PID" 2>/dev/null || true
        sleep 0.5
      fi
      stopped=1
    else
      dim "  pid 文件里的进程（${PID:-空}）已经不在了，清理掉记录"
    fi
    rm -f "$PID_FILE"
  fi

  # 兜底：脚本之外手动起的服务，或者子进程没被一起收走
  local port pids
  for port in "$WEB_PORT" "$PORT"; do
    pids="$(port_pids "$port")"
    [[ -n "$pids" ]] || continue

    if [[ "$force" -eq 1 ]]; then
      warn "强制结束占用端口 $port 的进程：$(join_pids "$pids")"
      # shellcheck disable=SC2086
      kill -KILL $pids 2>/dev/null || true
      stopped=1
    else
      warn "端口 $port 还被占用（pid $(join_pids "$pids")）"
      dim "  这可能是在别的终端里手动起的服务；要一起清掉就用：$0 stop --force" >&2
    fi
  done

  if [[ "$stopped" -eq 1 ]]; then
    ok "服务已关闭"
  elif [[ "$quiet" -eq 0 ]]; then
    dim "服务本来就没在运行"
  fi
}

# ----------------------------------- status ----------------------------------

cmd_status() {
  if is_running; then
    read_pid_file
    ok "运行中：pid ${PID}，模式 ${MODE:-未知}"

    local health
    health="$(curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
    if [[ -n "$health" ]]; then
      echo "   后端 http://127.0.0.1:$PORT  →  $health"
    else
      warn "后端进程在，但 $PORT 端口没有应答（可能还在启动，或者卡住了）"
    fi

    if [[ "${MODE:-}" == "dev" ]]; then
      if [[ -n "$(port_pids "$WEB_PORT")" ]]; then
        echo "   前端 http://127.0.0.1:$WEB_PORT"
      else
        warn "前端端口 $WEB_PORT 没有在监听"
      fi
    else
      echo "   打开 http://127.0.0.1:$PORT"
    fi

    dim "   日志：$LOG_FILE"
    return 0
  fi

  dim "未运行"
  local port pids
  for port in "$WEB_PORT" "$PORT"; do
    pids="$(port_pids "$port")"
    [[ -n "$pids" ]] && warn "不过端口 $port 被别的进程占着（pid $(join_pids "$pids")）"
  done
  return 1
}

# ---------------------------------- restart ----------------------------------

cmd_restart() {
  local mode=""
  # 优先用「上次启动时记下的模式」，服务正在跑的话再兜一层当前 pid 文件
  if [[ -f "$MODE_FILE" ]]; then
    read -r mode < "$MODE_FILE" || true
  fi
  read_pid_file
  if [[ -n "$MODE" ]]; then
    mode="$MODE"
  fi

  local arg
  for arg in "$@"; do
    case "$arg" in
      --dev|-d)  mode="dev" ;;
      --prod|-p) mode="prod" ;;
    esac
  done

  # 这里刻意不加 --force：重启只该动我们自己的进程。
  # 别的程序占着端口时应该让 start 明确报错，而不是被悄悄杀掉。
  cmd_stop --quiet
  sleep 0.5

  echo
  if [[ -n "$mode" ]]; then
    cmd_start "--$mode"
  else
    cmd_start
  fi
}

# ----------------------------------- logs ------------------------------------

cmd_logs() {
  if [[ ! -f "$LOG_FILE" ]]; then
    err "还没有日志文件：$LOG_FILE"
    exit 1
  fi
  dim "跟踪 ${LOG_FILE}（Ctrl+C 退出，不会关掉服务）"
  tail -n 60 -f "$LOG_FILE"
}

# ----------------------------------- 入口 ------------------------------------

case "${1:-}" in
  start)   shift; cmd_start "$@" ;;
  stop)    shift; cmd_stop "$@" ;;
  restart) shift; cmd_restart "$@" ;;
  status)  shift; cmd_status "$@" ;;
  logs)    shift; cmd_logs "$@" ;;
  ""|-h|--help|help) usage ;;
  *) err "未知命令：$1"; echo; usage; exit 2 ;;
esac
