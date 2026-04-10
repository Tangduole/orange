/**
 * 邮件服务 - 使用 Resend 发送邮件
 */

const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'Orange <noreply@orangedl.com>';
const APP_URL = process.env.APP_URL || 'https://frontend-roan-psi-68.vercel.app';

/**
 * 发送密码重置邮件
 */
async function sendPasswordResetEmail(email, token) {
  const resetUrl = `${APP_URL}/reset-password?token=${token}`;
  
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; margin: 0; padding: 20px; }
    .container { max-width: 480px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .header { background: linear-gradient(135deg, #ff6b35, #ff8c42); padding: 30px; text-align: center; color: white; }
    .header h1 { margin: 0; font-size: 24px; }
    .content { padding: 30px; }
    .content p { color: #666; line-height: 1.6; margin: 0 0 20px; }
    .btn { display: inline-block; background: linear-gradient(135deg, #ff6b35, #ff8c42); color: white !important; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 600; }
    .btn:hover { background: linear-gradient(135deg, #ff8c42, #ffa060); }
    .footer { padding: 20px 30px; background: #f9f9f9; text-align: center; font-size: 12px; color: #999; }
    .note { background: #fff3cd; border: 1px solid #ffc107; border-radius: 6px; padding: 12px; margin: 15px 0; font-size: 13px; color: #856404; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🍊 Orange</h1>
    </div>
    <div class="content">
      <p>您好！</p>
      <p>我们收到了您的密码重置请求。如果这不是您本人操作，请忽略此邮件。</p>
      <div class="note">
        ⏰ 此链接有效期为 <strong>30分钟</strong>，逾期需重新申请。
      </div>
      <p style="text-align: center;">
        <a href="${resetUrl}" class="btn">重置密码</a>
      </p>
      <p style="font-size: 13px; color: #999; text-align: center; margin-top: 20px;">
        如果按钮无法点击，请复制以下链接到浏览器打开：<br>
        <span style="word-break: break-all; color: #666;">${resetUrl}</span>
      </p>
    </div>
    <div class="footer">
      © 2026 Orange Downloader · 此邮件由系统自动发出，请勿回复
    </div>
  </div>
</body>
</html>
  `;

  try {
    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: '🍊 重置您的 Orange 密码',
      html
    });
    
    if (error) {
      console.error('[email] Send failed:', error);
      throw new Error(error.message);
    }
    
    console.log('[email] Password reset email sent to:', email);
    return { success: true, data };
  } catch (err) {
    console.error('[email] Error:', err);
    throw err;
  }
}

module.exports = {
  sendPasswordResetEmail
};
