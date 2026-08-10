@echo off
chcp 65001 >nul
title 去水印视频工具 - 控制台
cd /d F:\去水印视频工具\server

:menu
cls
echo ============================================
echo    去水印视频工具 - 管理控制台
echo ============================================
echo.
echo  [1] 一键自检     - 检查所有服务状态
echo  [2] 一键修复     - 修复常见问题
echo  [3] 一键启动     - 启动所有服务
echo  [4] 一键配置     - 打开配置
echo  [5] 查看日志     - 查看运行日志
echo  [0] 退出
echo.
set /p choice="请选择 (0-5): "

if "%choice%"=="1" goto check
if "%choice%"=="2" goto fix
if "%choice%"=="3" goto start
if "%choice%"=="4" goto config
if "%choice%"=="5" goto logs
if "%choice%"=="0" exit /b
goto menu

:: ============================================
::  一键自检
:: ============================================
:check
cls
echo ═══════════════════════════════════════════
echo   🔍 一键自检中...
echo ═══════════════════════════════════════════
echo.

:: 1. 检查本地服务器
echo [1/4] 检查本地服务器 (localhost:8800)...
curl -s --connect-timeout 5 http://localhost:8800/api/health >nul 2>&1
if %errorlevel% equ 0 (
    echo   ✅ 本地服务器运行正常
) else (
    echo   ❌ 本地服务器未运行
)
echo.

:: 2. 检查 PM2 进程
echo [2/4] 检查 PM2 进程...
pm2 list 2>&1 | findstr "watermark-server" >nul
if %errorlevel% equ 0 (
    for /f "tokens=*" %%a in ('pm2 list 2^>^&1 ^| findstr "watermark-server"') do echo   %%a
    echo   ✅ PM2 进程运行中
) else (
    echo   ❌ PM2 进程未运行
)
echo.

:: 3. 检查 cloudflared 隧道
echo [3/4] 检查 Cloudflare 隧道...
sc query cloudflared 2>&1 | findstr "RUNNING" >nul
if %errorlevel% equ 0 (
    echo   ✅ Cloudflare 隧道服务运行中
) else (
    echo   ❌ Cloudflare 隧道服务未运行
)
echo.

:: 4. 检查外网访问
echo [4/4] 检查外网访问 (api.hcxserver.xyz)...
curl -s --connect-timeout 10 https://api.hcxserver.xyz/api/health >nul 2>&1
if %errorlevel% equ 0 (
    echo   ✅ 外网访问正常
) else (
    echo   ❌ 外网无法访问，可能是隧道问题
)
echo.
echo ═══════════════════════════════════════════
echo  自检完成
echo ═══════════════════════════════════════════
echo.
echo 按任意键返回菜单...
pause >nul
goto menu

:: ============================================
::  一键修复
:: ============================================
:fix
cls
echo ═══════════════════════════════════════════
echo   🔧 一键修复中...
echo ═══════════════════════════════════════════
echo.

:: 1. 修复端口占用
echo [1/5] 检查端口 8800 占用...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8800 " ^| findstr LISTENING') do (
    set PID=%%a
    echo   发现进程 PID=%%a 占用端口 8800
)
if not "%PID%"=="" (
    echo   尝试正常关闭进程...
    pm2 stop watermark-server >nul 2>&1
    timeout /t 2 /nobreak >nul
    netstat -ano | findstr ":8800 " | findstr LISTENING >nul
    if %errorlevel% equ 0 (
        echo   强制终止进程...
        for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8800 " ^| findstr LISTENING') do (
            taskkill /F /PID %%a >nul 2>&1
        )
        timeout /t 2 /nobreak >nul
    )
    echo   ✅ 端口已释放
) else (
    echo   ✅ 端口未被占用
)
echo.

:: 2. 重启服务器
echo [2/5] 启动服务器...
cd /d F:\去水印视频工具\server
pm2 start src/index.js --name "watermark-server" >nul 2>&1
timeout /t 3 /nobreak >nul
curl -s --connect-timeout 5 http://localhost:8800/api/health >nul 2>&1
if %errorlevel% equ 0 (
    echo   ✅ 服务器启动成功
) else (
    echo   ❌ 服务器启动失败，尝试直接启动...
    start /B node src/index.js >nul 2>&1
    timeout /t 3 /nobreak >nul
)
echo.

:: 3. 修复 cloudflared 隧道
echo [3/5] 检查 Cloudflare 隧道...
sc query cloudflared 2>&1 | findstr "RUNNING" >nul
if %errorlevel% neq 0 (
    echo   隧道未运行，尝试启动...
    net start cloudflared >nul 2>&1
    timeout /t 3 /nobreak >nul
    sc query cloudflared 2>&1 | findstr "RUNNING" >nul
    if %errorlevel% equ 0 (
        echo   ✅ 隧道已启动
    ) else (
        echo   ❌ 隧道启动失败，请检查 cloudflared 服务
    )
) else (
    echo   ✅ 隧道服务已在运行
)
echo.

:: 4. 保存 PM2 配置
echo [4/5] 保存 PM2 进程列表...
pm2 save >nul 2>&1
echo   ✅ 已保存
echo.

