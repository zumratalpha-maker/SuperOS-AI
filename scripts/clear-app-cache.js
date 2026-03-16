#!/usr/bin/env node
/**
 * 清除应用路径缓存（appRegistry.cache.json）
 * 当「打开微信」等报「未找到」且已知路径正确时，可运行此脚本清除旧缓存
 * 用法: node scripts/clear-app-cache.js
 */
import { unlinkSync, existsSync } from "fs";
import { join } from "path";

const cachePath = join(process.cwd(), "data", "appRegistry.cache.json");
if (existsSync(cachePath)) {
  unlinkSync(cachePath);
  console.log("已清除 data/appRegistry.cache.json");
} else {
  console.log("缓存文件不存在，无需清除");
}
