---
name: ai-music-ai-video-analyzer
description: Use when analyzing audio files for beats, BPM, phrases, or recommended cut points for video editing, music production, or content creation
---

# AI Music AI Video Analyzer

分析音频文件的节拍、BPM、段落结构和推荐切点，辅助视频剪辑、音乐制作和内容创作。

## Prerequisites

- Node.js 18+
- Python 3.10+

## Installation

```bash
# 1. 配置 GitHub Packages (首次需要)
echo "@alfiexx:registry=https://npm.pkg.github.com" >> ~/.npmrc

# 2. 安装依赖
npm install @alfiexx/ai-music-ai-video-analyzer
pip install madmom-modern numpy scipy
```

## Usage

让 Claude 分析音乐文件：

- "分析这首歌的节拍和切点" → Claude 运行 --beats --cuts
- "生成这首歌的可视化报告" → Claude 运行 --report
- "分析这首歌的段落结构" → Claude 运行 --phrases
- "完整分析这首歌" → Claude 运行完整分析

## CLI Options

| Option | Description |
|--------|-------------|
| `--beats` | 节拍和强拍分析 |
| `--bpm` | BPM 和节奏分析 |
| `--phrases` | 段落/结构识别 |
| `--cuts` | 推荐切点 |
| `--report` | 生成 HTML 可视化报告 |
| `--json <path>` | 保存 JSON 到指定路径 |

## Output Fields

### Beats Module
- `beats`: 节拍时间点数组
- `downbeats`: 强拍位置
- `medium_beats`: 次强拍位置
- `time_signature`: 拍号
- `beat_weight`: 重拍类型分析

### BPM Module
- `bpm`: 主 BPM
- `bpm_timeline`: BPM 变化曲线
- `bpm_segments`: 段落级 BPM
- `genre_hint`: 风格提示

### Phrases Module
- `phrases`: 段落数组 [{start, end, label}]
- `phrases_source`: 来源（heuristic）

### Cuts Module
- `suggested_cut_points`: 建议切点
- `recommended_cut_points`: 推荐切点（带能量区间）

## Example

```bash
# 完整分析
npx @alfiexx/ai-music-ai-video-analyzer music.mp3

# 只要节拍和切点
npx @alfiexx/ai-music-ai-video-analyzer music.mp3 --beats --cuts

# 生成可视化报告
npx @alfiexx/ai-music-ai-video-analyzer music.mp3 --report
```