:: 5. 验证外网
echo [5/5] 验证外网访问...
timeout /t 3 /nobreak >nul
curl -s --connect-timeout 10 https://api.hcxserver.xyz/api/health >nul 2>&1
if %errorlevel% equ 0 (
    echo   ✅ 外网访问正常
) else (
    echo   ⚠️ 外网暂时无法访问，可能需要等待隧道连接
)
echo.
echo ═══════════════════════════════════════════
echo  修复完成
echo ═══════════════════════════════════════════
echo.
echo 按任意键返回菜单...
pause >nul
goto menu

:: ============================================
::  一键启动
:: ============================================
:start
cls
echo ═══════════════════════════════════════════
echo   🚀 一键启动中...
echo ═══════════════════════════════════════════
echo.

:: 1. 启动服务器
echo [1/3] 启动本地服务器...
cd /d F:\去水印视频工具\server
pm2 start src/index.js --name "watermark-server" >nul 2>&1
timeout /t 3 /nobreak >nul
curl -s --connect-timeout 5 http://localhost:8800/api/health >nul 2>&1
if %errorlevel% equ 0 (
    echo   ✅ 本地服务器运行正常
) else (
    echo   ❌ 启动失败，尝试直接启动...
    start /B node src/index.js
    timeout /t 3 /nobreak >nul
)
echo.

:: 2. 启动隧道
echo [2/3] 启动 Cloudflare 隧道...
sc query cloudflared 2>&1 | findstr "RUNNING" >nul
if %errorlevel% neq 0 (
    net start cloudflared >nul 2>&1
    timeout /t 3 /nobreak >nul
)
sc query cloudflared 2>&1 | findstr "RUNNING" >nul
if %errorlevel% equ 0 (
    echo   ✅ 隧道服务运行中
) else (
    echo   ❌ 隧道启动失败
)
echo.

:: 3. 验证
echo [3/3] 验证外网访问...
timeout /t 5 /nobreak >nul
curl -s --connect-timeout 10 https://api.hcxserver.xyz/api/health >nul 2>&1
if %errorlevel% equ 0 (
    echo   ✅ 所有服务正常运行，外网可访问！
) else (
    echo   ⚠️ 服务器已启动，外网可能还需要等待
)
echo.
pm2 save >nul 2>&1
echo.
echo ═══════════════════════════════════════════
echo  启动完成
echo ═══════════════════════════════════════════
echo.
echo 按任意键返回菜单...
pause >nul
goto menu

:: ============================================
::  一键配置
:: ============================================
:config
cls
echo ═══════════════════════════════════════════
echo   ⚙️ 配置
echo ═══════════════════════════════════════════
echo.
echo  [1] 编辑服务器配置 (.env)
echo  [2] 查看当前配置
echo  [3] 打开服务器目录
echo  [0] 返回菜单
echo.
set /p cfg="请选择 (0-3): "

if "%cfg%"=="1" goto edit_env
if "%cfg%"=="2" goto show_config
if "%cfg%"=="3" goto open_dir
goto menu

:edit_env
echo 正在打开 .env 文件...
start notepad "F:\去水印视频工具\server\.env"
echo.
echo 按任意键返回菜单...
pause >nul
goto config

:show_config
echo.
echo ─── 服务器配置 ───
type "F:\去水印视频工具\server\.env" 2>nul
if %errorlevel% neq 0 echo   (未找到 .env 文件)
echo.
echo ─── PM2 进程 ───
pm2 list 2>&1
echo.
echo ─── 快捷方式 ───
echo   桌面快捷方式: 去水印视频工具 - 控制台
echo   服务器目录: F:\去水印视频工具\server
echo   小程序目录: F:\去水印视频工具\miniprogram
echo.
echo 按任意键返回菜单...
pause >nul
goto config

:open_dir
start explorer "F:\去水印视频工具"
goto config

:: ============================================
::  查看日志
:: ============================================
:logs
cls
echo ═══════════════════════════════════════════
echo   📋 日志
echo ═══════════════════════════════════════════
echo.
echo  [1] 查看最近日志 (最近30行)
echo  [2] 实时监控日志 (Ctrl+C 退出)
echo  [3] 查看错误日志
echo  [0] 返回菜单
echo.
set /p log="请选择 (0-3): "

if "%log%"=="1" goto show_logs
if "%log%"=="2" goto tail_logs
if "%log%"=="3" goto err_logs
goto menu

:show_logs
echo.
echo ─── 最近 30 行日志 ───
type "C:\Users\Administrator\.pm2\logs\watermark-server-out.log" 2>nul | findstr /n "." | findstr /r "^[0-9]*:" | more
echo.
echo 按任意键返回菜单...
pause >nul
goto logs

:tail_logs
echo 实时日志 (Ctrl+C 退出)...
echo.
pm2 logs watermark-server --lines 20
echo.
pause
goto logs

:err_logs
echo.
echo ─── 错误日志 ───
type "C:\Users\Administrator\.pm2\logs\watermark-server-error.log" 2>nul
echo.
echo 按任意键返回菜单...
pause >nul
goto logs