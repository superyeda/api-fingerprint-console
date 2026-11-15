#!/usr/bin/env python3
"""Single-flight OS lock; never delete the lock or retry a worker request."""
import argparse
import errno
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
from contextlib import contextmanager

if sys.platform == 'win32':
    import msvcrt
    fcntl = None
else:
    import fcntl
    msvcrt = None

ROOT = Path(__file__).resolve().parent
WINDOWS = sys.platform == 'win32'
SAFE_ERROR = {'status': 'technical_error', 'reason': '本机执行环境或权限异常；未输出原始错误。'}


def default_data_dir():
    if WINDOWS:
        return Path(os.environ.get('LOCALAPPDATA') or Path.home() / 'AppData/Local') / 'API Fingerprint Console/data'
    if sys.platform == 'darwin':
        return Path.home() / 'Library/Application Support/API Fingerprint Console/data'
    return Path.home() / '.local/share/API Fingerprint Console/data'


def safe_path(path):
    path = Path(path).absolute()
    if any(part.is_symlink() for part in [path, *path.parents]):
        raise ValueError('Unsafe symlink path')
    return path


def node_executable(configured=None):
    configured = configured or os.environ.get('NODE_EXECUTABLE')
    if configured:
        candidate = Path(configured).absolute()
        if candidate.is_file():
            return str(candidate)
        raise RuntimeError('Node unavailable')
    found = shutil.which('node')
    if found:
        return str(Path(found).absolute())
    if not WINDOWS:
        candidates = sorted((Path.home() / '.nvm/versions/node').glob('v*/bin/node'), reverse=True)
        if candidates:
            return str(candidates[0].absolute())
    raise RuntimeError('Node unavailable')


@contextmanager
def open_safe_file(path):
    path = safe_path(path)
    fd = os.open(str(path), os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        current = path.lstat()
        opened = os.fstat(fd)
        if not stat.S_ISREG(current.st_mode) or not stat.S_ISREG(opened.st_mode) or (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
            raise ValueError('Unsafe file')
        safe_path(path)
        yield fd
    finally:
        os.close(fd)


def acquire_lock(fd):
    try:
        if WINDOWS:
            if os.fstat(fd).st_size == 0:
                os.write(fd, b'\0')
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError as error:
        if error.errno in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
            return False
        raise


def emit(output, value):
    print(json.dumps(value, ensure_ascii=False), file=output, flush=True)


def relay_safe(output, stdout, stderr):
    # Worker output is one pretty-printed JSON document, not necessarily JSONL.
    # Parse it as a whole first, while retaining safe legacy JSONL fallback.
    try:
        document = json.loads(stdout or '')
    except (ValueError, TypeError):
        document = None
    if isinstance(document, dict):
        emit(output, document)
        if stderr:
            emit(output, {'status': 'technical_error', 'reason': '执行器报告本机错误；未输出原始错误。'})
        return
    # Never forward raw Node tracebacks or arbitrary non-JSON lines.
    for line in (stdout or '').splitlines():
        try:
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError('Not a result')
        except (ValueError, TypeError):
            emit(output, SAFE_ERROR)
        else:
            emit(output, value)
    if stderr:
        emit(output, {'status': 'technical_error', 'reason': '执行器报告本机错误；未输出原始错误。'})


def run_job(args, data_dir, output):
    try:
        with open_safe_file(data_dir / 'job.lock') as fd:
            if not acquire_lock(fd):
                emit(output, {'status': 'skipped', 'reason': '已有巡检运行，未重复请求。', 'requestsSent': 0})
                return 0
            command = [node_executable(args.node), str(ROOT / 'worker.mjs'), '--scheduled' if args.scheduled else '--manual']
            for flag in ('key', 'endpoint'):
                if getattr(args, flag):
                    command.extend(['--' + flag, getattr(args, flag)])
            env = dict(os.environ, CONSOLE_DATA_DIR=str(data_dir), NODE_EXECUTABLE=command[0])
            child = subprocess.Popen(command, cwd=str(ROOT), env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='replace')
            previous = {}
            def stop(_signal, _frame):
                child.terminate()
            try:
                for signum in (signal.SIGTERM, signal.SIGINT):
                    previous[signum] = signal.signal(signum, stop)
                try:
                    stdout, stderr = child.communicate(timeout=7200)
                except subprocess.TimeoutExpired:
                    child.terminate()
                    try:
                        child.communicate(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.communicate()
                    emit(output, {'status': 'technical_error', 'reason': '整批执行超时，已停止；未重试。'})
                    return 2
                relay_safe(output, stdout, stderr)
                return child.returncode
            finally:
                for signum, handler in previous.items():
                    signal.signal(signum, handler)
    except Exception:
        emit(output, SAFE_ERROR)
        return 2


def main(argv=None):
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--scheduled', action='store_true')
    mode.add_argument('--manual', action='store_true')
    parser.add_argument('--node')
    parser.add_argument('--data-dir')
    parser.add_argument('--key')
    parser.add_argument('--endpoint')
    args = parser.parse_args(argv)
    for value in (args.node, args.data_dir):
        if value and not Path(value).is_absolute():
            emit(sys.stdout, SAFE_ERROR)
            return 2
    data_dir = safe_path(args.data_dir or os.environ.get('CONSOLE_DATA_DIR') or default_data_dir())
    data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if args.scheduled:
        logs = safe_path(data_dir / 'logs')
        logs.mkdir(mode=0o700, parents=True, exist_ok=True)
        with open_safe_file(logs / 'scheduled.log') as fd:
            os.lseek(fd, 0, os.SEEK_END)
            with os.fdopen(os.dup(fd), 'a', encoding='utf-8') as output:
                return run_job(args, data_dir, output)
    return run_job(args, data_dir, sys.stdout)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        emit(sys.stdout, SAFE_ERROR)
        raise SystemExit(2)
