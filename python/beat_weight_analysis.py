#!/usr/bin/env python3
"""
Beat Weight Analysis - 判断歌曲的"重拍"是强拍还是次强拍
结合频谱质心和逐小节onset两种方法

输出:
  - downbeat: 强拍是重拍
  - medium: 次强拍是重拍
  - mixed: 混合推荐
"""

import sys
import os
import json
import warnings
warnings.filterwarnings('ignore')

# 设置 ffmpeg 路径
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FFMPEG_PATH = os.path.join(SCRIPT_DIR, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
if os.path.exists(FFMPEG_PATH):
    os.environ['PATH'] = os.path.dirname(FFMPEG_PATH) + os.pathsep + os.environ.get('PATH', '')

import numpy as np

def analyze_beat_weight(audio_path, downbeats, medium_beats):
    """
    分析歌曲的重拍类型

    返回:
      - weight_type: 'downbeat' / 'medium' / 'mixed'
      - confidence: 置信度 0-1
      - details: 详细分析数据
    """
    try:
        import librosa
    except ImportError:
        return {'weight_type': 'mixed', 'confidence': 0, 'error': 'librosa not installed'}

    if not downbeats or not medium_beats:
        return {'weight_type': 'mixed', 'confidence': 0, 'error': 'no beat data'}

    # 加载音频
    try:
        y, sr = librosa.load(audio_path, sr=None)
    except Exception as e:
        return {'weight_type': 'mixed', 'confidence': 0, 'error': str(e)}

    # ========== 方法1: 频谱质心 ==========
    cent = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
    cent_times = librosa.times_like(cent, sr=sr)

    def get_centroid_at(t, window=0.05):
        mask = (cent_times >= t - window) & (cent_times <= t + window)
        if mask.sum() == 0:
            return 0
        return cent[mask].mean()

    down_centroids = [get_centroid_at(t) for t in downbeats]
    med_centroids = [get_centroid_at(t) for t in medium_beats]
    down_centroids = [c for c in down_centroids if c > 0]
    med_centroids = [c for c in med_centroids if c > 0]

    down_cent_avg = np.mean(down_centroids) if down_centroids else 0
    med_cent_avg = np.mean(med_centroids) if med_centroids else 0
    cent_diff = down_cent_avg - med_cent_avg

    # ========== 方法2: 逐小节 Onset ==========
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    onset_times = librosa.times_like(onset_env, sr=sr)

    def get_onset_at(t, window=0.05):
        mask = (onset_times >= t - window) & (onset_times <= t + window)
        if mask.sum() == 0:
            return 0
        return onset_env[mask].max()

    # 逐小节比较
    min_len = min(len(downbeats), len(medium_beats))
    down_wins = 0
    med_wins = 0

    for i in range(min_len):
        down_onset = get_onset_at(downbeats[i])
        med_onset = get_onset_at(medium_beats[i])
        if down_onset > med_onset:
            down_wins += 1
        elif med_onset > down_onset:
            med_wins += 1

    total_bars = down_wins + med_wins
    down_ratio = down_wins / total_bars if total_bars > 0 else 0.5
    med_ratio = med_wins / total_bars if total_bars > 0 else 0.5

    # ========== 组合判断 ==========
    # 核心逻辑：
    # 1. Onset强度 = 打击感（主要判断依据）
    # 2. 频谱质心 = 音色差异（辅助判断，当onset差距不大时使用）
    weight_type = 'mixed'
    confidence = 0
    reason = ''

    # 第一优先：Onset差距显著（>55%）
    if total_bars >= 5:
        if med_ratio > 0.55:
            weight_type = 'medium'
            reason = f'Onset: {med_wins}/{total_bars}小节次强拍更强({med_ratio*100:.0f}%)'
            confidence = min((med_ratio - 0.5) * 2, 0.8)
        elif down_ratio > 0.55:
            weight_type = 'downbeat'
            reason = f'Onset: {down_wins}/{total_bars}小节强拍更强({down_ratio*100:.0f}%)'
            confidence = min((down_ratio - 0.5) * 2, 0.8)

    # 第二优先：质心差距大（>300Hz），且onset差距不显著
    if weight_type == 'mixed' and abs(cent_diff) > 300:
        if cent_diff > 0:  # 强拍质心高 = 强拍高频多
            weight_type = 'downbeat'
            reason = f'质心: 强拍更亮({down_cent_avg:.0f}Hz > {med_cent_avg:.0f}Hz)'
            confidence = min(abs(cent_diff) / 600, 0.6)
        else:  # 次强拍质心高
            weight_type = 'medium'
            reason = f'质心: 次强拍更亮({med_cent_avg:.0f}Hz > {down_cent_avg:.0f}Hz)'
            confidence = min(abs(cent_diff) / 600, 0.6)

    # 如果还是没有明确判断
    if weight_type == 'mixed':
        reason = f'Onset差距小({down_wins}vs{med_wins}), 质心差距小({abs(cent_diff):.0f}Hz)'
        confidence = 0.3

    return {
        'weight_type': weight_type,
        'confidence': round(confidence, 2),
        'reason': reason,
        'details': {
            'centroid': {
                'downbeat_avg': round(down_cent_avg, 0),
                'medium_avg': round(med_cent_avg, 0),
                'diff': round(cent_diff, 0)
            },
            'onset': {
                'downbeat_wins': down_wins,
                'medium_wins': med_wins,
                'total_bars': total_bars,
                'downbeat_ratio': round(down_ratio, 2),
                'medium_ratio': round(med_ratio, 2)
            }
        }
    }


def analyze_vocal_alignment(vocal_segments, downbeats, medium_beats, threshold=0.15):
    """
    分析人声开始位置更接近强拍还是次强拍

    返回:
      - vocal_type: 'downbeat' / 'medium' / 'neutral'
      - vocal_confidence: 0-1
      - details: 详细数据
    """
    if not vocal_segments or not downbeats or not medium_beats:
        return {'vocal_type': 'neutral', 'vocal_confidence': 0, 'details': {'reason': 'no data'}}

    downbeat_vocal_starts = 0
    medium_vocal_starts = 0

    for seg in vocal_segments:
        start = seg['start']

        # 找最近强拍
        nearest_down = None
        min_down_diff = float('inf')
        for db in downbeats:
            diff = abs(db - start)
            if diff < min_down_diff:
                min_down_diff = diff
                nearest_down = db

        # 找最近次强拍
        nearest_med = None
        min_med_diff = float('inf')
        for mb in medium_beats:
            diff = abs(mb - start)
            if diff < min_med_diff:
                min_med_diff = diff
                nearest_med = mb

        # 判断人声开始更接近哪个拍子
        if min_down_diff <= threshold and min_down_diff < min_med_diff:
            downbeat_vocal_starts += 1
        elif min_med_diff <= threshold and min_med_diff < min_down_diff:
            medium_vocal_starts += 1

    total_vocal_starts = downbeat_vocal_starts + medium_vocal_starts

    if total_vocal_starts == 0:
        return {
            'vocal_type': 'neutral',
            'vocal_confidence': 0,
            'details': {
                'downbeat_vocal_starts': 0,
                'medium_vocal_starts': 0,
                'reason': 'no vocal starts aligned to beats'
            }
        }

    down_ratio = downbeat_vocal_starts / total_vocal_starts
    med_ratio = medium_vocal_starts / total_vocal_starts

    # 判断逻辑
    if med_ratio > 0.6:
        vocal_type = 'medium'
        vocal_confidence = min((med_ratio - 0.5) * 2, 0.8)
    elif down_ratio > 0.6:
        vocal_type = 'downbeat'
        vocal_confidence = min((down_ratio - 0.5) * 2, 0.8)
    else:
        vocal_type = 'neutral'
        vocal_confidence = 0.3

    return {
        'vocal_type': vocal_type,
        'vocal_confidence': round(vocal_confidence, 2),
        'details': {
            'downbeat_vocal_starts': downbeat_vocal_starts,
            'medium_vocal_starts': medium_vocal_starts,
            'total_vocal_starts': total_vocal_starts,
            'downbeat_ratio': round(down_ratio, 2),
            'medium_ratio': round(med_ratio, 2)
        }
    }


def main():
    if len(sys.argv) < 4:
        print(json.dumps({'error': 'Usage: beat_weight_analysis.py <audio> <downbeats_json> <medium_beats_json> [vocal_segments_json]'}))
        sys.exit(1)

    audio_path = sys.argv[1]
    downbeats = json.loads(sys.argv[2])
    medium_beats = json.loads(sys.argv[3])
    vocal_segments = json.loads(sys.argv[4]) if len(sys.argv) > 4 else None

    result = analyze_beat_weight(audio_path, downbeats, medium_beats)

    # 加入人声分析
    if vocal_segments:
        vocal_result = analyze_vocal_alignment(vocal_segments, downbeats, medium_beats)
        result['vocal_analysis'] = vocal_result

        # 综合判断逻辑
        original_type = result['weight_type']
        original_conf = result['confidence']
        vocal_type = vocal_result['vocal_type']
        vocal_conf = vocal_result['vocal_confidence']

        if vocal_type != 'neutral' and vocal_conf > original_conf:
            # 人声分析置信度更高，以人声分析为准
            if vocal_type != original_type:
                result['weight_type'] = vocal_type
                result['confidence'] = vocal_conf
                result['reason'] = f"人声覆盖: {vocal_result['details']['downbeat_vocal_starts']}强拍 vs {vocal_result['details']['medium_vocal_starts']}次强拍"
            else:
                # 一致，提高置信度
                result['confidence'] = min(original_conf + vocal_conf * 0.5, 0.9)
                result['reason'] += f" + 人声一致"
        elif vocal_type != 'neutral' and vocal_type != original_type:
            # 人声置信度不高但有倾向，记录冲突
            result['reason'] += f" (人声倾向{vocal_type})"

    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()