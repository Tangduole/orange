/**
 * 邮件服务 - 使用 Resend 发送邮件
 */

const { Resend } = require('resend');

// Graceful fallback if RESEND_API_KEY is not configured
let resend = null;
if (!process.env.RESEND_API_KEY) {
  console.warn('[email] RESEND_API_KEY not configured, email sending disabled');
} else {
  resend = new Resend(process.env.RESEND_API_KEY);
}

const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'Orange <noreply@orangedl.com>';
const APP_URL = process.env.APP_URL || 'https://orangedl.com';
const API_URL = process.env.API_URL || 'https://orange-production-95b9.up.railway.app';

/**
 * 发送密码重置邮件
 */
async function sendPasswordResetEmail(email, token) {
  if (!resend) {
    console.warn('[email] Resend not configured, skipping email send');
    return { success: false, error: 'Email service not configured' };
  }
  
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

/**
 * 发送邮箱验证邮件
 */
async function sendVerificationEmail(email, token) {
  if (!resend) {
    console.error('[email] Resend not configured, cannot send verification email');
    throw new Error('Email service not configured. Please contact administrator.');
  }
  
  const verifyUrl = `${API_URL}/api/auth/verify-email?token=${token}`;
  
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
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🍊 Orange</h1>
    </div>
    <div class="content">
      <p>您好！</p>
      <p>感谢您注册 Orange！请点击下方按钮验证您的邮箱地址。</p>
      <p style="text-align: center;">
        <a href="${verifyUrl}" class="btn">验证邮箱</a>
      </p>
      <p style="font-size: 13px; color: #999; text-align: center; margin-top: 20px;">
        如果按钮无法点击，请复制以下链接到浏览器打开：<br>
        <span style="word-break: break-all; color: #666;">${verifyUrl}</span>
      </p>
      <p style="background: #fff3cd; border: 1px solid #ffc107; border-radius: 6px; padding: 12px; margin: 15px 0; font-size: 13px; color: #856404;">
        ⏰ 此链接有效期为 <strong>24小时</strong>
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
      subject: '🍊 验证您的 Orange 邮箱',
      html
    });
    
    if (error) {
      console.error('[email] Send failed:', error);
      throw new Error(error.message);
    }
    
    console.log('[email] Verification email sent to:', email);
    return { success: true, data };
  } catch (err) {
    console.error('[email] Error:', err);
    throw err;
  }
}

module.exports = {
  sendPasswordResetEmail,
  sendVerificationEmail,
  sendWelcomeEmail,
  sendDay3Email,
  sendDay7Email,
};

/**
 * Day 1: 欢迎邮件（注册后当天发送）
 */
async function sendWelcomeEmail(email) {
  if (!resend) return;
  
  const html = buildEmail('Welcome to Orange! 🍊', `
    <p>Your account is ready. Start downloading videos from any platform.</p>
    <div style="background:#f0f9ff;border:1px solid #38bdf8;border-radius:8px;padding:16px;margin:20px 0;">
      <p style="margin:0 0 10px;font-weight:600;color:#0369a1;">How it works:</p>
      <ol style="margin:0;padding-left:20px;color:#475569;font-size:14px;line-height:2;">
        <li>Paste a video link</li>
        <li>Click download</li>
        <li>Done! Video saved to your device</li>
      </ol>
    </div>
    <div style="background:#fff7ed;border:1px solid #fb923c;border-radius:8px;padding:16px;margin:20px 0;">
      <p style="margin:0 0 8px;font-weight:600;color:#c2410c;">Free users: 3 downloads/day</p>
      <p style="margin:0;font-size:13px;color:#9a3412;">Upgrade to Pro for unlimited downloads, 4K quality, and batch download.</p>
    </div>
    <p style="text-align:center;">
      <a href="${APP_URL}" class="btn">Start Downloading</a>
    </p>
  `);
  
  await resend.emails.send({ from: FROM_EMAIL, to: email, subject: '🍊 Welcome to Orange!', html });
}

/**
 * Day 3: 使用成就邮件
 */
async function sendDay3Email(email, downloadCount) {
  if (!resend) return;
  
  const html = buildEmail('You\'re on fire! 🔥', `
    <p>In just 3 days, you've downloaded <strong>${downloadCount} videos</strong> with Orange.</p>
    <div style="background:#f0fdf4;border:1px solid #4ade80;border-radius:8px;padding:16px;margin:20px 0;text-align:center;">
      <p style="font-size:36px;margin:0 0 5px;">🎬</p>
      <p style="font-size:24px;font-weight:700;margin:0;color:#16a34a;">${downloadCount} videos</p>
      <p style="margin:5px 0 0;font-size:13px;color:#4ade80;">and counting!</p>
    </div>
    <p style="text-align:center;">
      <a href="${APP_URL}" class="btn">Keep Going</a>
    </p>
  `);
  
  await resend.emails.send({ from: FROM_EMAIL, to: email, subject: '🔥 You\'re on fire!', html });
}

/**
 * Day 7: 限时优惠
 */
async function sendDay7Email(email) {
  if (!resend) return;
  
  const html = buildEmail('Special offer just for you 🎁', `
    <p>Thanks for being with us for a week! Here's a special deal:</p>
    <div style="background:linear-gradient(135deg,#ff6b35,#ff8c42);border-radius:12px;padding:24px;margin:20px 0;text-align:center;color:white;">
      <p style="margin:0 0 8px;font-size:14px;opacity:0.9;">First month only</p>
      <p style="margin:0;font-size:42px;font-weight:800;">\$2.99<span style="font-size:16px;font-weight:400;opacity:0.8;">/mo</span></p>
      <p style="margin:8px 0 0;font-size:13px;opacity:0.8;">Save 40% vs regular price</p>
    </div>
    <div style="text-align:center;margin:20px 0;">
      <a href="${APP_URL}" class="btn">Claim Offer</a>
    </div>
    <p style="font-size:12px;color:#999;text-align:center;">Offer expires in 48 hours.</p>
  `);
  
  await resend.emails.send({ from: FROM_EMAIL, to: email, subject: '🎁 Special offer: Pro for \$2.99/mo', html });
}

/**
 * 邮件模板基础框架
 */
function buildEmail(title, bodyHtml) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;margin:0;padding:20px;">
  <div style="max-width:480px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
    <div style="background:linear-gradient(135deg,#ff6b35,#ff8c42);padding:30px;text-align:center;color:white;">
      <h1 style="margin:0;font-size:24px;">🍊 ${title}</h1>
    </div>
    <div style="padding:30px;">
      ${bodyHtml}
    </div>
    <div style="padding:20px 30px;background:#f9f9f9;text-align:center;font-size:12px;color:#999;">
      <a href="${APP_URL}" style="color:#ff6b35;text-decoration:none;">orangedl.com</a> · <a href="${APP_URL}/unsubscribe" style="color:#999;text-decoration:none;">Unsubscribe</a>
    </div>
  </div>
</body>
</html>`;
}
