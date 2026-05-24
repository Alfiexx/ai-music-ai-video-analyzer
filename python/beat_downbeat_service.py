#!/usr/bin/env python3
"""
MuseAI Beat/Downbeat/TimeSignature Detection Service
使用 madmom 神经网络模型检测:
  - Beat 时间点
  - Downbeat (强拍, 每小节第1拍)
  - Medium beats (次强拍, 4/4拍的第3拍)
  - Time signature (拍号)

调用方式: py -3.10 beat_downbeat_service.py <audio_file>
输出: JSON 到 stdout
"""

import sys
import os
import json
import warnings
warnings.filterwarnings('ignore')

# 添加 ffmpeg 路径 (使用项目中的 ffmpeg-static)
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FFMPEG_PATH = os.path.join(SCRIPT_DIR, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
if os.path.exists(FFMPEG_PATH):
    # 将 ffmpeg 目录添加到 PATH
    os.environ['PATH'] = os.path.dirname(FFMPEG_PATH) + os.pathsep + os.environ.get('PATH', '')
    # madmom 使用 PATH 中的 ffmpeg


def detect_beats(audio_path):
    """使用 madmom 检测 beat/downbeat/time signature"""
    try:
        from madmom.features.downbeats import RNNDownBeatProcessor, DBNDownBeatTrackingProcessor
        import numpy as np
    except ImportError as e:
        return {"error": f"madmom not installed: {e}", "fallback": True}

    try:
        # Downbeat 检测器 (同时得到 beat 和 downbeat)
        print("[madmom] 加载神经网络模型...", file=sys.stderr)
        downbeat_processor = RNNDownBeatProcessor()(audio_path)
        print("[madmom] 模型加载完成，开始检测...", file=sys.stderr)

        # 尝试不同拍号，记录所有结果
        results = {}
        for beats_per_bar in [4, 3, 2, 6]:
            try:
                tracker = DBNDownBeatTrackingProcessor(
                    beats_per_bar=[beats_per_bar],
                    fps=100,
                    threshold=0.2
                )
                result = tracker(downbeat_processor)
                if len(result) > 0:
                    results[beats_per_bar] = {
                        'result': result,
                        'count': len(result)
                    }
                    print(f"[madmom] meter={beats_per_bar}/4: {len(result)} beats", file=sys.stderr)
            except Exception as e:
                print(f"[madmom] meter={beats_per_bar}/4 失败: {e}", file=sys.stderr)

        if not results:
            return {"error": "No beats detected by madmom", "fallback": True}

        # 优先选择 4/4 拍，除非其他拍号明显更好
        # 判断标准：如果 4/4 拍的结果存在且数量合理，就用 4/4
        best_meter = 4
        best_result = None

        if 4 in results:
            best_result = results[4]['result']
            best_meter = 4
        elif 3 in results:
            best_result = results[3]['result']
            best_meter = 3
        elif 2 in results:
            best_result = results[2]['result']
            best_meter = 2
        elif 6 in results:
            best_result = results[6]['result']
            best_meter = 6

        if best_result is None or len(best_result) == 0:
            return {"error": "No beats detected by madmom", "fallback": True}

        print(f"[madmom] 选择拍号={best_meter}/4, {len(best_result)} 个 beats", file=sys.stderr)

        # 解析结果
        # result 格式: [[time, beat_position], ...]
        # beat_position: 1 = downbeat, 2,3,4... = 其他拍
        beats = []
        downbeats = []
        beat_positions = []

        for item in best_result:
            time = float(item[0])
            position = int(item[1])
            beats.append(time)
            beat_positions.append(position)
            if position == 1:
                downbeats.append(time)

        # 次强拍 (4/4拍的第3拍, 即 position=3)
        medium_beats = []
        if best_meter == 4:
            for item in best_result:
                if int(item[1]) == 3:
                    medium_beats.append(float(item[0]))

        confidence = calculate_confidence(downbeats, best_meter)
        bpm = estimate_bpm(beats)
        denominator = 8 if best_meter == 6 else 4

        return {
            "beats": beats,
            "downbeats": downbeats,
            "medium_beats": medium_beats,
            "beat_positions": beat_positions,
            "time_signature": {
                "numerator": best_meter,
                "denominator": denominator,
                "detected": True
            },
            "bpm": bpm,
            "confidence": confidence,
            "method": "madmom_rnn_downbeat",
            "fallback": False
        }

    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        return {"error": str(e), "fallback": True}


def calculate_confidence(downbeats, meter):
    """计算 downbeat 检测的置信度"""
    if len(downbeats) < 2:
        return 0.3

    intervals = [downbeats[i+1] - downbeats[i] for i in range(len(downbeats)-1)]
    if not intervals:
        return 0.3

    mean_interval = sum(intervals) / len(intervals)
    if mean_interval == 0:
        return 0.3

    variance = sum((x - mean_interval)**2 for x in intervals) / len(intervals)
    cv = (variance ** 0.5) / mean_interval

    confidence = max(0.3, min(0.95, 1.0 - cv * 2))
    return round(confidence, 2)


def estimate_bpm(beats):
    """从 beat 时间估算 BPM"""
    if len(beats) < 2:
        return 120.0

    intervals = [beats[i+1] - beats[i] for i in range(len(beats)-1)]
    if not intervals:
        return 120.0

    median_interval = sorted(intervals)[len(intervals)//2]
    if median_interval == 0:
        return 120.0

    bpm = 60.0 / median_interval

    if bpm < 60:
        bpm *= 2
    elif bpm > 200:
        bpm /= 2

    return round(bpm, 2)


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: py -3.10 beat_downbeat_service.py <audio_file>"}))
        sys.exit(1)

    audio_path = sys.argv[1]
    result = detect_beats(audio_path)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()