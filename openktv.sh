#!/usr/bin/env bash
#
# Open KTV 服务管理脚本
#
#   ./openktv.sh start            启动（生产模式：单进程，先自动构建前端）
#                                 默认占住当前终端前台跑，日志实时打出来，Ctrl+C 关闭
#   ./openktv.sh start --dev      启动开发模式（Vite HMR + 后端 --watch，改代码自动生效）
#   ./openktv.sh start --daemon   放后台跑（不占终端），启动完就返回，用 stop 关
#   ./openktv.sh stop             关闭
#   ./openktv.sh stop --force     关闭，并且顺手清掉占着端口的残留进程
#   ./openktv.sh restart          重启（沿用上次的模式）
#   ./openktv.sh status           查看状态（运行中退出码 0，没运行退出码 1）
#   ./openktv.sh logs             跟踪日志（Ctrl+C 退出，不会关服务）
#
# 前台模式（默认）下 Ctrl+C 一次是优雅关闭，再按一次就是强制结束。
# 前台后台都会把 pid 写进 .run/openktv.pid，所以另开一个终端跑 status / stop 一样管用。
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
# 返回 0=就绪，1=超时，2=用户按了 Ctrl+C（前台模式），别继续等了
wait_http() {
  local url="$1" limit="${2:-60}" waited=0
  while [[ "$waited" -lt "$limit" ]]; do
    [[ "${FG_STOPPING:-0}" -eq 1 ]] && return 2
    if curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null; then
      return 0
    fi
    sleep 0.5 || true
    waited=$((waited + 1))
  done
  return 1
}

