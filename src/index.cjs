#!/usr/bin/env node
/**
 * AI Music AI Video Analyzer - CLI Entry Point
 *
 * Usage:
 *   npx ai-music-ai-video-analyzer <audio_file> [options]
 *
 * Options:
 *   --beats      只输出节拍相关数据
 *   --bpm        只输出 BPM 相关数据
 *   --phrases    只输出段落识别数据
 *   --cuts       只输出推荐切点
 *   --full       全部输出（默认）
 *   --json <path>  保存 JSON 到指定路径
 *   --report     生成 HTML 可视化报告
 */

const path = require('path');
const { spawnSync } = require('child_process');

// 设置 Python 脚本路径
process.env.PYTHON_SCRIPTS_DIR = path.join(__dirname, '..', 'python');

// 加载并运行 analyze.cjs
const analyzePath = path.join(__dirname, 'analyze.cjs');

// 直接调用 analyze.cjs，确保它作为主模块运行
const result = spawnSync(process.execPath, [analyzePath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env
});

process.exit(result.status || 0);