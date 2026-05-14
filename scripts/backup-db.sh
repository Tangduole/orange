#!/bin/bash
# 橙子下载器 - 数据库备份脚本
# 用法: bash backup-db.sh
# 建议 cron: 0 */6 * * * bash /root/orange-backend/scripts/backup-db.sh

BACKUP_DIR="/root/orange-backend/backups"
mkdir -p "$BACKUP_DIR"

DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/users_backup_$DATE.json"

cd /root/orange-backend/backend

node -e "
const userDb = require('./src/userDb');
(async () => {
  try {
    // 导出所有用户
    const r = await userDb.db.execute('SELECT id, email, tier, subscription_status, subscription_ends_at, created_at FROM users');
    // 导出下载历史（最近 7 天）
    const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
    const h = await userDb.db.execute({
      sql: 'SELECT * FROM download_history WHERE created_at >= ?',
      args: [weekAgo]
    });
    const backup = {
      date: '${DATE}',
      users: r.rows,
      recent_history: h.rows.slice(0, 1000)
    };
    require('fs').writeFileSync('${BACKUP_FILE}', JSON.stringify(backup, null, 2));
    console.log('Backed up ' + r.rows.length + ' users, ' + Math.min(h.rows.length, 1000) + ' history rows');
  } catch(e) {
    console.error('Backup failed:', e.message);
    process.exit(1);
  }
})().catch(e => { console.error(e); process.exit(1); });
" 2>&1

# 保留最近 30 个备份
ls -t "$BACKUP_DIR"/users_backup_* 2>/dev/null | tail -n +31 | xargs rm -f 2>/dev/null

# 如果超过 2 个备份且本次备份的用户数比上次少了 50% 以上，报警
PREV=$(ls -t "$BACKUP_DIR"/users_backup_* 2>/dev/null | head -2 | tail -1)
if [ -n "$PREV" ] && [ -f "$BACKUP_FILE" ]; then
  PREV_COUNT=$(python3 -c "import json; print(len(json.load(open('$PREV')).get('users',[])))" 2>/dev/null || echo 0)
  CURR_COUNT=$(python3 -c "import json; print(len(json.load(open('$BACKUP_FILE')).get('users',[])))" 2>/dev/null || echo 0)
  if [ "$PREV_COUNT" -gt 10 ] && [ "$CURR_COUNT" -lt $((PREV_COUNT / 2)) ]; then
    echo "⚠️  ALERT: User count dropped from $PREV_COUNT to $CURR_COUNT!"
  fi
fi

echo "✅ Backup: $BACKUP_FILE"
