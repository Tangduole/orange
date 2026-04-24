#!/bin/bash

# 快速修复脚本 - 自动更新依赖和配置

set -e

echo "🔧 Orange 快速修复脚本"
echo "======================="
echo ""

# 检查是否在正确的目录
if [ ! -f "package.json" ]; then
    echo "❌ 错误：请在 backend 目录下运行此脚本"
    exit 1
fi

# 1. 备份
echo "📦 1. 备份现有数据..."
if [ -f "data/users.db" ]; then
    cp data/users.db data/users.db.backup.$(date +%Y%m%d_%H%M%S)
    echo "✅ 数据库已备份"
fi

if [ -f ".env" ]; then
    cp .env .env.backup.$(date +%Y%m%d_%H%M%S)
    echo "✅ 环境变量已备份"
fi

# 2. 更新依赖
echo ""
echo "📦 2. 更新依赖包..."
npm install
echo "✅ 依赖包已更新"

# 3. 修复安全漏洞
echo ""
echo "🔒 3. 修复安全漏洞..."
npm audit fix || true
echo "✅ 安全漏洞已修复"

# 4. 创建必要的目录
echo ""
echo "📁 4. 创建必要的目录..."
mkdir -p logs
mkdir -p data
mkdir -p downloads
chmod 755 logs data downloads
echo "✅ 目录已创建"

# 5. 检查环境变量
echo ""
echo "🔍 5. 检查环境变量..."
if [ ! -f ".env" ]; then
    echo "⚠️  警告：.env 文件不存在，从模板创建..."
    cp .env.example .env
    echo "⚠️  请编辑 .env 文件并填入真实的密钥！"
else
    # 检查必需的环境变量
    if ! grep -q "JWT_SECRET=" .env || grep -q "JWT_SECRET=your" .env; then
        echo "⚠️  警告：JWT_SECRET 未设置或使用默认值"
        echo "   生成随机密钥..."
        JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
        if grep -q "JWT_SECRET=" .env; then
            # 替换现有的
            sed -i.bak "s/JWT_SECRET=.*/JWT_SECRET=$JWT_SECRET/" .env
        else
            # 添加新的
            echo "JWT_SECRET=$JWT_SECRET" >> .env
        fi
        echo "✅ JWT_SECRET 已生成"
    fi
    
    if ! grep -q "NODE_ENV=" .env; then
        echo "NODE_ENV=production" >> .env
        echo "✅ NODE_ENV 已设置"
    fi
    
    if ! grep -q "LOG_LEVEL=" .env; then
        echo "LOG_LEVEL=info" >> .env
        echo "✅ LOG_LEVEL 已设置"
    fi
    
    if ! grep -q "FILE_RETENTION_HOURS=" .env; then
        echo "FILE_RETENTION_HOURS=24" >> .env
        echo "✅ FILE_RETENTION_HOURS 已设置"
    fi
fi

# 6. 测试启动
echo ""
echo "🧪 6. 测试配置..."
node -e "
require('dotenv').config();
const required = ['JWT_SECRET', 'NODE_ENV'];
let missing = [];
for (const key of required) {
    if (!process.env[key]) missing.push(key);
}
if (missing.length > 0) {
    console.log('❌ 缺少必需的环境变量:', missing.join(', '));
    process.exit(1);
}
console.log('✅ 环境变量验证通过');
"

# 7. 完成
echo ""
echo "✅ 修复完成！"
echo ""
echo "📝 后续步骤："
echo "   1. 检查 .env 文件，确保所有 API 密钥已填写"
echo "   2. 运行 'npm start' 启动服务"
echo "   3. 检查 logs/ 目录中的日志文件"
echo ""
echo "📚 更多信息："
echo "   - 安全指南: ../SECURITY.md"
echo "   - 升级指南: ../UPGRADE_GUIDE.md"
echo ""
