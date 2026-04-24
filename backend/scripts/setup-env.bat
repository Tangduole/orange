@echo off
chcp 65001 >nul
echo.
echo 🔧 Orange 环境变量配置助手
echo ================================
echo.

cd /d "%~dp0.."

if exist .env (
    echo ⚠️  警告：.env 文件已存在！
    set /p backup="是否要备份并重新创建？(y/N): "
    if /i "%backup%"=="y" (
        copy .env .env.backup.%date:~0,4%%date:~5,2%%date:~8,2%_%time:~0,2%%time:~3,2%%time:~6,2% >nul
        echo ✅ 已备份
        echo.
    ) else (
        echo ❌ 已取消
        pause
        exit /b
    )
)

echo 📝 开始配置...
echo.
echo 📋 请选择配置模式：
echo 1. 最小配置（仅核心功能）
echo 2. 完整配置（包含所有API密钥）
echo 3. 从模板复制（手动编辑）
echo.

set /p mode="请选择 (1/2/3): "

if "%mode%"=="1" goto minimal
if "%mode%"=="2" goto full
if "%mode%"=="3" goto template
echo ❌ 无效选择
pause
exit /b

:minimal
echo.
echo 📦 创建最小配置...
echo.
node scripts/setup-env.js
goto end

:full
echo.
echo 📦 创建完整配置...
echo.
node scripts/setup-env.js
goto end

:template
echo.
echo 📋 从模板复制...
echo.
if not exist .env.example (
    echo ❌ 错误：找不到 .env.example 文件
    pause
    exit /b
)
copy .env.example .env >nul
echo ✅ 已从模板复制！
echo 📁 文件位置: %cd%\.env
echo.
echo 📝 后续步骤：
echo    1. 编辑 .env 文件，填入真实的API密钥
echo    2. 运行 npm start 启动服务
echo.
goto end

:end
pause
