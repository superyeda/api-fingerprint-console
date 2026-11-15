#!/usr/bin/env python3
"""Double-click launcher. Opening an existing product never starts a detector."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request
import webbrowser
from installer import install_runtime, safe_directory

ROOT = Path(__file__).resolve().parent
URL = 'http://127.0.0.1:47831'
WINDOWS = sys.platform == 'win32'


def healthy():
    try:
        with urllib.request.urlopen(URL + '/health', timeout=1) as response:
            return json.load(response).get('product') == 'api-fingerprint-console'
    except Exception:
        return False


def node_candidates():
    configured = os.environ.get('NODE_EXECUTABLE')
    if configured:
        return [Path(configured).absolute()]
    candidates = []
    found = shutil.which('node')
    if found:
        candidates.append(Path(found).absolute())
    if WINDOWS:
        for key in ('NVM_SYMLINK', 'NVM_HOME'):
            root = os.environ.get(key)
            if root:
                candidates.append(Path(root) / 'node.exe')
                candidates.extend(sorted(Path(root).glob('v*/node.exe'), reverse=True))
        local = Path(os.environ.get('LOCALAPPDATA') or Path.home() / 'AppData/Local')
        candidates.append(local / 'Programs/nodejs/node.exe')
        for key in ('ProgramFiles', 'ProgramFiles(x86)'):
            if os.environ.get(key):
                candidates.append(Path(os.environ[key]) / 'nodejs/node.exe')
    else:
        candidates.extend(sorted((Path.home() / '.nvm/versions/node').glob('v*/bin/node'), reverse=True))
        candidates.extend([Path('/opt/homebrew/bin/node'), Path('/usr/local/bin/node')])
    return candidates


def command_flags(detached=False):
    if WINDOWS:
        if detached:
            return {'creationflags': getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0x200) | getattr(subprocess, 'DETACHED_PROCESS', 0x8)}
        return {'creationflags': getattr(subprocess, 'CREATE_NO_WINDOW', 0x08000000)}
    return {'start_new_session': True} if detached else {}


def find_node():
    for candidate in node_candidates():
        if not candidate.is_file():
            continue
        try:
            version = subprocess.run([str(candidate), '-p', 'process.versions.node'], capture_output=True, text=True, timeout=10, **command_flags())
            if version.returncode == 0 and int(version.stdout.strip().split('.')[0]) >= 22:
                return str(candidate.absolute())
        except (OSError, ValueError, subprocess.TimeoutExpired):
            continue
    return None


def open_console():
    print('[AFC:READY] ' + URL, flush=True)
    try:
        opened = webbrowser.open(URL)
    except Exception:
        opened = False
    if not opened:
        print('[AFC:BROWSER] 服务已就绪，但未能自动打开浏览器。请复制上方地址手动访问。', flush=True)
    else:
        print('已请求打开浏览器；关闭启动窗口不影响已启用的系统定时任务。', flush=True)


def main():
    os.umask(0o077)
    if healthy():
        open_console()
        return 0
    if sys.version_info < (3, 7):
        print('[AFC:PYTHON_VERSION] 需要 Python 3.7 或更高版本。', flush=True)
        return 1
    node = find_node()
    if not node:
        print('请先安装 Node.js 22 或更高版本，再打开本产品。')
        return 1
    env = dict(os.environ, NODE_EXECUTABLE=node, PYTHON_EXECUTABLE=str(Path(sys.executable).absolute()), PATH=str(Path(node).parent) + os.pathsep + os.environ.get('PATH', ''))
    if not (ROOT / 'node_modules/lmfpd-sdk/package.json').is_file():
        print('首次启动：安装已锁定依赖（不执行安装脚本），需要网络或本机 npm 缓存。')
        candidates = [Path(node).parent / 'node_modules/npm/bin/npm-cli.js', Path(node).parent.parent / 'lib/node_modules/npm/bin/npm-cli.js']
        npm = next((path for path in candidates if path.is_file()), None)
        if npm is None:
            print('未找到 Node.js 自带的 npm，请安装完整的 Node.js 22 或更高版本。')
            return 1
        result = subprocess.run([node, str(npm), 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=str(ROOT), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **command_flags())
        if result.returncode:
            print('依赖安装失败，请检查 Node/npm 和网络。')
            return 1
    print('[AFC:INSTALL] 正在检查并安装公共运行文件；不修改系统任务。', flush=True)
    runtime, data = install_runtime(ROOT)
    env['CONSOLE_DATA_DIR'] = str(data)
    logs = safe_directory(data / 'logs')
    log_path = logs / 'web.log'
    print('[AFC:SERVER_LOG] ' + str(log_path), flush=True)
    if log_path.is_symlink():
        print('日志路径不能是符号链接。')
        return 1
    fd = os.open(str(log_path), os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'ab') as log:
        child = subprocess.Popen([node, str(runtime / 'server.mjs')], cwd=str(runtime), env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, **command_flags(detached=True))
    for _ in range(50):
        if healthy():
            open_console()
            return 0
        if child.poll() is not None:
            break
        time.sleep(0.2)
    print('[AFC:SERVER_FAILED] 控制台未启动；请查看上方 SERVER_LOG 文件。可能是端口、依赖、Windows DPAPI 或文件权限问题，不会自动修改已有服务。', flush=True)
    return 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        print('[AFC:LAUNCH_ERROR] 启动未完成，请结合上方阶段检查完整解压、依赖和文件权限；未输出原始错误或凭据。', flush=True)
        raise SystemExit(1)
