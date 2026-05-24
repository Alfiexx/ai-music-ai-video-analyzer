# AI Music AI Video Analyzer

分析音频文件的节拍、BPM、段落结构和推荐切点。

## 安装

```bash
# 1. 配置 GitHub Packages (首次需要)
echo "@alfiexx:registry=https://npm.pkg.github.com" >> ~/.npmrc

# 2. 安装
npm install @alfiexx/ai-music-ai-video-analyzer
pip install madmom-modern numpy scipy
```

## 使用

```bash
# 完整分析
npx @alfiexx/ai-music-ai-video-analyzer music.mp3

# 模块化分析
npx @alfiexx/ai-music-ai-video-analyzer music.mp3 --beats
npx @alfiexx/ai-music-ai-video-analyzer music.mp3 --bpm
npx @alfiexx/ai-music-ai-video-analyzer music.mp3 --phrases
npx @alfiexx/ai-music-ai-video-analyzer music.mp3 --cuts

# 组合模块
npx @alfiexx/ai-music-ai-video-analyzer music.mp3 --beats --cuts

# 生成报告
npx @alfiexx/ai-music-ai-video-analyzer music.mp3 --report

# 指定输出路径
npx @alfiexx/ai-music-ai-video-analyzer music.mp3 --json output.json --report
```

## 输出示例

```json
{
  "duration_s": 180.5,
  "bpm": 120,
  "beats": [0.5, 1.0, 1.5, ...],
  "downbeats": [0.5, 2.0, 3.5, ...],
  "phrases": [
    { "start": 0, "end": 15, "label": "intro" },
    { "start": 15, "end": 45, "label": "verse1" }
  ],
  "suggested_cut_points": [
    { "time": 0.5, "type": "segment_boundary", "reason": "音乐起始" }
  ]
}
```

## 依赖

- Node.js 18+
- Python 3.10+
- essentia.js
- madmom-modern
- ffmpeg-static

## License

MIT