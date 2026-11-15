@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "PYTHONUTF8=1"
set "AFC_EXIT_CODE=1"
set "AFC_PUSHED="
echo API Fingerprint Console - Windows launcher
echo Opening the console does not run model detection.
echo.
pushd "%~dp0" >nul 2>&1
if errorlevel 1 goto directory_failed
set "AFC_PUSHED=1"
if not exist "launch.py" goto missing_files
if not exist "installer.py" goto missing_files
if not exist "server.mjs" goto missing_files
if not exist "package.json" goto missing_files
set "AFC_PYTHON3="
for /f "delims=" %%P in ('py.exe -3 -c "import sys; print(sys.version_info.major)" 2^>nul') do if "%%P"=="3" set "AFC_PYTHON3=py"
if defined AFC_PYTHON3 goto run_py
for /f "delims=" %%P in ('python.exe -c "import sys; print(sys.version_info.major)" 2^>nul') do if "%%P"=="3" set "AFC_PYTHON3=python"
if defined AFC_PYTHON3 goto run_python
goto missing_python

:run_py
echo [AFC:PYTHON] Using py.exe -3
py.exe -3 "launch.py"
set "AFC_EXIT_CODE=%ERRORLEVEL%"
goto finished

:run_python
echo [AFC:PYTHON] Using python.exe
python.exe "launch.py"
set "AFC_EXIT_CODE=%ERRORLEVEL%"
goto finished

:missing_python
echo [AFC:NO_PYTHON] A working Python 3 interpreter was not found.
echo Install Python 3 and reopen this file. Store aliases alone are not enough.
echo Official download: https://www.python.org/downloads/windows/
goto finished

:missing_files
echo [AFC:INCOMPLETE_PACKAGE] Required application files are missing.
echo Extract the ENTIRE ZIP into a normal folder first.
echo Do not run this file from inside the ZIP preview.
goto finished

:directory_failed
echo [AFC:DIRECTORY] Cannot access the extracted application folder.
echo Move the complete extracted folder to a writable local directory.

:finished
echo.
if "%AFC_EXIT_CODE%"=="0" echo Console address: http://127.0.0.1:47831
if not "%AFC_EXIT_CODE%"=="0" echo [AFC:FAILED] Startup did not finish. Copy the error messages above.
echo Closing this window does not disable an existing scheduled task.
echo Press any key to close this launcher window.
pause >nul
if defined AFC_PUSHED popd >nul 2>&1
endlocal & exit /b %AFC_EXIT_CODE%
