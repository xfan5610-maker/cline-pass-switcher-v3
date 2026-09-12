#!/data/data/com.termux/files/usr/bin/bash
set -Eeuo pipefail

REPO_URL="https://github.com/xfan5610-maker/cline-pass-switcher-v3.git"
APP_DIR="${CLINE_PASS_DIR:-$HOME/cline-pass-switcher-v3}"
APP_NAME="${CLINE_PASS_APP_NAME:-cline-pass-v3}"

PORT="${PORT:-3123}"
BIND_HOST="${BIND_HOST:-0.0.0.0}"
STREAM_IDLE_TIMEOUT_MS="${STREAM_IDLE_TIMEOUT_MS:-90000}"

CURRENT_STEP="初始化"

on_error() {
  local code=$?
  echo
  echo "======================================"
  echo " Cline Pass Switcher 部署失败"
  echo "======================================"
  echo "步骤：$CURRENT_STEP"
  echo "退出码：$code"
  echo "PREFIX=${PREFIX:-未设置}"
  echo "PATH=$PATH"
  echo "Node.js=$(command -v node >/dev/null 2>&1 && node --version || echo 未找到)"
  echo "npm=$(command -v npm >/dev/null 2>&1 && npm --version || echo 未找到)"
  echo "PM2=$(command -v pm2 >/dev/null 2>&1 && pm2 --version || echo 未找到)"
  echo "npm prefix=$(command -v npm >/dev/null 2>&1 && npm prefix -g 2>/dev/null || echo 未知)"
  echo
  exit "$code"
}

trap on_error ERR

echo
echo "======================================"
echo " Cline Pass Switcher - Termux 一键部署"
echo "======================================"
echo

CURRENT_STEP="检查 Termux 环境"
echo "[0/7] 检查 Termux 环境..."

if [ -z "${PREFIX:-}" ] || [ ! -d "$PREFIX" ] || ! command -v pkg >/dev/null 2>&1; then
  echo "错误：未检测到有效的 Termux 环境。"
  exit 1
fi

export PATH="$PREFIX/bin:$PATH"
hash -r

if ! apt-get check >/dev/null 2>&1; then
  echo "错误：检测到 Termux 软件包依赖异常。"
  echo
  echo "请先执行："
  echo "  apt update"
  echo "  apt full-upgrade -y"
  exit 1
fi

DPKG_AUDIT="$(dpkg --audit 2>/dev/null || true)"
if [ -n "$DPKG_AUDIT" ]; then
  echo "错误：检测到未完成的软件包配置："
  echo "$DPKG_AUDIT"
  echo
  echo "请先执行："
  echo "  dpkg --configure -a"
  echo "  apt full-upgrade -y"
  exit 1
fi

echo "Termux 环境检查通过：PREFIX=$PREFIX"
echo
echo "[1/7] 检查 Git 和 Node.js..."

CURRENT_STEP="检查 / 安装 Git"

if ! command -v git >/dev/null 2>&1; then
  echo "未检测到 Git，正在安装..."
  pkg install -y git
  hash -r
fi

if ! command -v git >/dev/null 2>&1; then
  echo "错误：Git 安装后仍无法执行。"
  exit 1
fi
echo "Git：$(git --version)"

CURRENT_STEP="检查 / 安装 Node.js"

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
else
  NODE_MAJOR=0
fi

if [ "$NODE_MAJOR" -lt 18 ]; then
  if [ "$NODE_MAJOR" -eq 0 ]; then
    echo "未检测到 Node.js，正在安装..."
  else
    echo "Node.js 版本低于 18，正在升级..."
  fi

  if ! pkg install -y nodejs-lts; then
    pkg install -y nodejs
  fi
  hash -r
fi

if ! command -v node >/dev/null 2>&1; then
  echo "错误：Node.js 安装后仍无法执行。"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "错误：Node.js 版本仍低于 18：$(node --version)"
  exit 1
fi
echo "Node.js：$(node --version)"

