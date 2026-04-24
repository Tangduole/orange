#!/usr/bin/env node

/**
 * 环境变量配置助手
 * 帮助用户快速配置 .env 文件
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const envPath = path.join(__dirname, '..', '.env');
const envExamplePath = path.join(__dirname, '..', '.env.example');

console.log('🔧 Orange 环境变量配置助手');
console.log('================================\n');

// 检查是否已存在 .env 文件
if (fs.existsSync(envPath)) {
  console.log('⚠️  警告：.env 文件已存在！');
  rl.question('是否要备份并重新创建？(y/N): ', (answer) => {
    if (answer.toLowerCase() === 'y') {
      const backupPath = `${envPath}.backup.${Date.now()}`;
      fs.copyFileSync(envPath, backupPath);
      console.log(`✅ 已备份到: ${backupPath}\n`);
      startSetup();
    } else {
      console.log('❌ 已取消');
      rl.close();
    }
  });
} else {
  startSetup();
}

function startSetup() {
  console.log('📝 开始配置...\n');
  
  const config = {};
  
  // 生成 JWT_SECRET
  config.JWT_SECRET = crypto.randomBytes(64).toString('hex');
  console.log('✅ 已自动生成 JWT_SECRET');
  
  // 基础配置
  config.PORT = '3000';
  config.NODE_ENV = 'production';
  config.LOG_LEVEL = 'info';
  config.FILE_RETENTION_HOURS = '24';
  
  console.log('\n📋 请选择配置模式：');
  console.log('1. 最小配置（仅核心功能）');
  console.log('2. 完整配置（包含所有API密钥）');
  console.log('3. 从模板复制（手动编辑）\n');
  
  rl.question('请选择 (1/2/3): ', (mode) => {
    if (mode === '1') {
      createMinimalConfig(config);
    } else if (mode === '2') {
      createFullConfig(config);
    } else if (mode === '3') {
      copyTemplate();
    } else {
      console.log('❌ 无效选择');
      rl.close();
    }
  });
}

function createMinimalConfig(config) {
  console.log('\n📦 创建最小配置...\n');
  
  const envContent = `# ============================================
# 橙子下载器 - 环境变量配置（最小配置）
# ============================================
# 自动生成于: ${new Date().toISOString()}

# 端口
PORT=${config.PORT}
NODE_ENV=${config.NODE_ENV}

# 日志配置
LOG_LEVEL=${config.LOG_LEVEL}
FILE_RETENTION_HOURS=${config.FILE_RETENTION_HOURS}

# 认证（自动生成）
JWT_SECRET=${config.JWT_SECRET}

# -------- 可选配置 --------
# 如需使用以下功能，请取消注释并填入真实值

# 数据库（推荐配置）
# TURSO_DATABASE_URL=libsql://your-database.turso.io
# TURSO_AUTH_TOKEN=your_token_here

# TikHub API（视频下载）
# TIKHUB_API_KEY_YT=your_youtube_key
# TIKHUB_API_KEY_DOUYIN=your_douyin_key
# TIKHUB_API_KEY_WECHAT=your_wechat_key

# 邮件服务（用户注册）
# RESEND_API_KEY=re_your_resend_key

# 应用URL
# APP_URL=https://www.orangedl.com
`;

  fs.writeFileSync(envPath, envContent);
  console.log('✅ 最小配置已创建！');
  console.log(`📁 文件位置: ${envPath}\n`);
  console.log('📝 后续步骤：');
  console.log('   1. 如需使用特定功能，编辑 .env 文件取消注释并填入密钥');
  console.log('   2. 运行 npm start 启动服务\n');
  
  rl.close();
}

function createFullConfig(config) {
  console.log('\n📦 创建完整配置...\n');
  console.log('⚠️  注意：需要手动填入真实的API密钥\n');
  
  rl.question('是否使用之前硬编码的微信API密钥？(y/N): ', (useOldKey) => {
    const wechatKey = useOldKey.toLowerCase() === 'y' 
      ? 'lrwNPvEUzE2ph0K5Oces5Q/RNRHRZ5tTzTTogR7aU/mj1li7O0XfZgWPCQ=='
      : 'your_wechat_api_key_here';
    
    const envContent = `# ============================================
# 橙子下载器 - 环境变量配置（完整配置）
# ============================================
# 自动生成于: ${new Date().toISOString()}

# 端口
PORT=${config.PORT}
NODE_ENV=${config.NODE_ENV}

# 日志配置
LOG_LEVEL=${config.LOG_LEVEL}
FILE_RETENTION_HOURS=${config.FILE_RETENTION_HOURS}

# 认证（自动生成）
JWT_SECRET=${config.JWT_SECRET}
ADMIN_API_KEY=your_random_admin_key_here

# -------- 数据库 (Turso) --------
TURSO_DATABASE_URL=libsql://your-database-name-your-org.turso.io
TURSO_AUTH_TOKEN=your_turso_auth_token_here

# -------- TikHub API Keys --------
TIKHUB_API_KEY_YT=your_youtube_api_key_here
TIKHUB_API_KEY_XHS=your_xiaohongshu_api_key_here
TIKHUB_API_KEY_DOUYIN=your_douyin_api_key_here
TIKHUB_API_KEY_INSTAGRAM=your_instagram_api_key_here
TIKHUB_API_KEY_WECHAT=${wechatKey}

# -------- 邮件 (Resend) --------
RESEND_API_KEY=re_your_resend_api_key_here

# -------- Cloudflare --------
CLOUDFLARE_EMAIL=your@email.com
CLOUDFLARE_ACCOUNT_ID=your_cloudflare_account_id
CLOUDFLARE_API_KEY=your_cloudflare_api_key
CLOUDFLARE_AI_TOKEN=your_cloudflare_ai_token

# -------- 支付 (Lemon Squeezy) --------
LEMON_SQUEEZY_API_KEY=your_lemonsqueezy_api_key_here
LEMON_SQUEEZY_STORE_ID=your_store_id_here
LEMON_SQUEEZY_PRODUCT_ID=your_product_id_here
LEMON_SQUEEZY_WEBHOOK_SECRET=your_webhook_secret_here

# -------- App URL --------
APP_URL=https://www.orangedl.com

# -------- ASR 模式 --------
ASR_MODE=cloudflare
`;

    fs.writeFileSync(envPath, envContent);
    console.log('✅ 完整配置已创建！');
    console.log(`📁 文件位置: ${envPath}\n`);
    console.log('📝 后续步骤：');
    console.log('   1. 编辑 .env 文件，将 your_xxx_here 替换为真实的API密钥');
    console.log('   2. 运行 npm start 启动服务\n');
    console.log('💡 提示：');
    console.log('   - JWT_SECRET 已自动生成，无需修改');
    if (useOldKey.toLowerCase() === 'y') {
      console.log('   - 微信API密钥已使用旧值，建议从TikHub重新生成');
    }
    console.log('   - 不使用的功能可以保持默认值\n');
    
    rl.close();
  });
}

function copyTemplate() {
  console.log('\n📋 从模板复制...\n');
  
  if (!fs.existsSync(envExamplePath)) {
    console.log('❌ 错误：找不到 .env.example 文件');
    rl.close();
    return;
  }
  
  fs.copyFileSync(envExamplePath, envPath);
  
  // 生成并替换 JWT_SECRET
  const content = fs.readFileSync(envPath, 'utf-8');
  const jwtSecret = crypto.randomBytes(64).toString('hex');
  const newContent = content.replace(
    'JWT_SECRET=your_random_jwt_secret_here',
    `JWT_SECRET=${jwtSecret}`
  );
  fs.writeFileSync(envPath, newContent);
  
  console.log('✅ 已从模板复制并生成 JWT_SECRET！');
  console.log(`📁 文件位置: ${envPath}\n`);
  console.log('📝 后续步骤：');
  console.log('   1. 编辑 .env 文件，填入真实的API密钥');
  console.log('   2. 运行 npm start 启动服务\n');
  
  rl.close();
}
