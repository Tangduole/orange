const fs = require('fs');
const path = require('path');

// Read the file
let content = fs.readFileSync('tikhub.js', 'utf8');

// Replace the curl download section with downloadFile
const oldPattern = /const downloadUrl = selectedVideo\.url;[\s\S]*?if \(onProgress\) onProgress\(90\);/;
const newCode = `const downloadUrl = selectedVideo.url;
  
  console.log(\`[TikHub] Downloading from: \${downloadUrl.substring(0, 80)}...\`);
  
  // 使用 downloadFile 下载（支持字节进度）
  await downloadFile(downloadUrl, outputPath, (percent, downloaded, total) => {
    if (onProgress) onProgress(30 + Math.floor(percent * 0.6), downloaded, total);
  }, {
    'User-Agent': 'Mozilla/5.0',
    'Referer': 'https://www.douyin.com/'
  });
  
  if (onProgress) onProgress(90);`;

content = content.replace(oldPattern, newCode);

// Write the file
fs.writeFileSync('tikhub.js', content);
console.log('Fixed parseDouyin function');
