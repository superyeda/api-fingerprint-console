import errno
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

if sys.platform != 'win32':
    import fcntl

import installer
import job
import launch

ROOT = Path(__file__).resolve().parent


class ProductTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='fingerprint-product-test-')
        self.directory = Path(self.temp.name).resolve()

    def tearDown(self):
        exact = Path(self.temp.name).resolve()
        self.assertEqual(exact.parent, Path(tempfile.gettempdir()).resolve())
        self.assertTrue(exact.name.startswith('fingerprint-product-test-'))
        self.temp.cleanup()

    def source(self):
        source = self.directory / 'source'
        source.mkdir()
        for name in installer.FILES:
            content = 'synthetic-public-source'
            if name == 'package.json':
                content = '{"version":"1.0.0"}'
            elif name == 'package-lock.json':
                content = json.dumps({'lockfileVersion': 3, 'packages': {'': {}, 'node_modules/fixture': {'version': '1.0.0'}}})
            (source / name).write_text(content, encoding='utf-8')
        (source / 'public').mkdir()
        for name in ['index.html', 'app.js', 'styles.css', 'not-public-secret.json']:
            (source / 'public' / name).write_text('synthetic public fixture', encoding='utf-8')
        for name in ['fixture', 'unlisted']:
            folder = source / 'node_modules' / name
            folder.mkdir(parents=True)
            (folder / 'index.js').write_text('synthetic dependency fixture', encoding='utf-8')
            (folder / 'LICENSE').write_text('synthetic license', encoding='utf-8')
        (source / 'data').mkdir()
        (source / 'data/vault.json').write_text('SYNTHETIC SECRET DO NOT COPY', encoding='utf-8')
        (source / 'keys').mkdir()
        (source / 'keys/key.json').write_text('SYNTHETIC KEY', encoding='utf-8')
        (source / 'credentials.json').write_text('SYNTHETIC CREDENTIALS', encoding='utf-8')
        return source

    def symlink(self, link, target, directory=False):
        try:
            link.symlink_to(target, target_is_directory=directory)
        except (OSError, NotImplementedError):
            self.skipTest('Symlinks unavailable for this test user')

    def test_installer_is_versioned_idempotent_and_never_copies_credentials(self):
        source = self.source()
        home = self.directory / 'home'
        target, data = installer.install_runtime(source, home, platform='darwin', env={})
        self.assertTrue((target / 'server.mjs').is_file())
        self.assertTrue((target / 'scheduler-windows.mjs').is_file())
        self.assertTrue((target / 'node_modules/fixture/index.js').is_file())
        self.assertTrue((target / 'node_modules/fixture/LICENSE').is_file())
        for name in ['data', 'keys', 'credentials.json', 'node_modules/unlisted', 'public/not-public-secret.json']:
            self.assertFalse((target / name).exists(), name)
        self.assertFalse((data / 'vault.json').exists())
        if os.name != 'nt':
            self.assertEqual(data.stat().st_mode & 0o777, 0o700)
        again, same_data = installer.install_runtime(source, home, platform='darwin', env={})
        self.assertEqual(again, target)
        self.assertEqual(data, same_data)
        self.assertEqual(installer.install_runtime(target, home, platform='darwin', env={}), (target, data))
        (source / 'server.mjs').write_text('updated public fixture', encoding='utf-8')
        updated, shared = installer.install_runtime(source, home, platform='darwin', env={})
        self.assertNotEqual(updated, target)
        self.assertEqual(shared, data)
        self.assertEqual((target / 'server.mjs').read_text(encoding='utf-8'), 'synthetic-public-source')

    def test_installer_windows_localappdata_and_fallback_are_synthetic(self):
        source = self.source()
        local = self.directory / '用户 空格/Local AppData'
        home = self.directory / 'home'
        target, data = installer.install_runtime(source, home, platform='win32', env={'LOCALAPPDATA': str(local)})
        self.assertEqual(data, local / 'API Fingerprint Console/data')
        self.assertEqual(target.parent, data.parent)
        self.assertTrue((target / '启动指纹巡检台.cmd').is_file())
        self.assertEqual(installer.install_runtime(source, home, platform='win32', env={'LOCALAPPDATA': str(local)}), (target, data))
        _, fallback = installer.install_runtime(source, home, platform='windows', env={})
        self.assertEqual(fallback, home / 'AppData/Local/API Fingerprint Console/data')
        _, linux = installer.install_runtime(source, home, platform='linux', env={})
        self.assertEqual(linux, home / '.local/share/API Fingerprint Console/data')

    def test_installer_rejects_symlink_directory(self):
        source = self.source()
        home = self.directory / 'home'
        (home / 'Library/Application Support').mkdir(parents=True)
        external = self.directory / 'external'
        external.mkdir()
        self.symlink(home / 'Library/Application Support/API Fingerprint Console', external, True)
        with self.assertRaises(ValueError):
            installer.install_runtime(source, home, platform='darwin', env={})
        self.assertEqual(list(external.iterdir()), [])

    def test_installer_rejects_source_and_dependency_symlinks(self):
        source = self.source()
        synthetic = self.directory / 'synthetic'
        synthetic.write_text('synthetic public data', encoding='utf-8')
        (source / 'server.mjs').unlink()
        self.symlink(source / 'server.mjs', synthetic)
        with self.assertRaises(ValueError):
            installer.install_runtime(source, self.directory / 'home', platform='darwin', env={})
        (source / 'server.mjs').unlink()
        (source / 'server.mjs').write_text('synthetic public source', encoding='utf-8')
        self.symlink(source / 'node_modules/fixture/link.js', synthetic)
        with self.assertRaises(ValueError):
            installer.install_runtime(source, self.directory / 'home', platform='darwin', env={})

    @unittest.skipIf(sys.platform == 'win32', 'Real POSIX flock test; Windows uses branch mock below')
    def test_os_lock_blocks_duplicate_and_recovers_after_release_without_deletion(self):
        data = self.directory / 'data'
        data.mkdir()
        fake = self.directory / 'fake-node'
        script = 'import json; print(json.dumps({"status":"offline-fixture"}))'
        fake.write_text('#!/bin/sh\nexec ' + shlex.quote(sys.executable) + ' -c ' + shlex.quote(script) + ' "$@"\n', encoding='utf-8')
        fake.chmod(0o700)
        command = [sys.executable, str(ROOT / 'job.py'), '--manual', '--node', str(fake), '--data-dir', str(data)]
        with open(data / 'job.lock', 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = subprocess.run(command, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(json.loads(result.stdout)['status'], 'skipped')
            self.assertEqual(json.loads(result.stdout)['requestsSent'], 0)
        result = subprocess.run(command, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['status'], 'offline-fixture')
        self.assertTrue((data / 'job.lock').exists())
        # Existing environment-only callers remain compatible.
        result = subprocess.run([sys.executable, str(ROOT / 'job.py'), '--manual'], env=dict(os.environ, CONSOLE_DATA_DIR=str(data), NODE_EXECUTABLE=str(fake)), capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)['status'], 'offline-fixture')

    def test_posix_lock_branch_is_nonblocking(self):
        fake_fcntl = SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=Mock())
        with job.open_safe_file(self.directory / 'job.lock') as fd, patch.object(job, 'WINDOWS', False), patch.object(job, 'fcntl', fake_fcntl):
            self.assertTrue(job.acquire_lock(fd))
            fake_fcntl.flock.assert_called_once_with(fd, 2 | 4)
            fake_fcntl.flock.side_effect = BlockingIOError(errno.EAGAIN, 'synthetic contention')
            self.assertFalse(job.acquire_lock(fd))
            fake_fcntl.flock.side_effect = OSError(errno.EIO, 'synthetic environment failure')
            with self.assertRaises(OSError):
                job.acquire_lock(fd)

    def test_windows_lock_initializes_byte_seeks_zero_and_is_nonblocking(self):
        fake_msvcrt = SimpleNamespace(LK_NBLCK=1, locking=Mock())
        lock = self.directory / 'job.lock'
        with job.open_safe_file(lock) as fd, patch.object(job, 'WINDOWS', True), patch.object(job, 'msvcrt', fake_msvcrt):
            self.assertTrue(job.acquire_lock(fd))
            self.assertGreaterEqual(os.fstat(fd).st_size, 1)
            self.assertEqual(os.lseek(fd, 0, os.SEEK_CUR), 0)
            fake_msvcrt.locking.assert_called_once_with(fd, 1, 1)
            os.lseek(fd, 0, os.SEEK_END)
            fake_msvcrt.locking.side_effect = OSError(errno.EACCES, 'synthetic contention')
            self.assertFalse(job.acquire_lock(fd))
            self.assertEqual(os.lseek(fd, 0, os.SEEK_CUR), 0)
        self.assertTrue(lock.is_file())

    def test_windows_lock_contention_skips_without_spawning(self):
        fake_msvcrt = SimpleNamespace(LK_NBLCK=1, locking=Mock(side_effect=OSError(errno.EACCES, 'synthetic contention')))
        output = io.StringIO()
        with patch.object(job, 'WINDOWS', True), patch.object(job, 'msvcrt', fake_msvcrt), patch.object(job.subprocess, 'Popen') as spawned, patch.object(job.sys, 'stdout', output):
            self.assertEqual(job.main(['--manual', '--data-dir', str(self.directory)]), 0)
        self.assertEqual(json.loads(output.getvalue())['requestsSent'], 0)
        spawned.assert_not_called()

    def test_job_rejects_symlink_lock_and_relative_flags(self):
        outside = self.directory / 'synthetic-outside'
        outside.write_text('unchanged', encoding='utf-8')
        data = self.directory / 'data'
        data.mkdir()
        self.symlink(data / 'job.lock', outside)
        output = io.StringIO()
        with patch.object(job.sys, 'stdout', output), patch.object(job.subprocess, 'Popen') as spawned:
            self.assertEqual(job.main(['--data-dir', str(data)]), 2)
            self.assertEqual(job.main(['--node', 'relative-node']), 2)
            self.assertEqual(job.main(['--data-dir', 'relative-data']), 2)
        spawned.assert_not_called()
        self.assertEqual(outside.read_text(encoding='utf-8'), 'unchanged')
        self.assertNotIn('synthetic-outside', output.getvalue())

    def test_scheduled_job_logs_safe_output_without_shell_redirection(self):
        fake = self.directory / 'node'
        fake.write_text('synthetic executable', encoding='utf-8')
        data = self.directory / 'scheduled-data'
        child = Mock(returncode=0)
        child.communicate.return_value = ('{"status":"offline-fixture"}\nRAW_SYNTHETIC_SECRET', 'RAW_SYNTHETIC_STDERR_SECRET')
        output = io.StringIO()
        with patch.object(job.subprocess, 'Popen', return_value=child) as spawned, patch.object(job.sys, 'stdout', output):
            self.assertEqual(job.main(['--scheduled', '--node', str(fake), '--data-dir', str(data)]), 0)
        self.assertEqual(output.getvalue(), '')
        log = (data / 'logs/scheduled.log').read_text(encoding='utf-8')
        self.assertIn('offline-fixture', log)
        self.assertNotIn('RAW_SYNTHETIC', log)
        self.assertIn('--scheduled', spawned.call_args.args[0])
        self.assertNotIn('shell', spawned.call_args.kwargs)
        child.communicate.assert_called_once_with(timeout=7200)

    def test_job_timeout_kills_once_and_never_retries(self):
        fake = self.directory / 'node'
        fake.write_text('synthetic executable', encoding='utf-8')
        child = Mock()
        child.communicate.side_effect = [subprocess.TimeoutExpired('synthetic', 7200), subprocess.TimeoutExpired('synthetic', 5), ('', '')]
        output = io.StringIO()
        with patch.object(job.subprocess, 'Popen', return_value=child) as spawned, patch.object(job.sys, 'stdout', output):
            self.assertEqual(job.main(['--manual', '--node', str(fake), '--data-dir', str(self.directory / 'data')]), 2)
        spawned.assert_called_once()
        child.terminate.assert_called_once()
        child.kill.assert_called_once()
        self.assertIn('未重试', output.getvalue())

    def test_platform_default_data_paths(self):
        with patch.object(job, 'WINDOWS', True), patch.dict(os.environ, {'LOCALAPPDATA': str(self.directory)}, clear=True):
            self.assertEqual(job.default_data_dir(), self.directory / 'API Fingerprint Console/data')
        with patch.object(job, 'WINDOWS', False), patch.object(job.sys, 'platform', 'darwin'), patch.object(job.Path, 'home', return_value=self.directory):
            self.assertEqual(job.default_data_dir(), self.directory / 'Library/Application Support/API Fingerprint Console/data')

    def test_launcher_existing_service_only_opens_ui_and_does_not_spawn_worker(self):
        with patch.object(launch, 'healthy', return_value=True), patch.object(launch.webbrowser, 'open') as opened, patch.object(launch.subprocess, 'Popen') as spawned, patch.object(launch, 'find_node') as find_node, patch.object(launch, 'install_runtime') as installed:
            self.assertEqual(launch.main(), 0)
        opened.assert_called_once_with('http://127.0.0.1:47831')
        spawned.assert_not_called()
        find_node.assert_not_called()
        installed.assert_not_called()

    def launcher_branch(self, windows):
        source = self.directory / 'launcher-source'
        (source / 'node_modules/lmfpd-sdk').mkdir(parents=True)
        (source / 'node_modules/lmfpd-sdk/package.json').write_text('{}', encoding='utf-8')
        node = self.directory / ('node.exe' if windows else 'node')
        node.write_text('synthetic node', encoding='utf-8')
        data = self.directory / 'shared-data'
        runtime = self.directory / 'app-version'
        child = Mock()
        child.poll.return_value = None
        with patch.object(launch, 'WINDOWS', windows), patch.object(launch, 'ROOT', source), patch.object(launch, 'find_node', return_value=str(node)), patch.object(launch, 'healthy', side_effect=[False, True]), patch.object(launch, 'install_runtime', return_value=(runtime, data)) as installed, patch.object(launch.subprocess, 'Popen', return_value=child) as spawned, patch.object(launch.webbrowser, 'open'), patch.object(launch.subprocess, 'run') as ran:
            self.assertEqual(launch.main(), 0)
        installed.assert_called_once_with(source)
        ran.assert_not_called()
        kwargs = spawned.call_args.kwargs
        self.assertEqual(kwargs['env']['NODE_EXECUTABLE'], str(node))
        self.assertEqual(kwargs['env']['PYTHON_EXECUTABLE'], str(Path(sys.executable).absolute()))
        self.assertEqual(kwargs['env']['CONSOLE_DATA_DIR'], str(data))
        self.assertEqual(spawned.call_args.args[0], [str(node), str(runtime / 'server.mjs')])
        if windows:
            self.assertNotIn('start_new_session', kwargs)
            self.assertEqual(kwargs['creationflags'], 0x200 | 0x8)
        else:
            self.assertTrue(kwargs['start_new_session'])
            self.assertNotIn('creationflags', kwargs)

    def test_launcher_windows_branch_is_mocked_not_a_real_service(self):
        self.launcher_branch(True)

    def test_launcher_posix_branch_is_mocked_not_a_real_service(self):
        self.launcher_branch(False)

    def test_launcher_windows_nvm_candidates_and_node22_check(self):
        nvm = self.directory / 'nvm 用户'
        node = nvm / 'v22.1.0/node.exe'
        node.parent.mkdir(parents=True)
        node.write_text('synthetic node', encoding='utf-8')
        with patch.object(launch, 'WINDOWS', True), patch.dict(os.environ, {'NVM_HOME': str(nvm)}, clear=True), patch.object(launch.shutil, 'which', return_value=None), patch.object(launch.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='22.1.0\n')) as ran:
            self.assertEqual(launch.find_node(), str(node))
            self.assertIn('creationflags', ran.call_args.kwargs)
            self.assertNotIn('start_new_session', ran.call_args.kwargs)
        with patch.object(launch, 'node_candidates', return_value=[node]), patch.object(launch.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='20.0.0\n')):
            self.assertIsNone(launch.find_node())

    def test_pretty_printed_worker_json_is_forwarded_as_one_safe_document(self):
        payload = {'status': 'batch', 'results': [{'alias': 'mqs', 'status': 'match'}]}
        output = io.StringIO()
        job.relay_safe(output, json.dumps(payload, indent=2), '')
        self.assertEqual(json.loads(output.getvalue()), payload)
        self.assertEqual(len(output.getvalue().splitlines()), 1)

    def test_windows_cmd_has_ascii_crlf_no_bom_and_an_unconditional_pause(self):
        raw = (ROOT / '启动指纹巡检台.cmd').read_bytes()
        raw.decode('ascii')
        self.assertNotIn(b'\n', raw.replace(b'\r\n', b''))
        self.assertGreater(raw.count(b'\r\n'), 20)
        self.assertFalse(raw.startswith(b'\xef\xbb\xbf'))
        self.assertIn(b'print(sys.version_info.major)', raw)
        self.assertIn(b'set "AFC_EXIT_CODE=%ERRORLEVEL%"\r\ngoto finished', raw)
        self.assertIn(b'\r\npause >nul\r\n', raw)
        self.assertIn(b'endlocal & exit /b %AFC_EXIT_CODE%', raw)
        self.assertNotIn(b'chcp ', raw)
        self.assertNotIn(b'if not errorlevel 1 (', raw)

    def test_missing_required_dependency_cannot_produce_a_broken_successful_runtime(self):
        source = self.source()
        lock_path = source / 'package-lock.json'
        lock = json.loads(lock_path.read_text(encoding='utf-8'))
        lock['packages']['node_modules/missing-required'] = {'version': '1.0.0'}
        lock_path.write_text(json.dumps(lock), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Required dependency'):
            installer.install_runtime(source, self.directory / 'home', platform='win32', env={})
        lock['packages']['node_modules/missing-required']['optional'] = True
        lock_path.write_text(json.dumps(lock), encoding='utf-8')
        installed, _ = installer.install_runtime(source, self.directory / 'home', platform='win32', env={})
        self.assertTrue((installed / 'server.mjs').is_file())

    def test_ready_service_with_no_browser_shows_manual_url_without_starting_another_service(self):
        output = io.StringIO()
        with patch.object(launch, 'healthy', return_value=True), patch.object(launch.webbrowser, 'open', return_value=False), patch.object(launch.subprocess, 'Popen') as spawned, patch.object(launch.sys, 'stdout', output):
            self.assertEqual(launch.main(), 0)
        self.assertIn('[AFC:READY]', output.getvalue())
        self.assertIn('[AFC:BROWSER]', output.getvalue())
        self.assertIn(launch.URL, output.getvalue())
        self.assertNotIn('控制台已打开', output.getvalue())
        spawned.assert_not_called()

    def test_browser_open_exception_is_not_reported_as_a_server_failure_or_raw_error(self):
        output = io.StringIO()
        with patch.object(launch, 'healthy', return_value=True), patch.object(launch.webbrowser, 'open', side_effect=OSError('PRIVATE_SYNTHETIC_VALUE')), patch.object(launch.sys, 'stdout', output):
            self.assertEqual(launch.main(), 0)
        self.assertIn('[AFC:BROWSER]', output.getvalue())
        self.assertNotIn('PRIVATE_SYNTHETIC_VALUE', output.getvalue())

    def test_older_python_is_rejected_before_capture_output_is_used(self):
        output = io.StringIO()
        with patch.object(launch, 'healthy', return_value=False), patch.object(launch.sys, 'version_info', (3, 6, 15)), patch.object(launch, 'find_node') as find_node, patch.object(launch.sys, 'stdout', output):
            self.assertEqual(launch.main(), 1)
        find_node.assert_not_called()
        self.assertIn('[AFC:PYTHON_VERSION]', output.getvalue())

    def test_failed_server_start_shows_safe_log_location_without_retry(self):
        source = self.directory / 'launcher-source'
        sdk = source / 'node_modules/lmfpd-sdk'
        sdk.mkdir(parents=True)
        (sdk / 'package.json').write_text('{}', encoding='utf-8')
        data = self.directory / 'data'
        node = self.directory / 'node.exe'
        child = Mock()
        child.poll.return_value = 4
        output = io.StringIO()
        with patch.object(launch, 'ROOT', source), patch.object(launch, 'healthy', return_value=False), patch.object(launch, 'find_node', return_value=str(node)), patch.object(launch, 'install_runtime', return_value=(self.directory / 'runtime', data)), patch.object(launch.subprocess, 'Popen', return_value=child) as spawned, patch.object(launch.sys, 'stdout', output), patch.object(launch.time, 'sleep') as slept:
            self.assertEqual(launch.main(), 1)
        self.assertIn('[AFC:SERVER_FAILED]', output.getvalue())
        self.assertIn('[AFC:SERVER_LOG]', output.getvalue())
        self.assertIn(str(data / 'logs/web.log'), output.getvalue())
        spawned.assert_called_once()
        slept.assert_not_called()


if __name__ == '__main__':
    unittest.main()