wait_port() {
  local port="$1" limit="${2:-60}" waited=0
  while [[ "$waited" -lt "$limit" ]]; do
    [[ "${FG_STOPPING:-0}" -eq 1 ]] && return 2
    [[ -n "$(port_pids "$port")" ]] && return 0
    sleep 0.5 || true
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

# 真正把进程拉起来（后台模式）
spawn_daemon() {
  local mode="$1"; shift
  # 刻意不经过 npm：npm 会再套一层进程，$! 拿到的就不是服务本身，信号也传不干净
  nohup "$@" < /dev/null >> "$LOG_FILE" 2>&1 &
  DAEMON_PID=$!
  printf '%s %s\n' "$DAEMON_PID" "$mode" > "$PID_FILE"
}

# ------------------------------ 前台模式（默认） ------------------------------

# 前台模式下服务自身的 pid / 跟随日志的 tail 进程 / 待转发的信号
FG_CHILD=0
FG_TAIL=0
FG_SIGNAL=''
FG_STOPPING=0

# 信号处理里只做记录和转发，真正的等待放到主流程
# （bash 的 trap 返回之前主流程是停住的，在 handler 里死等容易卡住自己）
on_signal() {
  local sig="$1"
  if [[ "$FG_STOPPING" -eq 0 ]]; then
    FG_STOPPING=1
    FG_SIGNAL="$sig"
    printf '\n'
    warn "收到 ${sig}，正在收尾…（再按一次 Ctrl+C 强制结束）"
  else
    FG_SIGNAL="KILL"
    warn "再来一次：直接强制结束"
  fi
}

# 把这次启动之后新写进日志的内容实时跟到终端
follow_log() {
  [[ -f "$LOG_FILE" ]] || return 0
  tail -n "+$1" -f "$LOG_FILE" 2>/dev/null &
  FG_TAIL=$!
}

stop_follow_log() {
  if [[ "$FG_TAIL" -gt 0 ]]; then
    kill "$FG_TAIL" 2>/dev/null || true
    wait "$FG_TAIL" 2>/dev/null || true
    FG_TAIL=0
  fi
}

# 等前台服务结束：收到信号就先转发给它，超时（10 秒）没退再强杀
wait_foreground() {
  local child="$1" deadline=0
  while kill -0 "$child" 2>/dev/null; do
    if [[ -n "$FG_SIGNAL" ]]; then
      kill -"$FG_SIGNAL" "$child" 2>/dev/null || true
      FG_SIGNAL=''
      deadline=$((SECONDS + 10))
    elif [[ "$deadline" -gt 0 && "$SECONDS" -ge "$deadline" ]]; then
      warn "优雅退出超时，强制结束（pid ${child}）"
      kill -KILL "$child" 2>/dev/null || true
      deadline=0
    fi
    sleep 0.2 || true
  done
}

# 前台模式退出时兜底：脚本一走，服务就跟着走，别留孤儿进程
foreground_exit() {
  stop_follow_log
  if [[ "$FG_CHILD" -gt 0 ]] && kill -0 "$FG_CHILD" 2>/dev/null; then
    # 带上信号，等待循环才会启用 10 秒超时，不至于卡死在这儿
    FG_SIGNAL="${FG_SIGNAL:-TERM}"
    wait_foreground "$FG_CHILD"
  fi
  rm -f "$PID_FILE"
}

# 前台启动：占住终端，日志实时打出来，Ctrl+C 关闭
foreground_start() {
  local mode="$1"; shift

  # tail 只看这次启动之后新增的日志，免得把上次的内容又刷一遍
  local from_line=0
  if [[ -f "$LOG_FILE" ]]; then
    from_line="$(wc -l < "$LOG_FILE" | tr -d '[:space:]')"
  fi

  "$@" < /dev/null >> "$LOG_FILE" 2>&1 &
  FG_CHILD=$!
  printf '%s %s\n' "$FG_CHILD" "$mode" > "$PID_FILE"
  follow_log "$((from_line + 1))"

  trap 'on_signal INT'  INT
  trap 'on_signal TERM' TERM
  trap 'on_signal HUP'  HUP
  trap 'foreground_exit' EXIT

  info "等待服务就绪…"
  local ready=0
  wait_backend_ready 60 || ready=$?
  if [[ "$ready" -ne 0 ]]; then
    if [[ "$ready" -eq 2 ]]; then
      warn "启动被打断，正在收尾…"
      exit 130
    fi
    if ! kill -0 "$FG_CHILD" 2>/dev/null; then
      err "服务在就绪之前就退出了（可能启动报错，或者被 $0 stop 关掉了）"
    else
      err "等待超时，服务没能就绪"
    fi
    err "完整日志：${LOG_FILE}"
    exit 1
  fi

  if [[ "$mode" == "dev" && "$FG_STOPPING" -eq 0 ]]; then
    local web_wait=0
    wait_port "$WEB_PORT" 40 || web_wait=$?
    if [[ "$web_wait" -ne 0 && "$web_wait" -ne 2 ]]; then
      warn "后端起来了，但前端（${WEB_PORT}）还没就绪，看下上面的日志"
    fi
  fi

  # 启动阶段就被 Ctrl+C 的话，就别报「已启动」了，直接收尾
  if [[ "$FG_STOPPING" -eq 0 ]]; then
    print_ready "$FG_CHILD" "$mode"
    dim "   前台运行中：Ctrl+C 关闭（另开终端 $0 stop 也行，日志：${LOG_FILE}）"
    echo
  fi

  wait_foreground "$FG_CHILD"

  local code=0
  wait "$FG_CHILD" 2>/dev/null || code=$?
  FG_CHILD=0
  stop_follow_log
  rm -f "$PID_FILE"

  echo
  # 128+n 是被信号收走的（Ctrl+C 就是这种），不算异常
  if [[ "$code" -eq 0 || "$code" -ge 128 ]]; then
    ok "服务已关闭"
  else
    err "服务异常退出（退出码 ${code}），日志：${LOG_FILE}"
    exit "$code"
  fi
}

# 启动成功后打印访问地址
print_ready() {
  local pid="$1" mode="$2"
  echo
  ok "Open KTV 已启动（pid ${pid}，模式 ${mode}）"
  if [[ "$mode" == "dev" ]]; then
    echo "   打开：${C_CYAN}http://127.0.0.1:$WEB_PORT${C_OFF}"
    dim "   开发模式：改代码自动生效（前端热更新、后端 --watch 重启）"
  else
    echo "   打开：${C_CYAN}http://127.0.0.1:$PORT${C_OFF}"
    dim "   生产模式：单进程同时托管前端和 API"
  fi
}

# ----------------------------------- start -----------------------------------

cmd_start() {
  local mode="prod" daemon=0 arg
  for arg in "$@"; do
    case "$arg" in
      --dev|-d)         mode="dev" ;;
      --prod|-p)        mode="prod" ;;
      --daemon|--bg|-b) daemon=1 ;;
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

  if [[ "$daemon" -eq 0 ]]; then
    # 前台模式：一开始就装好信号处理，构建阶段按 Ctrl+C 也不会被误报成「构建失败」。
    # 位置必须在 is_running 之后：否则这个分支退出时会把正在运行的服务留下的 pid 文件删掉。
    trap 'on_signal INT'  INT
    trap 'on_signal TERM' TERM
    trap 'on_signal HUP'  HUP
    trap 'foreground_exit' EXIT
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

  local -a cmd
  if [[ "$mode" == "prod" ]]; then
    info "构建前端（很快，改了代码也能生效）…"
    if [[ "$daemon" -eq 1 ]]; then
      if ! npm run build >> "$LOG_FILE" 2>&1; then
        err "前端构建失败"
        tail_log
        exit 1
      fi
    else
      # 前台模式把构建输出也打出来，同时留一份在日志里
      if ! npm run build 2>&1 | tee -a "$LOG_FILE"; then
        if [[ "${FG_STOPPING:-0}" -eq 1 ]]; then
          warn "构建被打断，退出"
          exit 130
        fi
        err "前端构建失败"
        exit 1
      fi
    fi
    cmd=(node --disable-warning=ExperimentalWarning server/src/index.ts)
  else
    cmd=(node scripts/dev.mjs)
  fi

  if [[ "$daemon" -eq 0 ]]; then
    foreground_start "$mode" "${cmd[@]}"
    return 0
  fi

  spawn_daemon "$mode" "${cmd[@]}"

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

  print_ready "$DAEMON_PID" "$mode"
  dim "   日志：$LOG_FILE"
  dim "   关闭：$0 stop（这是后台模式；想要 Ctrl+C 关就别加 --daemon）"
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
  local daemon_flag=""
  local arg
  # 优先用「上次启动时记下的模式」，服务正在跑的话再兜一层当前 pid 文件
  if [[ -f "$MODE_FILE" ]]; then
    read -r mode < "$MODE_FILE" || true
  fi
  read_pid_file
  if [[ -n "$MODE" ]]; then
    mode="$MODE"
  fi

  for arg in "$@"; do
    case "$arg" in
      --dev|-d)         mode="dev" ;;
      --prod|-p)        mode="prod" ;;
      --daemon|--bg|-b) daemon_flag="--daemon" ;;
      -h|--help)        usage; exit 0 ;;
      *) err "未知参数：$arg"; echo; usage; exit 2 ;;
    esac
  done

  # 这里刻意不加 --force：重启只该动我们自己的进程。
  # 别的程序占着端口时应该让 start 明确报错，而不是被悄悄杀掉。
  cmd_stop --quiet
  sleep 0.5

  echo
  # daemon_flag 要么是空的、要么是固定字面量，这里故意不加引号
  if [[ "$mode" == "dev" ]]; then
    cmd_start --dev $daemon_flag
  elif [[ "$mode" == "prod" ]]; then
    cmd_start --prod $daemon_flag
  else
    cmd_start $daemon_flag
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
