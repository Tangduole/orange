module.exports = {
  apps: [{
    name: 'orange-backend',
    script: 'src/app.js',
    cwd: '/opt/orange/backend',
    instances: 1,
    exec_mode: 'fork',
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    env: {
      // 环境变量从 /opt/orange/backend/.env 读取
      // 不要在这里写任何密钥！
    },
    watch: false,
    max_memory_restart: '1G',
    error_file: '/root/.pm2/logs/orange-backend-error.log',
    out_file: '/root/.pm2/logs/orange-backend-out.log',
    time: true,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s'
  }]
};
