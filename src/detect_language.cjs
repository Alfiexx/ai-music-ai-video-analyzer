// 语言检测模块 (使用 faster-whisper)
// 返回音频中主要使用的语言代码

const { spawn } = require('child_process');
const path = require('path');

/**
 * 检测音频文件的语言
 * @param {string} audioPath - 音频文件路径
 * @param {number} sampleSeconds - 采样秒数 (默认30秒，用于加速检测)
 * @returns {Promise<{language: string, probability: number, duration: number}>}
 */
async function detectLanguage(audioPath, sampleSeconds = 30) {
  return new Promise((resolve, reject) => {
    const script = `
# -*- coding: utf-8 -*-
import sys
sys.stdout.reconfigure(encoding='utf-8')
import json

from faster_whisper import WhisperModel

audio_path = sys.argv[1]

# 使用 tiny 模型 (首次会下载，之后使用缓存)
model = WhisperModel('tiny', device='cpu', compute_type='int8')

# 只检测语言，不需要完整转录
segments, info = model.transcribe(audio_path, language=None, task='transcribe')

result = {
  'language': info.language,
  'probability': round(info.language_probability, 3),
  'duration': round(info.duration, 1)
}

print(json.dumps(result, ensure_ascii=False))
`;

    const args = ['-c', script, audioPath];
    const python = spawn('python', args, {
      cwd: path.dirname(audioPath),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });

    let stdout = '';
    let stderr = '';

    python.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    python.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    python.on('close', (code) => {
      if (code !== 0) {
        // 过滤掉警告信息
        const errLines = stderr.split('\n').filter(l =>
          !l.includes('Warning:') &&
          !l.includes('UserWarning') &&
          !l.includes('HF_HUB_DISABLE_SYMLINKS_WARNING') &&
          !l.includes('huggingface_hub')
        ).join('\n');
        if (errLines.trim()) {
          reject(new Error(`Language detection failed: ${errLines}`));
          return;
        }
      }

      try {
        // 提取 JSON 输出
        const lines = stdout.trim().split('\n');
        const jsonLine = lines.find(l => l.startsWith('{'));
        if (jsonLine) {
          const result = JSON.parse(jsonLine);
          resolve(result);
        } else {
          reject(new Error('No JSON output from language detection'));
        }
      } catch (e) {
        reject(new Error(`Failed to parse language detection output: ${stdout}`));
      }
    });

    python.on('error', (err) => {
      reject(new Error(`Failed to spawn Python: ${err.message}`));
    });
  });
}

/**
 * 判断语言是否应该排除国风相关标签
 * @param {string} language - 语言代码
 * @returns {boolean} - true 表示应该排除国风标签
 */
function shouldExcludeChineseGenres(language) {
  // 非中文语言排除国风标签
  const excludeLanguages = ['en', 'ko', 'ja', 'es', 'fr', 'de', 'ru', 'pt', 'it', 'ar'];
  return excludeLanguages.includes(language);
}

/**
 * 获取语言的中文名称
 */
function getLanguageName(code) {
  const names = {
    'zh': '中文',
    'en': '英语',
    'ko': '韩语',
    'ja': '日语',
    'es': '西班牙语',
    'fr': '法语',
    'de': '德语',
    'ru': '俄语',
    'pt': '葡萄牙语',
    'it': '意大利语',
    'ar': '阿拉伯语',
    'unknown': '未知'
  };
  return names[code] || code;
}

// CLI 入口
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node detect_language.cjs <audio.mp3> [sample_seconds]');
    process.exit(1);
  }

  const audioPath = args[0];
  const sampleSeconds = parseInt(args[1]) || 30;

  console.log(`[detect_language] Analyzing ${audioPath}...`);

  detectLanguage(audioPath, sampleSeconds)
    .then(result => {
      console.log(`  Language: ${result.language} (${getLanguageName(result.language)})`);
      console.log(`  Probability: ${result.probability}`);
      console.log(`  Duration: ${result.duration}s`);
      console.log(`  Exclude Chinese genres: ${shouldExcludeChineseGenres(result.language)}`);

      // 输出 JSON 供程序调用
      console.log(`__JSON__${JSON.stringify(result)}`);
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}

module.exports = {
  detectLanguage,
  shouldExcludeChineseGenres,
  getLanguageName
};