CURRENT_STEP="检查 / 安装 npm"

if ! command -v npm >/dev/null 2>&1; then
  echo "未检测到 npm，正在安装..."
  pkg install -y npm
  hash -r
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "错误：npm 安装后仍无法执行。"
  exit 1
fi
echo "npm：$(npm --version)"

echo
echo "[2/7] 检查 PM2..."
CURRENT_STEP="检查 / 安装 PM2"

export PATH="$PREFIX/bin:$PATH"
hash -r

if ! command -v pm2 >/dev/null 2>&1; then
  echo "未检测到 PM2，正在安装到 Termux PREFIX..."
  npm install -g --prefix "$PREFIX" pm2
  hash -r
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "错误：PM2 安装后仍无法在 PATH 中找到。"
  echo "PREFIX=$PREFIX"
  echo "PATH=$PATH"
  echo "npm prefix -g=$(npm prefix -g 2>/dev/null || echo 未知)"
  exit 1
fi

if ! pm2 --version >/dev/null 2>&1; then
  echo "错误：已找到 PM2，但 PM2 无法正常执行。"
  exit 1
fi

echo "PM2：$(pm2 --version)"

echo
echo "[3/7] 获取项目..."
CURRENT_STEP="拉取项目"

if [ -d "$APP_DIR/.git" ]; then
  echo "检测到已有项目，尝试更新..."
  git -C "$APP_DIR" pull --ff-only
elif [ -e "$APP_DIR" ]; then
  echo "错误：$APP_DIR 已存在，但不是 Git 仓库。"
  echo "请先移动或删除该目录后重新运行。"
  exit 1
else
  git clone "$REPO_URL" "$APP_DIR"
fi

echo
echo "[4/7] 检查程序..."
CURRENT_STEP="检查 server-v3.js"

cd "$APP_DIR"
node --check server-v3.js

echo
echo "[5/7] 启动服务..."
CURRENT_STEP="启动 PM2 服务"

if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  echo "检测到已有 PM2 服务，保留原有环境变量并重启..."
  PORT="$PORT" \
  BIND_HOST="$BIND_HOST" \
  STREAM_IDLE_TIMEOUT_MS="$STREAM_IDLE_TIMEOUT_MS" \
  pm2 restart "$APP_NAME" --update-env >/dev/null
else
  PORT="$PORT" \
  BIND_HOST="$BIND_HOST" \
  STREAM_IDLE_TIMEOUT_MS="$STREAM_IDLE_TIMEOUT_MS" \
  pm2 start server-v3.js --name "$APP_NAME" --time
fi

sleep 2

APP_STATUS="$(pm2 jlist | node -e '
let data = "";
process.stdin.on("data", c => data += c);
process.stdin.on("end", () => {
  const name = process.argv[1];
  try {
    const list = JSON.parse(data);
    const app = list.find(x => x.name === name);
    process.stdout.write(app?.pm2_env?.status || "");
  } catch {
    process.exit(2);
  }
});
' "$APP_NAME")"

if [ "$APP_STATUS" != "online" ]; then
  echo "错误：服务启动后状态不是 online，当前状态：${APP_STATUS:-未知}"
  echo
  echo "最近日志："
  pm2 logs "$APP_NAME" --lines 30 --nostream || true
  exit 1
fi

echo "服务状态：online"

echo
echo "[6/7] 保存 PM2 进程列表..."
CURRENT_STEP="保存 PM2 进程列表"
pm2 save >/dev/null

echo
echo "[7/7] 完成"
CURRENT_STEP="部署完成"

echo
echo "--------------------------------------"
echo "安装目录：$APP_DIR"
echo "管理面板：http://127.0.0.1:$PORT/"
echo
echo "常用命令："
echo "  pm2 ls"
echo "  pm2 logs $APP_NAME"
echo "  pm2 restart $APP_NAME"
echo "  pm2 stop $APP_NAME"
echo "  pm2 resurrect"
echo "--------------------------------------"
echo

pm2 ls
