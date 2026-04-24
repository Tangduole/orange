/**
 * 异步文件操作工具 - 避免阻塞事件循环
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const logger = require('./logger');

/**
 * 安全地删除文件（不抛出错误）
 * @param {string} filePath 文件路径
 * @returns {Promise<boolean>} 是否成功删除
 */
async function safeUnlink(filePath) {
  try {
    await fs.unlink(filePath);
    logger.debug(`[AsyncFS] Deleted: ${filePath}`);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn(`[AsyncFS] Failed to delete ${filePath}: ${error.message}`);
    }
    return false;
  }
}

/**
 * 安全地读取文件
 * @param {string} filePath 文件路径
 * @param {string} encoding 编码
 * @returns {Promise<string|null>}
 */
async function safeReadFile(filePath, encoding = 'utf-8') {
  try {
    return await fs.readFile(filePath, encoding);
  } catch (error) {
    logger.warn(`[AsyncFS] Failed to read ${filePath}: ${error.message}`);
    return null;
  }
}

/**
 * 安全地写入文件
 * @param {string} filePath 文件路径
 * @param {string|Buffer} data 数据
 * @param {string} encoding 编码
 * @returns {Promise<boolean>}
 */
async function safeWriteFile(filePath, data, encoding = 'utf-8') {
  try {
    await fs.writeFile(filePath, data, encoding);
    logger.debug(`[AsyncFS] Written: ${filePath}`);
    return true;
  } catch (error) {
    logger.error(`[AsyncFS] Failed to write ${filePath}: ${error.message}`);
    return false;
  }
}

/**
 * 确保目录存在
 * @param {string} dirPath 目录路径
 * @returns {Promise<boolean>}
 */
async function ensureDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
    return true;
  } catch (error) {
    logger.error(`[AsyncFS] Failed to create directory ${dirPath}: ${error.message}`);
    return false;
  }
}

/**
 * 检查文件是否存在
 * @param {string} filePath 文件路径
 * @returns {Promise<boolean>}
 */
async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取文件大小
 * @param {string} filePath 文件路径
 * @returns {Promise<number|null>} 文件大小（字节）
 */
async function getFileSize(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return stats.size;
  } catch (error) {
    logger.warn(`[AsyncFS] Failed to get size of ${filePath}: ${error.message}`);
    return null;
  }
}

/**
 * 列出目录中的文件
 * @param {string} dirPath 目录路径
 * @param {string} pattern 文件名模式（可选）
 * @returns {Promise<string[]>}
 */
async function listFiles(dirPath, pattern = null) {
  try {
    const files = await fs.readdir(dirPath);
    
    if (pattern) {
      const regex = new RegExp(pattern);
      return files.filter(f => regex.test(f));
    }
    
    return files;
  } catch (error) {
    logger.warn(`[AsyncFS] Failed to list files in ${dirPath}: ${error.message}`);
    return [];
  }
}

/**
 * 复制文件
 * @param {string} src 源文件路径
 * @param {string} dest 目标文件路径
 * @returns {Promise<boolean>}
 */
async function copyFile(src, dest) {
  try {
    await fs.copyFile(src, dest);
    logger.debug(`[AsyncFS] Copied: ${src} -> ${dest}`);
    return true;
  } catch (error) {
    logger.error(`[AsyncFS] Failed to copy ${src} to ${dest}: ${error.message}`);
    return false;
  }
}

/**
 * 移动文件
 * @param {string} src 源文件路径
 * @param {string} dest 目标文件路径
 * @returns {Promise<boolean>}
 */
async function moveFile(src, dest) {
  try {
    await fs.rename(src, dest);
    logger.debug(`[AsyncFS] Moved: ${src} -> ${dest}`);
    return true;
  } catch (error) {
    // 如果跨设备移动失败，尝试复制+删除
    if (error.code === 'EXDEV') {
      const copied = await copyFile(src, dest);
      if (copied) {
        await safeUnlink(src);
        return true;
      }
    }
    logger.error(`[AsyncFS] Failed to move ${src} to ${dest}: ${error.message}`);
    return false;
  }
}

/**
 * 读取文件的前N个字节（用于检测文件类型）
 * @param {string} filePath 文件路径
 * @param {number} bytes 字节数
 * @returns {Promise<Buffer|null>}
 */
async function readFileHead(filePath, bytes = 1024) {
  try {
    const fd = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(bytes);
    await fd.read(buffer, 0, bytes, 0);
    await fd.close();
    return buffer;
  } catch (error) {
    logger.warn(`[AsyncFS] Failed to read head of ${filePath}: ${error.message}`);
    return null;
  }
}

/**
 * 检查文件是否为HTML（防止下载到错误页面）
 * @param {string} filePath 文件路径
 * @returns {Promise<boolean>}
 */
async function isHtmlFile(filePath) {
  const head = await readFileHead(filePath, 512);
  if (!head) return false;
  
  const text = head.toString('utf8').trim().toLowerCase();
  return text.startsWith('<!doctype') || 
         text.startsWith('<html') || 
         text.startsWith('<!DOCTYPE');
}

/**
 * 批量删除文件
 * @param {string[]} filePaths 文件路径数组
 * @returns {Promise<number>} 成功删除的文件数
 */
async function batchUnlink(filePaths) {
  let count = 0;
  
  await Promise.all(
    filePaths.map(async (filePath) => {
      const success = await safeUnlink(filePath);
      if (success) count++;
    })
  );
  
  return count;
}

module.exports = {
  safeUnlink,
  safeReadFile,
  safeWriteFile,
  ensureDir,
  fileExists,
  getFileSize,
  listFiles,
  copyFile,
  moveFile,
  readFileHead,
  isHtmlFile,
  batchUnlink
};
