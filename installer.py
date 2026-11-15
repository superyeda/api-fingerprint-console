"""Install immutable public runtimes; mutable data and credentials stay separate."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sys
import uuid

FILES = ['package.json', 'package-lock.json', 'store.mjs', 'runner.mjs', 'server.mjs',
         'scheduler.mjs', 'scheduler-mac.mjs', 'scheduler-windows.mjs',
         'platform.mjs', 'notification-config.mjs', 'credentials.mjs',
         'notify.mjs', 'worker.mjs', 'job.py', 'launch.py', 'installer.py',
         '启动指纹巡检台.command', '启动指纹巡检台.cmd']
PUBLIC_FILES = ['public/index.html', 'public/app.js', 'public/styles.css']


def safe_directory(path):
    path = Path(path).absolute()
    for parent in [*reversed(path.parents), path]:
        if parent.is_symlink():
            raise ValueError('Symlink directory is not permitted')
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path, 0o700)
    return path


def public_file(source, name):
    file = source / name
    for part in [file, *file.parents]:
        if part.is_symlink():
            raise ValueError('Unsafe source symlink')
        if part == source:
            break
    if not file.is_file():
        raise ValueError('Missing public source file')
    return file


def dependency_paths(source):
    """Only package-lock-listed dependency directories, never arbitrary root data."""
    lock = json.loads(public_file(source, 'package-lock.json').read_text(encoding='utf-8'))
    packages = lock.get('packages')
    if not isinstance(packages, dict):
        raise ValueError('A modern package lock with packages is required')
    for name, metadata in sorted(packages.items()):
        if not name:
            continue
        parts = PurePosixPath(name).parts
        if '\\' in name or not parts or parts[0] != 'node_modules' or any(part in ('.', '..') for part in parts) or PurePosixPath(name).is_absolute():
            raise ValueError('Unsafe dependency path')
        if not isinstance(metadata, dict) or metadata.get('link'):
            raise ValueError('Linked dependency is not permitted')
        folder = source.joinpath(*parts)
        # Optional dependencies for other operating systems can be absent.
        for part in [folder, *folder.parents]:
            if part.is_symlink():
                raise ValueError('Unsafe dependency symlink')
            if part == source:
                break
        if folder.exists():
            if not folder.is_dir():
                raise ValueError('Invalid dependency directory')
            yield name, folder
        elif not metadata.get('optional'):
            raise ValueError('Required dependency is missing; extract the complete package or install locked dependencies')


def copy_dependency(source, destination):
    for directory, directories, filenames in os.walk(source, followlinks=False):
        current = Path(directory)
        if current.is_symlink():
            raise ValueError('Unsafe dependency symlink')
        # Nested packages are copied separately from the lock's own whitelist.
        directories[:] = [name for name in directories if name not in ('node_modules', '.bin')]
        for name in directories:
            if (current / name).is_symlink():
                raise ValueError('Unsafe dependency symlink')
        target = destination / current.relative_to(source)
        target.mkdir(parents=True, exist_ok=True, mode=0o700)
        for name in filenames:
            file = public_file(source, str((current / name).relative_to(source)))
            shutil.copy2(file, target / name)
            os.chmod(target / name, 0o600)


def install_runtime(source, home=None, platform=None, env=None):
    source = Path(source).absolute()
    if source.is_symlink():
        raise ValueError('Unsafe source directory')
    environment = os.environ if env is None else env
    system = sys.platform if platform is None else platform
    user_home = Path(home) if home is not None else Path.home()
    if system in ('win32', 'windows', 'win'):
        parent = Path(environment.get('LOCALAPPDATA') or user_home / 'AppData/Local')
    elif system in ('darwin', 'mac', 'macos'):
        parent = user_home / 'Library/Application Support'
    else:
        parent = Path(environment.get('XDG_DATA_HOME') or user_home / '.local/share')
    if not parent.is_absolute():
        raise ValueError('Application data root must be absolute')
    base = safe_directory(parent / 'API Fingerprint Console')
    data = safe_directory(base / 'data')
    marker = source / '.runtime.json'
    if marker.is_file() and not marker.is_symlink() and source.parent == base:
        return source, data
    digest = hashlib.sha256()
    for name in FILES + PUBLIC_FILES:
        file = public_file(source, name)
        digest.update(name.encode('utf-8'))
        digest.update(file.read_bytes())
    dependencies = list(dependency_paths(source))
    version = json.loads(public_file(source, 'package.json').read_text(encoding='utf-8'))['version']
    if not isinstance(version, str) or not version or any(c not in '0123456789.-' for c in version):
        raise ValueError('Invalid version')
    target = base / ('app-' + version + '-' + digest.hexdigest()[:12])
    if target.is_symlink() or (target / '.runtime.json').is_symlink():
        raise ValueError('Unsafe target')
    if (target / '.runtime.json').is_file():
        return target, data
    if target.exists():
        raise ValueError('Incomplete existing runtime; will not overwrite')
    staging = base / ('.staging-' + uuid.uuid4().hex)
    staging.mkdir(mode=0o700)
    for name in FILES + PUBLIC_FILES:
        destination = staging / name
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copy2(public_file(source, name), destination)
        os.chmod(destination, 0o600)
    for name, folder in dependencies:
        copy_dependency(folder, staging / name)
    (staging / '.runtime.json').write_text(json.dumps({'version': version, 'sourceDigest': digest.hexdigest()}), encoding='utf-8')
    os.chmod(staging / '.runtime.json', 0o600)
    os.chmod(staging / '启动指纹巡检台.command', 0o700)
    # Both exact absolute paths are constrained before the single atomic move.
    if staging.parent != base or target.parent != base or not staging.name.startswith('.staging-') or not target.name.startswith('app-'):
        raise ValueError('Unsafe installation move')
    os.rename(staging, target)
    return target, data
