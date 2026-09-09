#!/data/data/com.termux/files/usr/bin/bash
set -Eeuo pipefail

REPO_URL="https://github.com/xfan5610-maker/cline-pass-switcher-v3.git"
APP_DIR="${CLINE_PASS_DIR:-$HOME/cline-pass-switcher-v3}"
APP_NAME="${CLINE_PASS_APP_NAME:-cline-pass-v3}"

PORT="${PORT:-3123}"
BIND_HOST="${BIND_HOST:-0.0.0.0}"
STREAM_IDLE_TIMEOUT_MS="${STREAM_IDLE_TIMEOUT_MS:-90000}"

echo
echo "======================================"
echo " Cline Pass Switcher - Termux 一键部署"
echo "======================================"
echo

if ! command -v pkg >/dev/null 2>&1; then
  echo "错误：此安装脚本仅适用于 Termux。"
  exit 1
fi

echo "[1/6] 检查 Git 和 Node.js..."

if ! command -v git >/dev/null 2>&1; then
  echo "未检测到 Git，正在安装..."
  pkg install -y git
else
  echo "Git 已安装：$(git --version)"
fi

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAJOR" -ge 18 ]; then
    echo "Node.js 已安装：$(node --version)，无需修改。"
  else
    echo "Node.js 版本低于 18，正在升级..."
    pkg install -y nodejs-lts 2>/dev/null || pkg install -y nodejs
  fi
else
  echo "未检测到 Node.js，正在安装..."
  pkg install -y nodejs-lts 2>/dev/null || pkg install -y nodejs
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "未检测到 npm，正在安装..."
  pkg install -y npm
fi

echo
echo "[2/6] 检查 PM2..."
if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2
fi

echo
echo "[3/6] 获取项目..."
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
echo "[4/6] 检查程序..."
cd "$APP_DIR"
node --check server-v3.js

echo
echo "[5/6] 启动服务..."
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  echo "检测到已有 PM2 服务，重新绑定到当前安装目录..."
  pm2 delete "$APP_NAME" >/dev/null
fi

PORT="$PORT" \
BIND_HOST="$BIND_HOST" \
STREAM_IDLE_TIMEOUT_MS="$STREAM_IDLE_TIMEOUT_MS" \
pm2 start server-v3.js --name "$APP_NAME" --time

pm2 save >/dev/null

echo
echo "[6/6] 完成"
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
