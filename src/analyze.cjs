// MuseAI 音乐分析 v6 (导演视角: 每个字段都有用)
// 改动要点:
//   - 砍掉对导演无用字段 (top_loudness/brightness_segments, bpm_percival, 裸 loudness, brightness 均值等)
//   - 三层语义组织: Layer1 LUFS 曲线 | Layer2 Loudness 峰值 | Layer3 DynComplexity 剪辑密度
//   - 强拍/次强拍整曲标注(不再受 P60 过滤), 弱起通过 phase 自然表达
//   - 和弦走向整曲(24 模板匹配), 接 SongFormer 硬锚点修 downbeat 相位
//   - BPM 风格分类: raw + perceived + genre_hint
//   - 人声时间轴: PredominantPitchMelodia

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const wav = require('node-wav');
const { EssentiaWASM, Essentia } = require('essentia.js');
const { detectLanguage, shouldExcludeChineseGenres, getLanguageName } = require('./detect_language.cjs');

// ========== madmom Python 服务调用 ==========
// 使用 madmom 检测 beat/downbeat/time_signature
function callMadmomService(audioPath) {
  // 支持环境变量指定的 Python 脚本目录
  const scriptsDir = process.env.PYTHON_SCRIPTS_DIR || __dirname;
  const scriptPath = path.join(scriptsDir, 'beat_downbeat_service.py');

  // 检查 Python 脚本是否存在
  if (!fs.existsSync(scriptPath)) {
    return { error: 'madmom service script not found', fallback: true };
  }

  try {
    // 使用 py -3.10 启动器调用 Python 3.10
    const result = spawnSync('py', ['-3.10', scriptPath, audioPath], {
      encoding: 'utf-8',
      timeout: 120000,  // 2分钟超时
      maxBuffer: 10 * 1024 * 1024  // 10MB buffer
    });

    if (result.error) {
      return { error: `Failed to run Python 3.10: ${result.error.message}`, fallback: true };
    }

    if (result.status !== 0) {
      return { error: `Python exited with code ${result.status}: ${result.stderr}`, fallback: true };
    }

    const jsonStr = result.stdout.trim();
    if (!jsonStr) {
      return { error: 'Empty output from madmom service', fallback: true };
    }

    const data = JSON.parse(jsonStr);
    return data;

  } catch (e) {
    return { error: `madmom service error: ${e.message}`, fallback: true };
  }
}

// ========== 重拍类型分析 (beat_weight_analysis.py) ==========
// 分析歌曲的"重拍"是强拍还是次强拍
function callBeatWeightAnalysis(audioPath, downbeats, mediumBeats) {
  // 支持环境变量指定的 Python 脚本目录
  const scriptsDir = process.env.PYTHON_SCRIPTS_DIR || __dirname;
  const scriptPath = path.join(scriptsDir, 'beat_weight_analysis.py');

  // 检查 Python 脚本是否存在
  if (!fs.existsSync(scriptPath)) {
    return { error: 'beat_weight_analysis.py not found', weight_type: 'mixed', confidence: 0 };
  }

  // 如果没有足够的 beat 数据，返回 mixed
  if (!downbeats || downbeats.length < 3 || !mediumBeats || mediumBeats.length < 3) {
    return { error: 'insufficient beat data', weight_type: 'mixed', confidence: 0 };
  }

  try {
    // 使用 py -3.10 启动器调用 Python 3.10
    const result = spawnSync('py', [
      '-3.10',
      scriptPath,
      audioPath,
      JSON.stringify(downbeats),
      JSON.stringify(mediumBeats)
    ], {
      encoding: 'utf-8',
      timeout: 60000,  // 1分钟超时
      maxBuffer: 5 * 1024 * 1024  // 5MB buffer
    });

    if (result.error) {
      return { error: `Failed to run Python 3.10: ${result.error.message}`, weight_type: 'mixed', confidence: 0 };
    }

    if (result.status !== 0) {
      return { error: `Python exited with code ${result.status}: ${result.stderr}`, weight_type: 'mixed', confidence: 0 };
    }

    const jsonStr = result.stdout.trim();
    if (!jsonStr) {
      return { error: 'Empty output from beat_weight_analysis', weight_type: 'mixed', confidence: 0 };
    }

    const data = JSON.parse(jsonStr);
    return data;

  } catch (e) {
    return { error: `beat_weight_analysis error: ${e.message}`, weight_type: 'mixed', confidence: 0 };
  }
}

let _essentia = null;
function getEssentia() {
  if (_essentia) return _essentia;
  const wasmMod = typeof EssentiaWASM === 'function' ? EssentiaWASM : (EssentiaWASM.EssentiaWASM || EssentiaWASM);
  _essentia = new Essentia(wasmMod);
  return _essentia;
}

function decodeToMonoWav(inputPath) {
  const tmp = inputPath + '.__tmp.wav';
  execFileSync(ffmpegPath, ['-y', '-i', inputPath, '-ar', '44100', '-ac', '1', '-f', 'wav', tmp], { stdio: 'ignore' });
  const buf = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  return buf;
}

// ========== Layer 1: LUFS short-term timeline (情绪高度曲线) ==========
// 用 EBUR128 的 shortTermLoudness (3s 滑窗, 每 100ms 一点), 降采样到 0.5s 便于展示
function computeLoudnessTimeline(samples, sr) {
  const essentia = getEssentia();
  const vec = essentia.arrayToVector(samples);
  let out = { shortterm: [], momentary: [], dt: 0.1 };
  try {
    const r = essentia.LoudnessEBUR128(vec, vec, 0.1, sr, true);
    const stSize = r.shortTermLoudness.size();
    const mSize = r.momentaryLoudness.size();
    const st = new Float32Array(stSize), mm = new Float32Array(mSize);
    for (let i = 0; i < stSize; i++) st[i] = r.shortTermLoudness.get(i);
    for (let i = 0; i < mSize; i++) mm[i] = r.momentaryLoudness.get(i);
    out = { shortterm: st, momentary: mm, dt: 0.1, integrated: r.integratedLoudness, range: r.loudnessRange };
  } catch (e) {
    out.error = String(e.message || e);
  }
  vec.delete?.();
  // 0.5s 降采样 timeline (给报告用)
  const step = 5; // 0.1s * 5 = 0.5s
  const tl = [];
  for (let i = 0; i < out.shortterm.length; i += step) {
    const t = +((i * out.dt)).toFixed(2);
    const lufs_st = out.shortterm[i];
    tl.push({ t, lufs_st: +lufs_st.toFixed(2) });
  }
  return { timeline: tl, shortterm_raw: out.shortterm, dt_raw: out.dt, integrated: out.integrated, range: out.range };
}

// ========== Top-N 高能时间段 (连续爆发区) ==========
// 10s 滑窗扫 loudness_timeline, 取 top-N 非重叠窗; 给导演挑 "最炸的 N 段" 做 chorus/drop 剪辑
function findTopLoudSegments(timeline, winSec = 10, topN = 3) {
  if (!timeline || !timeline.length) return [];
  const hopSec = timeline.length > 1 ? (timeline[1].t - timeline[0].t) : 0.5;
  const winHops = Math.max(1, Math.round(winSec / hopSec));
  if (timeline.length < winHops) {
    // 歌太短直接返回整段均值
    const sum = timeline.reduce((s, x) => s + x.lufs_st, 0);
    return [{ start: +timeline[0].t.toFixed(2), end: +timeline[timeline.length - 1].t.toFixed(2), avg_lufs: +(sum / timeline.length).toFixed(2) }];
  }
  const scores = [];
  for (let i = 0; i + winHops <= timeline.length; i++) {
    let sum = 0;
    for (let j = 0; j < winHops; j++) sum += timeline[i + j].lufs_st;
    scores.push({ idx: i, avg: sum / winHops });
  }
  scores.sort((a, b) => b.avg - a.avg);
  const picked = [];
  const used = new Set();
  for (const w of scores) {
    let overlap = false;
    for (let k = w.idx; k < w.idx + winHops; k++) if (used.has(k)) { overlap = true; break; }
    if (overlap) continue;
    for (let k = w.idx; k < w.idx + winHops; k++) used.add(k);
    picked.push({
      start: +timeline[w.idx].t.toFixed(2),
      end: +timeline[Math.min(timeline.length - 1, w.idx + winHops - 1)].t.toFixed(2),
      avg_lufs: +w.avg.toFixed(2),
    });
    if (picked.length >= topN) break;
  }
  picked.sort((a, b) => a.start - b.start);
  return picked;
}

// ========== Layer 2: Loudness peaks (爆点触发帧) ==========
// 基于 momentaryLoudness (400ms 窗) 找突变峰值:
//   一阶差分 peak (前面安静 → 突然变响), 而非绝对 max. 这才是 drop/kick 的"切镜扳机"
function detectLoudnessPeaks(momentary, dt) {
  if (!momentary || !momentary.length) return [];
  // 一阶差分 = 后向 0.5s 均值 − 前向 0.5s 均值
  const halfWin = Math.round(0.5 / dt);
  const diff = new Float32Array(momentary.length);
  for (let i = halfWin; i < momentary.length - halfWin; i++) {
    let pre = 0, post = 0;
    for (let j = 1; j <= halfWin; j++) { pre += momentary[i - j]; post += momentary[i + j]; }
    pre /= halfWin; post /= halfWin;
    diff[i] = post - pre;
  }
  // 找 diff 的局部峰值, 阈值 >= 1.5 dB
  const peaks = [];
  const nonOverlap = Math.round(0.8 / dt); // 相邻峰值至少间隔 0.8s
  let lastIdx = -nonOverlap;
  for (let i = 1; i < diff.length - 1; i++) {
    if (diff[i] < 1.5) continue;
    if (diff[i] <= diff[i - 1] || diff[i] < diff[i + 1]) continue;
    if (i - lastIdx < nonOverlap) continue;
    peaks.push({ t: +(i * dt).toFixed(2), delta_lufs: +diff[i].toFixed(2), lufs: +momentary[i].toFixed(2) });
    lastIdx = i;
  }
  return peaks;
}

// ========== 弱起 + step/phase 检测(phrase 硬锚点) ==========
// 每 beat 的低频 flux → kick 强度
function computeBeatKickStrengths(samples, sr, beats) {
  const essentia = getEssentia();
  const vec = essentia.arrayToVector(samples);
  let lpSignal;
  try { lpSignal = essentia.LowPass(vec, 150, sr).signal; }
  catch (e) { vec.delete?.(); return beats.map(() => 0); }
  vec.delete?.();
  const n = lpSignal.size();
  const lp = new Float32Array(n);
  for (let i = 0; i < n; i++) lp[i] = lpSignal.get(i);
  lpSignal.delete?.();
  const frameSize = Math.round(0.010 * sr);
  const hopSize = Math.round(0.005 * sr);
  const nFrames = Math.max(0, Math.floor((n - frameSize) / hopSize));
  const rms = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    const s = f * hopSize;
    let sum = 0;
    for (let i = s; i < s + frameSize; i++) sum += lp[i] * lp[i];
    rms[f] = Math.sqrt(sum / frameSize);
  }
  const flux = new Float32Array(nFrames);
  for (let f = 1; f < nFrames; f++) flux[f] = Math.max(0, rms[f] - rms[f - 1]);
  const secPerFrame = hopSize / sr;
  return beats.map(t => {
    const sf = Math.max(0, Math.floor((t - 0.005) / secPerFrame));
    const ef = Math.min(nFrames, Math.ceil((t + 0.030) / secPerFrame));
    let peak = 0;
    for (let f = sf; f < ef; f++) if (flux[f] > peak) peak = flux[f];
    return peak;
  });
}

// 以 phrase 起点为硬锚: 第一个 downbeat 必须在某个非 silence/intro 的 phrase 起点附近
// 找 score >= 顶峰 70% 的候选中, 与 phrase 起点最贴合的
function detectStepPhaseWithAnchor(beats, strengths, phraseBoundaries) {
  const STEPS = [4]; // 一期限定 4/4
  const candidates = [];
  for (const step of STEPS) {
    for (let phase = 0; phase < step; phase++) {
      const dbIdxs = new Set();
      for (let i = phase; i < beats.length; i += step) dbIdxs.add(i);
      if (dbIdxs.size < 2) continue;
      let dbSum = 0, dbN = 0, ndbSum = 0, ndbN = 0;
      for (let i = 0; i < beats.length; i++) {
        if (dbIdxs.has(i)) { dbSum += strengths[i]; dbN++; }
        else { ndbSum += strengths[i]; ndbN++; }
      }
      if (!dbN || !ndbN) continue;
      const dbAvg = dbSum / dbN, ndbAvg = ndbSum / ndbN;
      const score = (dbAvg - ndbAvg) / (Math.abs(dbAvg) + Math.abs(ndbAvg) + 1e-9);
      candidates.push({ step, phase, score, dbAvg, ndbAvg });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length) return { step: 4, phase: 0, score: 0, anchor_used: false };

  // phrase 硬锚: 找相位相近 phrase 起点的候选
  // 三种触发条件 (任一满足都用 anchor):
  //   (a) top score < 0.25 — 纯信号分离度低, 不可靠, 交给 phrase
  //   (b) top 与第二名差距 < max(0.03, |top|*0.3) — tie 区
  //   (c) 所有候选 score 都 < 0.4 — 无强信号
  const bounds = (phraseBoundaries || []).filter(b => typeof b === 'number' && b > 0.5);
  if (bounds.length >= 2) {
    const top = candidates[0].score;
    const second = candidates[1]?.score ?? -1;
    const tieGap = Math.max(0.03, Math.abs(top) * 0.3);
    const forceByLowScore = top < 0.25;
    const tieTriggered = top - second < tieGap;
    const allWeak = candidates.every(c => c.score < 0.4);
    const acceptable = (forceByLowScore || tieTriggered || allWeak) ? candidates : [];
    if (acceptable.length >= 2) {
      // 每个 acceptable 候选: 它的 downbeat 序列与 phrase 起点的中位距离
      for (const c of acceptable) {
        const dbTimes = [];
        for (let i = c.phase; i < beats.length; i += c.step) dbTimes.push(beats[i]);
        const dists = bounds.map(b => {
          let d = Infinity;
          for (const t of dbTimes) { const dd = Math.abs(t - b); if (dd < d) d = dd; }
          return d;
        });
        dists.sort((a, b) => a - b);
        c.boundary_median = dists[Math.floor(dists.length / 2)];
      }
      acceptable.sort((a, b) => a.boundary_median - b.boundary_median);
      const best = acceptable[0];
      return { step: best.step, phase: best.phase, score: +best.score.toFixed(4), anchor_used: true, anchor_trigger: forceByLowScore ? 'low_score' : tieTriggered ? 'tie' : 'all_weak', boundary_median: +(best.boundary_median || 0).toFixed(3) };
    }
  }
  const best = candidates[0];
  return { step: best.step, phase: best.phase, score: +best.score.toFixed(4), anchor_used: false };
}

// ========== 段落级 Beat 时间精确定位 ==========
// 核心思路：
// 1. 利用动态 BPM 曲线，每个段落用自己的 BPM
// 2. 找到高置信度锚点（高能段落的强拍）
// 3. 从锚点向两侧延伸，用段落级 BPM 预测 beat 位置
// 4. 在预测位置附近搜索能量峰值，精确定位
// 5. 低能量段落沿用高能量段落的偏移判断

function refineBeatTimesBySection(samples, sr, beats, bpmSegments, phrases, globalBpm) {
  if (!beats || beats.length < 2) return { refined: beats, offsets: [], confidences: [], sectionShifts: [] };

  const essentia = getEssentia();
  const vec = essentia.arrayToVector(samples);

  // 提取低频信号 (kick/bass 能量)
  let lpSignal;
  try { lpSignal = essentia.LowPass(vec, 80, sr).signal; }
  catch (e) { vec.delete?.(); return { refined: beats, offsets: [], confidences: [], sectionShifts: [] }; }
  vec.delete?.();

  const n = lpSignal.size();
  const lp = new Float32Array(n);
  for (let i = 0; i < n; i++) lp[i] = lpSignal.get(i);
  lpSignal.delete?.();

  // 计算 RMS 包络 (10ms frame, 5ms hop)
  const frameSize = Math.round(0.010 * sr);
  const hopSize = Math.round(0.005 * sr);
  const nFrames = Math.max(0, Math.floor((n - frameSize) / hopSize));
  const rms = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    const s = f * hopSize;
    let sum = 0;
    for (let i = s; i < s + frameSize; i++) sum += lp[i] * lp[i];
    rms[f] = Math.sqrt(sum / frameSize);
  }

  // 计算 flux (能量变化率) - 更适合找 attack
  const flux = new Float32Array(nFrames);
  for (let f = 1; f < nFrames; f++) {
    flux[f] = Math.max(0, rms[f] - rms[f - 1]);
  }

  const secPerFrame = hopSize / sr;

  // 辅助函数：在指定范围内找 flux 峰值
  const findPeakInRange = (centerFrame, rangeFrames) => {
    const sf = Math.max(0, Math.floor(centerFrame - rangeFrames));
    const ef = Math.min(nFrames, Math.ceil(centerFrame + rangeFrames));
    let maxFlux = 0, peakFrame = centerFrame;
    for (let f = sf; f < ef; f++) {
      if (flux[f] > maxFlux) {
        maxFlux = flux[f];
        peakFrame = f;
      }
    }
    return { peakFrame, maxFlux };
  };

  // 辅助函数：计算指定时间点的能量得分
  const getEnergyScore = (time, rangeMs = 30) => {
    const frame = time / secPerFrame;
    const range = (rangeMs / 1000) / secPerFrame;
    const { maxFlux } = findPeakInRange(frame, range);
    return maxFlux;
  };

  // ==================== 阶段1：确定段落及其 BPM ====================
  const sections = bpmSegments && bpmSegments.length > 0
    ? bpmSegments
    : phrases && phrases.length > 0
      ? phrases.map(p => ({ start: p.start, end: p.end, bpm: globalBpm, label: p.label }))
      : [{ start: 0, end: beats[beats.length - 1] + 1, bpm: globalBpm, label: 'full' }];

  // ==================== 阶段2：先确定全局的半拍偏移方向 ====================
  // 只用高能量段落来判断，避免低能量段落的误导
  let globalShiftDecision = false;
  let highEnergySections = sections.filter(sec => {
    // 找高能段落：能量带为 high 或 mid
    const phrase = phrases.find(p => Math.abs(p.start - sec.start) < 1);
    return phrase && (phrase.energy_band === 'high' || phrase.energy_band === 'mid');
  });

  // 如果没有高能段落，用中间段落
  if (highEnergySections.length === 0) {
    highEnergySections = sections.length > 2
      ? [sections[Math.floor(sections.length / 2)]]
      : sections;
  }

  // 对高能段落计算偏移得分
  let totalScoreCurrent = 0, totalScoreHalfBeat = 0;
  const beatInterval = 60 / globalBpm;
  const halfBeat = beatInterval / 2;

  for (const sec of highEnergySections) {
    const secBeats = beats.filter(t => t >= sec.start && t < sec.end);
    const testCount = Math.min(8, secBeats.length);

    for (let i = 0; i < testCount; i++) {
      const bt = secBeats[i];
      totalScoreCurrent += getEnergyScore(bt, 25);
      totalScoreHalfBeat += getEnergyScore(bt + halfBeat, 25);
    }
  }

  // 只有当得分差距足够大，且绝对得分足够高时才做偏移
  const minScoreThreshold = 0.1;  // 最低得分阈值
  globalShiftDecision = totalScoreHalfBeat > totalScoreCurrent * 1.3
    && totalScoreHalfBeat > minScoreThreshold;

  // ==================== 阶段3：对每个段落做精细校准 ====================
  const refined = [];
  const offsets = [];
  const confidences = [];
  const sectionShifts = [];

  for (const sec of sections) {
    const secBpm = sec.bpm || globalBpm;
    const secBeatInterval = 60 / secBpm;
    const searchRangeMs = 50;  // 固定 50ms 搜索范围
    const searchFrames = (searchRangeMs / 1000) / secPerFrame;

    // 找到该段落内的原始 beats
    const secBeats = beats.filter(t => t >= sec.start - 0.1 && t < sec.end + 0.1);
    if (secBeats.length < 2) continue;

    // 使用全局偏移判断
    const needShift = globalShiftDecision;

    sectionShifts.push({
      section: sec.label || `${sec.start.toFixed(1)}-${sec.end.toFixed(1)}`,
      start: sec.start,
      shifted: needShift,
      globalDecision: true
    });

    // 找到该段落的锚点 beat（能量最高的那个）
    let anchorBeat = null;
    let maxBeatEnergy = 0;

    for (const bt of secBeats) {
      let targetTime = needShift ? bt + halfBeat : bt;
      const energy = getEnergyScore(targetTime, 20);
      if (energy > maxBeatEnergy) {
        maxBeatEnergy = energy;
        anchorBeat = bt;
      }
    }

    // 对锚点做偏移和校准
    if (anchorBeat !== null) {
      let anchorTargetTime = needShift ? anchorBeat + halfBeat : anchorBeat;
      const anchorFrame = anchorTargetTime / secPerFrame;
      const { peakFrame, maxFlux: anchorFlux } = findPeakInRange(anchorFrame, searchFrames);
      const refinedAnchorTime = peakFrame * secPerFrame;

      // 从锚点向两侧延伸
      const secRefined = [];

      // 向后延伸
      let t = refinedAnchorTime;
      while (t < sec.end + 0.5) {
        const frame = t / secPerFrame;
        const { peakFrame, maxFlux } = findPeakInRange(frame, searchFrames);
        const refinedTime = peakFrame * secPerFrame;

        if (refinedTime >= sec.start - 0.1 && refinedTime < sec.end + 0.1) {
          secRefined.push({ time: refinedTime, flux: maxFlux });
        }
        t += secBeatInterval;
      }

      // 向前延伸
      t = refinedAnchorTime - secBeatInterval;
      while (t >= sec.start - 0.5) {
        const frame = t / secPerFrame;
        const { peakFrame, maxFlux } = findPeakInRange(frame, searchFrames);
        const refinedTime = peakFrame * secPerFrame;

        if (refinedTime >= sec.start - 0.1 && refinedTime < sec.end + 0.1) {
          secRefined.push({ time: refinedTime, flux: maxFlux });
        }
        t -= secBeatInterval;
      }

      // 排序并添加到结果
      secRefined.sort((a, b) => a.time - b.time);
      for (const r of secRefined) {
        if (r.time >= 0) {
          const nearestOriginal = beats.reduce((p, c) =>
            Math.abs(c - r.time) < Math.abs(p - r.time) ? c : p
          );
          const offset = r.time - nearestOriginal;

          refined.push(r.time);
          offsets.push(offset);

          const avgFlux = flux.reduce((a, b) => a + b, 0) / flux.length || 1;
          const fluxScore = Math.min(1, r.flux / (avgFlux * 3));
          const conf = Math.min(1, fluxScore);
          confidences.push(+conf.toFixed(3));
        }
      }
    }
  }

  // ==================== 阶段4：全局排序和去重 ====================
  const combined = refined.map((t, i) => ({
    time: t,
    offset: offsets[i],
    confidence: confidences[i]
  }));

  combined.sort((a, b) => a.time - b.time);

  const globalInterval = 60 / globalBpm;
  const minGap = globalInterval * 0.3;
  const deduped = [];

  for (const item of combined) {
    const last = deduped[deduped.length - 1];
    if (!last || item.time - last.time >= minGap) {
      deduped.push(item);
    } else if (item.confidence > last.confidence) {
      deduped[deduped.length - 1] = item;
    }
  }

  return {
    refined: deduped.map(d => +d.time.toFixed(3)),
    offsets: deduped.map(d => +d.offset.toFixed(3)),
    confidences: deduped.map(d => d.confidence),
    sectionShifts,
    globalShiftDecision
  };
}

// 辅助函数：在指定范围内找 flux 峰值（保留兼容性）
function findPeakFlux(flux, center, range) {
  const sf = Math.max(0, center - range);
  const ef = Math.min(flux.length, center + range);
  let maxVal = 0;
  for (let f = sf; f < ef; f++) {
    if (flux[f] > maxVal) maxVal = flux[f];
  }
  return maxVal;
}

// 整曲 downbeats + medium_beats + fill_beats (不再受能量过滤)
// 同时返回每个 beat 的原始索引，用于获取置信度
function extractBeatLayers(beats, phase, step, confidences = null) {
  const p = ((phase % step) + step) % step;
  const mid = Math.floor(step / 2);
  const midPhase = (p + mid) % step;
  const downbeats = [], mediums = [], fills = [];
  const downbeatIndices = [], mediumIndices = [], fillIndices = [];

  for (let i = 0; i < beats.length; i++) {
    const m = i % step;
    if (m === p) {
      downbeats.push(beats[i]);
      downbeatIndices.push(i);
    }
    else if (m === midPhase) {
      mediums.push(beats[i]);
      mediumIndices.push(i);
    }
    else {
      fills.push(beats[i]);
      fillIndices.push(i);
    }
  }

  // 如果有置信度数组，提取对应的置信度
  const downbeatConfidences = confidences ? downbeatIndices.map(i => confidences[i] || 0) : null;
  const mediumConfidences = confidences ? mediumIndices.map(i => confidences[i] || 0) : null;

  return {
    downbeats, mediums, fills,
    downbeatIndices, mediumIndices, fillIndices,
    downbeatConfidences, mediumConfidences
  };
}

// ========== 多特征 beat 得分计算 ==========
// 对每个 beat 计算多个特征得分: 低频能量、频谱变化、响度、和声
function computeBeatFeatureScores(samples, sr, beats, loudnessTimeline, chordTimeline) {
  const essentia = getEssentia();
  const vec = essentia.arrayToVector(samples);
  const n = samples.length;

  // 1. 低频能量曲线 (LowPass 150Hz)
  let lpSignal;
  try { lpSignal = essentia.LowPass(vec, 150, sr).signal; }
  catch (e) { vec.delete?.(); return beats.map(() => ({ lowFreq: 0, spectralChange: 0, loudness: 0, harmonic: 0 })); }

  const lpArr = new Float32Array(lpSignal.size());
  for (let i = 0; i < lpSignal.size(); i++) lpArr[i] = lpSignal.get(i);
  lpSignal.delete?.();

  // 2. 高频能量曲线 (HighPass 2000Hz) - 用于 hihat 检测
  let hpSignal;
  try { hpSignal = essentia.HighPass(vec, 2000, sr).signal; }
  catch (e) { /* ignore */ }
  const hpArr = hpSignal ? new Float32Array(hpSignal.size()) : null;
  if (hpArr) for (let i = 0; i < hpSignal.size(); i++) hpArr[i] = hpSignal.get(i);
  hpSignal?.delete?.();

  // 3. 中频能量曲线 (BandPass 200-2000Hz)
  let bpSignal;
  try { bpSignal = essentia.BandPass(vec, 800, 1800, sr).signal; }
  catch (e) { /* ignore */ }
  const bpArr = bpSignal ? new Float32Array(bpSignal.size()) : null;
  if (bpArr) for (let i = 0; i < bpSignal.size(); i++) bpArr[i] = bpSignal.get(i);
  bpSignal?.delete?.();

  vec.delete?.();

  // 计算分帧能量
  const frameSize = Math.round(0.02 * sr);
  const hopSize = Math.round(0.01 * sr);
  const nFrames = Math.max(0, Math.floor((n - frameSize) / hopSize));
  const dt = hopSize / sr;

  const lowE = new Float32Array(nFrames);
  const highE = new Float32Array(nFrames);
  const midE = new Float32Array(nFrames);
  const totalE = new Float32Array(nFrames);

  for (let f = 0; f < nFrames; f++) {
    const s = f * hopSize;
    let lSum = 0, hSum = 0, mSum = 0, tSum = 0;
    for (let i = s; i < s + frameSize && i < n; i++) {
      const samp = samples[i];
      tSum += samp * samp;
      if (i < lpArr.length) lSum += lpArr[i] * lpArr[i];
      if (hpArr && i < hpArr.length) hSum += hpArr[i] * hpArr[i];
      if (bpArr && i < bpArr.length) mSum += bpArr[i] * bpArr[i];
    }
    lowE[f] = Math.sqrt(lSum / frameSize);
    highE[f] = Math.sqrt(hSum / frameSize);
    midE[f] = Math.sqrt(mSum / frameSize);
    totalE[f] = Math.sqrt(tSum / frameSize);
  }

  // 计算低频 flux (突变检测)
  const lowFlux = new Float32Array(nFrames);
  for (let f = 1; f < nFrames; f++) lowFlux[f] = Math.max(0, lowE[f] - lowE[f - 1]);

  // 为每个 beat 计算得分
  const scores = beats.map((t, idx) => {
    const frameIdx = Math.round(t / dt);

    // 低频能量得分 (kick 强度)
    let lowFreqScore = 0;
    const lfStart = Math.max(0, frameIdx - 2);
    const lfEnd = Math.min(nFrames, frameIdx + 3);
    for (let f = lfStart; f < lfEnd; f++) {
      if (lowFlux[f] > lowFreqScore) lowFreqScore = lowFlux[f];
    }

    // 频谱变化得分 (总能量突变)
    let spectralScore = 0;
    for (let f = Math.max(1, lfStart); f < lfEnd; f++) {
      const change = Math.abs(totalE[f] - totalE[f - 1]);
      if (change > spectralScore) spectralScore = change;
    }

    // 响度得分 (从 loudnessTimeline)
    let loudnessScore = 0;
    if (loudnessTimeline && loudnessTimeline.length) {
      const ltPoint = loudnessTimeline.find(x => Math.abs(x.t - t) < 0.3);
      if (ltPoint) loudnessScore = Math.max(0, ltPoint.lufs_st + 30) / 30; // 归一化
    }

    // 和声得分 (和弦变化点)
    let harmonicScore = 0;
    if (chordTimeline && chordTimeline.length) {
      const chordPoint = chordTimeline.find(x => Math.abs(x.t - t) < 0.15);
      if (chordPoint && chordPoint.conf < 0.7) harmonicScore = 0.5; // 不确定性高可能意味着变化
      // 检查是否是和弦变化点
      const nextChord = chordTimeline.find(x => x.t > t && x.t < t + 0.5);
      if (nextChord && Math.abs(nextChord.t - t) < 0.15) harmonicScore = 1;
    }

    return {
      lowFreq: lowFreqScore,
      spectralChange: spectralScore,
      loudness: loudnessScore,
      harmonic: harmonicScore,
      // 综合得分
      combined: lowFreqScore * 0.4 + spectralScore * 0.25 + loudnessScore * 0.2 + harmonicScore * 0.15
    };
  });

  return scores;
}

// ========== 拍号检测 ==========
// 通过分析 beat 能量的周期性来推断拍号
// 关键改进：
// 1. 区分 2/4 和 4/4 拍
// 2. 对于不同风格使用不同的默认值
function detectMeter(beats, beatScores, genreHint) {
  if (!beats || beats.length < 8 || !beatScores || beatScores.length < 8) {
    return { meter: 4, confidence: 0 };
  }

  // EDM / 电子舞曲风格默认 4/4 拍
  const edmGenres = ['edm_house', 'trap', 'electronic_dance', 'ethnic_electronic', 'uptempo'];
  const isEdm = edmGenres.includes(genreHint);

  // 尝试不同的拍号: 2, 3, 4, 6
  const candidates = [];

  for (const step of [2, 3, 4, 6]) {
    let dbSum = 0, dbN = 0;
    let otherSum = 0, otherN = 0;

    for (let i = 0; i < beats.length; i++) {
      const score = beatScores[i].downbeatScore;
      if (i % step === 0) {
        dbSum += score;
        dbN++;
      } else {
        otherSum += score;
        otherN++;
      }
    }

    if (dbN < 2 || otherN < 2) continue;

    const dbAvg = dbSum / dbN;
    const otherAvg = otherSum / otherN;
    const scoreDiff = dbAvg - otherAvg;

    // 一致性：每个"小节"内得分最高的 beat 是否在第一个位置
    let consistency = 0;
    const bars = Math.floor(beats.length / step);
    for (let bar = 0; bar < bars; bar++) {
      let maxScore = -1, maxPos = 0;
      for (let p = 0; p < step; p++) {
        const idx = bar * step + p;
        if (idx < beats.length && beatScores[idx].downbeatScore > maxScore) {
          maxScore = beatScores[idx].downbeatScore;
          maxPos = p;
        }
      }
      if (maxPos === 0) consistency++;
    }
    consistency = bars > 0 ? consistency / bars : 0;

    // 综合评分
    let finalScore = scoreDiff * 0.6 + consistency * 0.4;

    // EDM 风格倾向于 4/4 拍
    if (isEdm && step === 4) {
      finalScore += 0.15;
    }

    candidates.push({
      meter: step,
      dbAvg,
      otherAvg,
      scoreDiff,
      consistency,
      finalScore
    });
  }

  if (candidates.length === 0) {
    return { meter: 4, confidence: 0 };
  }

  // 排序
  candidates.sort((a, b) => b.finalScore - a.finalScore);

  // ==================== 区分 2/4 和 4/4 拍 ====================
  const meter2 = candidates.find(c => c.meter === 2);
  const meter4 = candidates.find(c => c.meter === 4);

  if (meter2 && meter2 === candidates[0] && meter4) {
    // 检查 meter=2 的"强拍"中是否有能量交替
    let evenSum = 0, evenN = 0;  // 第 0, 4, 8... 个 beat
    let oddSum = 0, oddN = 0;    // 第 2, 6, 10... 个 beat

    for (let i = 0; i < beats.length; i++) {
      if (i % 4 === 0) {
        evenSum += beatScores[i].downbeatScore;
        evenN++;
      } else if (i % 4 === 2) {
        oddSum += beatScores[i].downbeatScore;
        oddN++;
      }
    }

    if (evenN > 0 && oddN > 0) {
      const evenAvg = evenSum / evenN;
      const oddAvg = oddSum / oddN;
      const ratio = evenAvg / (oddAvg + 1e-9);

      // 如果偶数位置和奇数位置能量相近（差异 < 10%），更可能是 4/4 拍
      // 因为 4/4 拍的第 1 拍和第 3 拍能量相似
      if (ratio > 0.9 && ratio < 1.1) {
        meter4.finalScore += 0.2;
        candidates.sort((a, b) => b.finalScore - a.finalScore);
      }
      // 如果偶数位置明显更强，也倾向于 4/4 拍
      else if (ratio > 1.1) {
        meter4.finalScore += 0.15;
        candidates.sort((a, b) => b.finalScore - a.finalScore);
      }
    }
  }

  const best = candidates[0];

  return {
    meter: best.meter,
    confidence: best.consistency,
    debug: {
      genreHint,
      isEdm,
      candidates: candidates.map(c => ({
        meter: c.meter,
        scoreDiff: +c.scoreDiff.toFixed(4),
        consistency: +c.consistency.toFixed(3),
        finalScore: +c.finalScore.toFixed(4)
      }))
    }
  };
}

// ========== 增强版 downbeat 检测 (改进版) ==========
// 核心改进：
// 1. 先检测拍号
// 2. 根据拍号选择正确的重拍模式
// 3. 高能量段落锚定 + 多特征融合

function detectDownbeatPhaseRobust(samples, sr, beats, loudnessTimeline, phrases) {
  if (!beats || beats.length < 8) {
    return { step: 4, phase: 0, score: 0, consistency: 0 };
  }

  const essentia = getEssentia();
  const vec = essentia.arrayToVector(samples);
  const n = samples.length;

  // ==================== 1. 计算多特征曲线 ====================
  // 1.1 低频能量 (kick/bass)
  let lpSignal;
  try { lpSignal = essentia.LowPass(vec, 100, sr).signal; }
  catch (e) { vec.delete?.(); return { step: 4, phase: 0, score: 0, consistency: 0 }; }

  const lp = new Float32Array(lpSignal.size());
  for (let i = 0; i < lpSignal.size(); i++) lp[i] = lpSignal.get(i);
  lpSignal.delete?.();

  // 1.2 高频能量 (hihat)
  let hpSignal;
  try { hpSignal = essentia.HighPass(vec, 3000, sr).signal; }
  catch (e) { /* ignore */ }
  const hp = hpSignal ? new Float32Array(hpSignal.size()) : null;
  if (hp) for (let i = 0; i < hpSignal.size(); i++) hp[i] = hpSignal.get(i);
  hpSignal?.delete?.();

  vec.delete?.();

  // 1.3 分帧计算能量
  const frameSize = Math.round(0.02 * sr);
  const hopSize = Math.round(0.01 * sr);
  const nFrames = Math.max(0, Math.floor((n - frameSize) / hopSize));
  const dt = hopSize / sr;

  const lowE = new Float32Array(nFrames);
  const highE = new Float32Array(nFrames);
  const totalE = new Float32Array(nFrames);

  for (let f = 0; f < nFrames; f++) {
    const s = f * hopSize;
    let lSum = 0, hSum = 0, tSum = 0;
    for (let i = s; i < s + frameSize && i < n; i++) {
      tSum += samples[i] * samples[i];
      if (i < lp.length) lSum += lp[i] * lp[i];
      if (hp && i < hp.length) hSum += hp[i] * hp[i];
    }
    lowE[f] = Math.sqrt(lSum / frameSize);
    highE[f] = hp ? Math.sqrt(hSum / frameSize) : 0;
    totalE[f] = Math.sqrt(tSum / frameSize);
  }

  // 1.4 计算多种 flux
  const lowFlux = new Float32Array(nFrames);
  const highFlux = new Float32Array(nFrames);
  const totalFlux = new Float32Array(nFrames);

  for (let f = 1; f < nFrames; f++) {
    lowFlux[f] = Math.max(0, lowE[f] - lowE[f - 1]);
    highFlux[f] = Math.max(0, highE[f] - highE[f - 1]);
    totalFlux[f] = Math.max(0, totalE[f] - totalE[f - 1]);
  }

  // ==================== 2. 为每个 beat 计算多特征得分 ====================
  const beatScores = beats.map((t, idx) => {
    const frameIdx = Math.round(t / dt);
    const searchStart = Math.max(0, frameIdx - 3);
    const searchEnd = Math.min(nFrames, frameIdx + 4);

    // 低频 flux 峰值 (kick 强度)
    let maxLowFlux = 0;
    for (let f = searchStart; f < searchEnd; f++) {
      if (lowFlux[f] > maxLowFlux) maxLowFlux = lowFlux[f];
    }

    // 高频 flux 峰值 (hihat 强度)
    let maxHighFlux = 0;
    for (let f = searchStart; f < searchEnd; f++) {
      if (highFlux[f] > maxHighFlux) maxHighFlux = highFlux[f];
    }

    // 总能量 flux (整体变化)
    let maxTotalFlux = 0;
    for (let f = searchStart; f < searchEnd; f++) {
      if (totalFlux[f] > maxTotalFlux) maxTotalFlux = totalFlux[f];
    }

    // 响度得分
    let loudnessScore = 0;
    if (loudnessTimeline && loudnessTimeline.length) {
      const ltPoint = loudnessTimeline.find(x => Math.abs(x.t - t) < 0.3);
      if (ltPoint) loudnessScore = Math.max(0, ltPoint.lufs_st + 30) / 30;
    }

    return {
      lowFlux: maxLowFlux,
      highFlux: maxHighFlux,
      totalFlux: maxTotalFlux,
      loudness: loudnessScore,
      downbeatScore: maxLowFlux * 0.5 + maxTotalFlux * 0.3 + loudnessScore * 0.2,
      mediumScore: maxHighFlux * 0.4 + maxTotalFlux * 0.3 + loudnessScore * 0.2
    };
  });

  // ==================== 3. 检测拍号 ====================
  // 获取风格信息用于辅助判断
  const genreHint = phrases && phrases.length > 0 ? phrases[0].label : null;
  const meterResult = detectMeter(beats, beatScores, genreHint);
  const step = meterResult.meter;  // 使用检测到的拍号

  // ==================== 4. 找高能量段落作为锚点 ====================
  let anchorSection = null;
  let maxSectionEnergy = 0;

  if (phrases && phrases.length > 0) {
    for (const p of phrases) {
      if (p.energy_band !== 'high' && p.energy_band !== 'mid') continue;

      const secBeats = beats.map((t, i) => ({ t, i }))
        .filter(b => b.t >= p.start && b.t < p.end);

      if (secBeats.length < step) continue;

      let totalEnergy = 0;
      for (const b of secBeats) {
        totalEnergy += beatScores[b.i].downbeatScore;
      }

      if (totalEnergy > maxSectionEnergy) {
        maxSectionEnergy = totalEnergy;
        anchorSection = { start: p.start, end: p.end, beats: secBeats };
      }
    }
  }

  // 如果没有高能段落，用中间部分
  if (!anchorSection) {
    const midStart = beats[Math.floor(beats.length * 0.25)];
    const midEnd = beats[Math.floor(beats.length * 0.75)];
    anchorSection = {
      start: midStart,
      end: midEnd,
      beats: beats.map((t, i) => ({ t, i })).filter(b => b.t >= midStart && b.t < midEnd)
    };
  }

  // ==================== 5. 在锚点段落内检测最优 phase ====================
  const candidates = [];

  for (let phase = 0; phase < step; phase++) {
    let dbSum = 0, dbN = 0;
    let otherSum = 0, otherN = 0;

    for (const b of anchorSection.beats) {
      const relPos = b.i % step;
      const score = beatScores[b.i];

      if (relPos === phase) {
        dbSum += score.downbeatScore;
        dbN++;
      } else {
        otherSum += score.downbeatScore;
        otherN++;
      }
    }

    if (dbN < 1) continue;

    const dbAvg = dbSum / dbN;
    const otherAvg = otherN > 0 ? otherSum / otherN : 0;
    const scoreDiff = dbAvg - otherAvg;

    // 对于 4/4 拍，phase=0 优先（第一个 beat 默认是强拍）
    let bonus = 0;
    if (step === 4 && phase === 0) {
      bonus = 0.05;
    }

    candidates.push({
      phase,
      dbAvg,
      otherAvg,
      scoreDiff,
      finalScore: scoreDiff + bonus
    });
  }

  if (candidates.length === 0) {
    return { step, phase: 0, score: 0, consistency: 0, meter: step };
  }

  // 排序
  candidates.sort((a, b) => b.finalScore - a.finalScore);

  // ==================== 6. 对于 4/4 拍，额外检查 phase=0 vs phase=2 ====================
  // 如果两者能量相近，优先选 phase=0
  if (step === 4) {
    const phase0 = candidates.find(c => c.phase === 0);
    const phase2 = candidates.find(c => c.phase === 2);

    if (phase0 && phase2) {
      // 如果 phase=0 和 phase=2 能量差异小于 10%，优先 phase=0
      const ratio = phase0.dbAvg / (phase2.dbAvg + 1e-9);
      if (ratio > 0.9 && ratio < 1.1 && phase2.finalScore > phase0.finalScore) {
        // 交换位置，让 phase=0 排在前面
        phase0.finalScore = phase2.finalScore + 0.01;
        candidates.sort((a, b) => b.finalScore - a.finalScore);
      }
    }
  }

  // ==================== 7. 验证多小节一致性 ====================
  const topCandidate = candidates[0];

  let consistencyScore = 0;
  const barsChecked = Math.floor(beats.length / step);

  for (let bar = 0; bar < barsChecked; bar++) {
    let maxScore = -1, maxPhase = 0;
    for (let p = 0; p < step; p++) {
      const idx = bar * step + p;
      if (idx < beats.length && beatScores[idx].downbeatScore > maxScore) {
        maxScore = beatScores[idx].downbeatScore;
        maxPhase = p;
      }
    }
    if (maxPhase === topCandidate.phase) consistencyScore++;
  }
  consistencyScore = barsChecked > 0 ? consistencyScore / barsChecked : 0;

  // ==================== 7. Phrase 边界对齐验证 ====================
  const phraseBoundaries = phrases ? phrases.map(p => p.start).filter(t => t > 0.5) : [];
  if (phraseBoundaries.length >= 2) {
    let alignCount = 0;
    for (const bound of phraseBoundaries) {
      for (let i = topCandidate.phase; i < beats.length; i += step) {
        if (Math.abs(beats[i] - bound) < 0.5) {
          alignCount++;
          break;
        }
      }
    }
    const alignScore = phraseBoundaries.length > 0 ? alignCount / phraseBoundaries.length : 0;
    if (alignScore > 0.3) {
      topCandidate.finalScore += alignScore * 0.2;
    }
  }

  return {
    step,
    phase: topCandidate.phase,
    score: topCandidate.scoreDiff,
    consistency: consistencyScore,
    meter: step,
    meterConfidence: meterResult.confidence,
    meterDebug: meterResult.debug,
    debug: {
      dbAvg: topCandidate.dbAvg,
      otherAvg: topCandidate.otherAvg,
      finalScore: topCandidate.finalScore
    }
  };
}

// ========== 详细音乐特征分析 ==========
function analyzeMusicCharacteristics(samples, sr, beats, loudnessTimeline, lufsRange, dynComplexity, bpmRaw, kickStrengths, excludeChineseGenres = false) {
  const essentia = getEssentia();
  const vec = essentia.arrayToVector(samples);
  const n = samples.length;

  // 1. 频谱特征
  // 低频 (0-200Hz)
  let lpSignal;
  try { lpSignal = essentia.LowPass(vec, 200, sr).signal; }
  catch (e) { /* ignore */ }
  const lowFreqArr = lpSignal ? new Float32Array(lpSignal.size()) : null;
  if (lowFreqArr) for (let i = 0; i < lpSignal.size(); i++) lowFreqArr[i] = lpSignal.get(i);
  lpSignal?.delete?.();

  // 高频 (2000Hz+)
  let hpSignal;
  try { hpSignal = essentia.HighPass(vec, 2000, sr).signal; }
  catch (e) { /* ignore */ }
  const highFreqArr = hpSignal ? new Float32Array(hpSignal.size()) : null;
  if (highFreqArr) for (let i = 0; i < hpSignal.size(); i++) highFreqArr[i] = hpSignal.get(i);
  hpSignal?.delete?.();

  // 中频 (200-2000Hz)
  let bpSignal;
  try { bpSignal = essentia.BandPass(vec, 800, 1600, sr).signal; }
  catch (e) { /* ignore */ }
  const midFreqArr = bpSignal ? new Float32Array(bpSignal.size()) : null;
  if (midFreqArr) for (let i = 0; i < bpSignal.size(); i++) midFreqArr[i] = bpSignal.get(i);
  bpSignal?.delete?.();

  vec.delete?.();

  // 计算各频段能量 (使用独立的累积和，然后归一化)
  let lowE = 0, midE = 0, highE = 0;
  const sampleStep = Math.max(1, Math.floor(n / 10000)); // 降采样计算
  for (let i = 0; i < n; i += sampleStep) {
    if (lowFreqArr && i < lowFreqArr.length) lowE += lowFreqArr[i] * lowFreqArr[i];
    if (midFreqArr && i < midFreqArr.length) midE += midFreqArr[i] * midFreqArr[i];
    if (highFreqArr && i < highFreqArr.length) highE += highFreqArr[i] * highFreqArr[i];
  }

  lowE = Math.sqrt(lowE);
  midE = Math.sqrt(midE);
  highE = Math.sqrt(highE);
  const bandTotal = lowE + midE + highE;

  // 归一化比例，确保总和为 1
  const lowFreqRatio = bandTotal > 0 ? lowE / bandTotal : 0;
  const midFreqRatio = bandTotal > 0 ? midE / bandTotal : 0;
  const highFreqRatio = bandTotal > 0 ? highE / bandTotal : 0;

  // 2. 节奏特征
  // kick 密度: 有强 kick 的 beat 占比
  const sortedKicks = [...kickStrengths].sort((a, b) => a - b);
  const kickMedian = sortedKicks[Math.floor(sortedKicks.length / 2)];
  const kickThreshold = kickMedian * 1.5;
  const kickDensity = kickStrengths.filter(k => k > kickThreshold).length / kickStrengths.length;

  // 高频 flux 用于检测 hihat 密度
  const hihatDensity = highFreqRatio > 0.15 ? Math.min(1, highFreqRatio * 3) : highFreqRatio;

  // beat 稳定性: IBI 方差
  let ibiVar = 0, ibiMean = 0;
  if (beats && beats.length > 2) {
    const ibis = [];
    for (let i = 1; i < beats.length; i++) ibis.push(beats[i] - beats[i - 1]);
    ibiMean = ibis.reduce((a, b) => a + b, 0) / ibis.length;
    ibiVar = ibis.reduce((a, b) => a + (b - ibiMean) ** 2, 0) / ibis.length;
  }
  const beatStability = ibiMean > 0 ? Math.max(0, 1 - ibiVar / (ibiMean ** 2)) : 0;

  // 3. 动态特征
  const dynamicRange = lufsRange || 6;
  const rmsVariance = loudnessTimeline && loudnessTimeline.length > 1
    ? Math.sqrt(loudnessTimeline.reduce((a, x) => a + (x.lufs_st - loudnessTimeline.reduce((s, y) => s + y.lufs_st, 0) / loudnessTimeline.length) ** 2, 0) / loudnessTimeline.length)
    : 0;

  // 4. 风格判定
  const genreResult = classifyGenreAdvanced(bpmRaw, {
    lowFreqRatio,
    midFreqRatio,
    highFreqRatio,
    kickDensity,
    hihatDensity,
    beatStability,
    dynamicRange,
    rmsVariance,
    dynComplexity
  }, excludeChineseGenres);

  // 5. 构建输出
  const spectralDesc = [];
  if (lowFreqRatio > 0.35) spectralDesc.push('低频强');
  else if (lowFreqRatio < 0.20) spectralDesc.push('低频弱');
  else spectralDesc.push('低频适中');

  if (highFreqRatio > 0.25) spectralDesc.push('高频强');
  else if (highFreqRatio < 0.10) spectralDesc.push('高频弱');

  const rhythmDesc = [];
  if (kickDensity > 0.5) rhythmDesc.push('kick密集');
  if (hihatDensity > 0.4) rhythmDesc.push('hihat明显');
  if (beatStability > 0.85) rhythmDesc.push('节奏稳定');
  else if (beatStability < 0.6) rhythmDesc.push('节奏自由');

  const dynamicDesc = dynamicRange < 5 ? '动态小(压缩强)' : dynamicRange > 10 ? '动态大(起伏明显)' : '动态适中';

  return {
    spectral: {
      low_freq_ratio: +lowFreqRatio.toFixed(3),
      mid_freq_ratio: +midFreqRatio.toFixed(3),
      high_freq_ratio: +highFreqRatio.toFixed(3),
      description: spectralDesc.join('、')
    },
    rhythm: {
      kick_density: +kickDensity.toFixed(3),
      hihat_density: +hihatDensity.toFixed(3),
      beat_stability: +beatStability.toFixed(3),
      description: rhythmDesc.join('、') || '节奏特征正常'
    },
    dynamic: {
      lufs_range: +(dynamicRange || 0).toFixed(2),
      rms_variance: +rmsVariance.toFixed(4),
      description: dynamicDesc
    },
    genre_analysis: genreResult
  };
}

// 高级风格分类 - 扩展版本
// excludeChineseGenres: 为 true 时排除国风/民族相关标签 (非中文歌曲)
function classifyGenreAdvanced(bpmRaw, features, excludeChineseGenres = false) {
  const {
    lowFreqRatio, highFreqRatio, kickDensity, hihatDensity,
    beatStability, dynamicRange, rmsVariance, dynComplexity
  } = features;

  // 计算各风格的得分
  const scores = {
    // 原有风格
    edm_house: 0,
    trap: 0,
    pop_ballad: 0,
    rock: 0,
    hiphop: 0,
    ambient: 0,
    classical: 0,
    // 新增风格 (中文特有)
    ethnic_electronic: 0,    // 国风/民族电音
    guofeng_pop: 0,          // 国风流行
    ethnic_traditional: 0,    // 民族传统
    // 通用风格
    electronic_dance: 0,      // 电子舞曲
    slow_ballad: 0           // 抒情慢歌
  };

  // 非中文歌曲排除国风标签
  if (excludeChineseGenres) {
    scores.ethnic_electronic = -100;
    scores.guofeng_pop = -100;
    scores.ethnic_traditional = -100;
  }

  // ========== 原有风格判断 ==========

  // EDM / House: 115-135 BPM, 低频强, 动态小, 节奏稳定, kick密集
  if (bpmRaw >= 115 && bpmRaw <= 135) {
    scores.edm_house += 2;
    if (lowFreqRatio > 0.35) scores.edm_house += 1;
    if (dynamicRange < 6) scores.edm_house += 1;
    if (beatStability > 0.9) scores.edm_house += 1;
    if (kickDensity > 0.45) scores.edm_house += 1;
  }

  // Trap: 125-160 BPM, 低频强但 kick 稀疏, hihat 明显
  if (bpmRaw >= 125 && bpmRaw <= 165) {
    scores.trap += 2;
    if (lowFreqRatio > 0.35 && kickDensity < 0.4) scores.trap += 2;
    if (hihatDensity > 0.5) scores.trap += 2;
    if (dynamicRange < 7) scores.trap += 1;
  }

  // Pop Ballad: 100-160 BPM, 动态适中, kick 稀疏 (区别于电子风格)
  if (bpmRaw >= 90 && bpmRaw <= 170) {
    scores.pop_ballad += 1;
    if (dynamicRange > 4) scores.pop_ballad += 1;
    if (dynamicRange > 6) scores.pop_ballad += 1;
    // kick 稀疏是关键特征 (区别于电子舞曲)
    if (kickDensity < 0.35) scores.pop_ballad += 2;
    else if (kickDensity < 0.45) scores.pop_ballad += 1;
    // 高频不太突出 (区别于民族电音)
    if (highFreqRatio < 0.23) scores.pop_ballad += 1;
    // 动态范围小但有流行特征
    if (dynamicRange < 5 && kickDensity < 0.4) scores.pop_ballad += 1;
  }

  // Rock: 95-150 BPM, 中频强, 动态中等
  if (bpmRaw >= 90 && bpmRaw <= 160) {
    scores.rock += 1;
    if (features.midFreqRatio > 0.25) scores.rock += 2;
    if (dynamicRange >= 5 && dynamicRange <= 10) scores.rock += 1;
    if (beatStability > 0.85) scores.rock += 1;
  }

  // Hip-Hop: 75-120 BPM, 低频强, kick 密集
  if (bpmRaw >= 70 && bpmRaw <= 125) {
    scores.hiphop += 2;
    if (lowFreqRatio > 0.35) scores.hiphop += 1;
    if (kickDensity > 0.35) scores.hiphop += 1;
    if (beatStability > 0.9) scores.hiphop += 1;
  }

  // Ambient: 节奏不稳定, 动态大, 低频弱
  if (beatStability < 0.75 && dynamicRange > 7) {
    scores.ambient += 2;
    if (lowFreqRatio < 0.3) scores.ambient += 2;
    if (kickDensity < 0.3) scores.ambient += 1;
  }

  // ========== 新增风格判断 ==========

  // 国风/民族电音: 需要同时满足电子节拍+传统乐器特征
  // 特征: BPM 100-140, 高频明显(传统乐器谐波, >0.23), 低频强(电子节拍), 节奏稳定
  // 关键区分: 必须同时具备高频传统乐器特征+低频电子节拍+高hihat
  let ethnicScore = 0;
  if (bpmRaw >= 100 && bpmRaw <= 140) {
    ethnicScore += 1;
    // 传统乐器特征: 高频能量较高 (>0.23 是关键区分点)
    if (highFreqRatio > 0.23) ethnicScore += 3;
    else if (highFreqRatio > 0.20) ethnicScore += 1;
    // 低频强 (电子节拍)
    if (lowFreqRatio > 0.45) ethnicScore += 1;
    else if (lowFreqRatio > 0.35) ethnicScore += 0.5;
    // 节奏稳定 (电子特征)
    if (beatStability > 0.92) ethnicScore += 1;
    // hihat 明显 (电子元素) - 关键特征
    if (hihatDensity > 0.65) ethnicScore += 2;
    else if (hihatDensity > 0.55) ethnicScore += 1;
    // kick 密度中等 (区别于纯电子舞曲)
    if (kickDensity > 0.30 && kickDensity < 0.45) ethnicScore += 1;
  }
  // 只有在不排除国风标签时才更新分数
  if (!excludeChineseGenres) {
    scores.ethnic_electronic = Math.round(ethnicScore);
  }

  // 国风流行: 人声为主, 传统乐器为辅, 动态适中
  // 特征: BPM 70-130, 高频适中(有传统乐器但不突出), kick稀疏
  if (!excludeChineseGenres && bpmRaw >= 60 && bpmRaw <= 130) {
    scores.guofeng_pop += 1;
    // 高频适中 (传统乐器但不过分突出)
    if (highFreqRatio > 0.15 && highFreqRatio < 0.30) scores.guofeng_pop += 2;
    else if (highFreqRatio >= 0.10 && highFreqRatio <= 0.35) scores.guofeng_pop += 1;
    // 动态适中
    if (dynamicRange >= 4 && dynamicRange <= 8) scores.guofeng_pop += 1;
    // kick 不太密集 (非电子风格)
    if (kickDensity < 0.45) scores.guofeng_pop += 1;
  }

  // 民族传统: 节奏可能不稳, 动态大, 低频相对弱
  // 特征: 无明显电子节拍, 动态起伏大, 高频有传统乐器特征
  if (!excludeChineseGenres && (beatStability < 0.88 || dynamicRange > 7)) {
    let tradScore = 0;
    if (dynamicRange > 6) tradScore += 2;
    if (kickDensity < 0.35) tradScore += 1;
    if (highFreqRatio > 0.20) tradScore += 1;
    if (lowFreqRatio < 0.45) tradScore += 1;
    scores.ethnic_traditional = tradScore;
  }

  // 电子舞曲(广义): 120-150 BPM, 低频强, 节奏稳定, 适合跳舞
  // 关键区分: 低频很强, 但高频不突出(无传统乐器)
  if (bpmRaw >= 115 && bpmRaw <= 155) {
    let edScore = 2;
    if (lowFreqRatio > 0.50) edScore += 3;
    else if (lowFreqRatio > 0.42) edScore += 2;
    else if (lowFreqRatio > 0.35) edScore += 1;
    if (beatStability > 0.95) edScore += 1;
    if (kickDensity > 0.38) edScore += 1;
    if (dynamicRange < 6) edScore += 1;
    // 高频不太突出 (区别于民族电音) - 给低高频加分
    if (highFreqRatio < 0.20) edScore += 2;
    else if (highFreqRatio < 0.23) edScore += 1;
    scores.electronic_dance = edScore;
  }

  // 抒情慢歌: 60-90 BPM (或感知BPM), 动态大, kick稀疏
  if (bpmRaw <= 100 || (bpmRaw >= 100 && bpmRaw <= 160 && kickDensity < 0.35)) {
    scores.slow_ballad += 1;
    if (dynamicRange > 5) scores.slow_ballad += 2;
    if (kickDensity < 0.40) scores.slow_ballad += 1;
    if (lowFreqRatio < 0.50) scores.slow_ballad += 1;
    if (rmsVariance > 2.5) scores.slow_ballad += 1;
  }

  // ========== 找最高分 ==========
  let maxGenre = 'unknown';
  let maxScore = 0;
  for (const [genre, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      maxGenre = genre;
    }
  }

  const sortedScores = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const confidence = maxScore > 0 ? Math.min(0.95, maxScore / (maxScore + 5)) : 0.3;

  // 计算 perceived BPM
  let perceivedBpm = bpmRaw;
  let reasoning = [];

  // 根据风格调整 perceived BPM 和推理
  if (maxGenre === 'edm_house') {
    reasoning.push('BPM ' + bpmRaw + ' 在 EDM 范围(115-135)');
    reasoning.push(lowFreqRatio > 0.35 ? '低频强' : '低频适中');
    reasoning.push(dynamicRange < 6 ? '动态小(压缩强)' : '动态适中');
    reasoning.push('→ EDM/House');
  } else if (maxGenre === 'trap') {
    perceivedBpm = bpmRaw / 2;
    reasoning.push('BPM ' + bpmRaw + ' 在 Trap 范围(125-160)');
    reasoning.push(kickDensity < 0.4 ? 'kick 稀疏' : 'kick 适中');
    reasoning.push(hihatDensity > 0.4 ? 'hihat 明显' : '');
    reasoning.push('→ Trap (感知 BPM = raw/2)');
  } else if (maxGenre === 'ethnic_electronic') {
    reasoning.push('BPM ' + bpmRaw + ' 在民族电音范围(100-150)');
    reasoning.push(highFreqRatio > 0.2 ? '高频明显(传统乐器特征)' : '');
    reasoning.push(lowFreqRatio > 0.4 ? '低频强(电子节拍)' : '');
    reasoning.push('→ 国风/民族电音');
  } else if (maxGenre === 'guofeng_pop') {
    reasoning.push('BPM ' + bpmRaw + ' 在国风流行范围');
    reasoning.push('节奏适中, 动态自然');
    reasoning.push('→ 国风流行');
  } else if (maxGenre === 'ethnic_traditional') {
    reasoning.push('动态范围大, 节奏自由');
    reasoning.push(highFreqRatio > 0.2 ? '高频明显(传统乐器)' : '');
    reasoning.push('→ 民族传统');
  } else if (maxGenre === 'electronic_dance') {
    reasoning.push('BPM ' + bpmRaw + ' 在电子舞曲范围(115-155)');
    reasoning.push(lowFreqRatio > 0.4 ? '低频强' : '');
    reasoning.push(beatStability > 0.95 ? '节奏稳定' : '');
    reasoning.push('→ 电子舞曲');
  } else if (maxGenre === 'slow_ballad') {
    if (bpmRaw >= 100 && bpmRaw <= 160) {
      perceivedBpm = bpmRaw / 2;
      reasoning.push('BPM ' + bpmRaw + ', 感知 BPM = ' + perceivedBpm.toFixed(1));
    }
    reasoning.push(dynamicRange > 5 ? '动态大' : '动态适中');
    reasoning.push('→ 抒情慢歌');
  } else if (maxGenre === 'pop_ballad') {
    if (bpmRaw >= 100 && bpmRaw <= 160) {
      perceivedBpm = bpmRaw / 2;
      reasoning.push('BPM ' + bpmRaw + ', 感知 BPM = raw/2');
    }
    reasoning.push(dynamicRange > 5 ? '动态大' : '动态适中');
    reasoning.push('→ 流行抒情');
  } else if (maxGenre === 'hiphop') {
    reasoning.push('BPM ' + bpmRaw + ' 在 Hip-Hop 范围(70-125)');
    reasoning.push(lowFreqRatio > 0.35 ? '低频强' : '低频适中');
    reasoning.push('→ Hip-Hop');
  } else if (maxGenre === 'rock') {
    reasoning.push('BPM ' + bpmRaw + ' 在 Rock 范围(90-160)');
    reasoning.push(features.midFreqRatio > 0.25 ? '中频强' : '中频适中');
    reasoning.push('→ Rock');
  } else {
    reasoning.push('综合特征判断');
  }

  return {
    primary: maxGenre,
    confidence: +confidence.toFixed(3),
    reasoning: reasoning.filter(r => r).join(' + '),
    typical_bpm_range: getTypicalBpmRange(maxGenre),
    suggested_perceived_bpm: +perceivedBpm.toFixed(2),
    scores: Object.fromEntries(sortedScores.slice(0, 6).map(([k, v]) => [k, v]))
  };
}

function getTypicalBpmRange(genre) {
  const ranges = {
    // 原有风格
    edm_house: '115-135',
    trap: '130-160 (感知 65-80)',
    pop_ballad: '60-80 (感知) / 90-170 (raw)',
    rock: '90-160',
    hiphop: '70-125',
    ambient: '无固定',
    classical: '变化大',
    // 新增风格
    ethnic_electronic: '100-150',
    guofeng_pop: '60-130',
    ethnic_traditional: '变化大',
    electronic_dance: '115-155',
    slow_ballad: '50-80 (感知) / 60-160 (raw)'
  };
  return ranges[genre] || '未知';
}

// ========== 八度错误校正 (Octave Error Correction) ==========
// 解决 RhythmExtractor2013 常见的半速/倍速检测错误

// 快速计算八度校正所需的基础特征 (轻量版, 用于早期校正)
function computeOctaveCorrectionFeatures(samples, sr, beats) {
  const essentia = getEssentia();
  const vec = essentia.arrayToVector(samples);
  const n = samples.length;

  // 1. 频谱特征
  // 低频能量
  let lpSignal;
  try { lpSignal = essentia.LowPass(vec, 200, sr).signal; } catch (e) { /* ignore */ }
  const lowFreqArr = lpSignal ? new Float32Array(lpSignal.size()) : null;
  if (lowFreqArr) for (let i = 0; i < lpSignal.size(); i++) lowFreqArr[i] = lpSignal.get(i);
  lpSignal?.delete?.();

  // 高频能量
  let hpSignal;
  try { hpSignal = essentia.HighPass(vec, 2000, sr).signal; } catch (e) { /* ignore */ }
  const highFreqArr = hpSignal ? new Float32Array(hpSignal.size()) : null;
  if (highFreqArr) for (let i = 0; i < hpSignal.size(); i++) highFreqArr[i] = hpSignal.get(i);
  hpSignal?.delete?.();

  // 计算能量比例
  let totalEnergy = 0, lowEnergy = 0, highEnergy = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    totalEnergy += s * s;
  }
  if (lowFreqArr) for (let i = 0; i < n; i++) lowEnergy += lowFreqArr[i] * lowFreqArr[i];
  if (highFreqArr) for (let i = 0; i < n; i++) highEnergy += highFreqArr[i] * highFreqArr[i];

  const lowFreqRatio = totalEnergy > 0 ? lowEnergy / totalEnergy : 0.3;
  const highFreqRatio = totalEnergy > 0 ? highEnergy / totalEnergy : 0.15;

  // 2. kick/hihat 密度
  let kickDensity = 0, hihatDensity = 0;
  if (beats && beats.length >= 4) {
    const avgInterval = (beats[beats.length - 1] - beats[0]) / (beats.length - 1);
    const expectedBeatInterval = avgInterval;

    // 检测 kick (低频瞬态)
    const kickThreshold = lowFreqRatio * 0.5;
    const hihatThreshold = highFreqRatio * 0.3;

    // 简化估算: 基于 beat 间隔和频谱特征
    // kick 密度 ≈ 低频能量 / beat间隔
    kickDensity = Math.min(1, lowFreqRatio * 1.5);
    // hihat 密度 ≈ 高频能量 / beat间隔
    hihatDensity = Math.min(1, highFreqRatio * 4);
  }

  vec.delete?.();

  return {
    lowFreqRatio: +lowFreqRatio.toFixed(3),
    highFreqRatio: +highFreqRatio.toFixed(3),
    kickDensity: +kickDensity.toFixed(3),
    hihatDensity: +hihatDensity.toFixed(3)
  };
}

function correctOctaveError(bpmRaw, beats, features) {
  const { lowFreqRatio, highFreqRatio, kickDensity, hihatDensity, dynamicRange, dynComplexity, genreAnalysis } = features;

  let correctedBpm = bpmRaw;
  let correctedBeats = beats;
  let correction = 'none'; // 'none' | 'half' | 'double'
  let confidence = 0;

  // === 半速校正: 检测到 120-180，实际可能是 60-90 ===
  // 典型场景: Trap/慢歌被检测到 hihat 16分音符
  // 策略: 先计算 halftimeScore，再结合风格信息综合决策
  const FAST_STYLES = ['edm_house', 'electronic_dance', 'trance', 'techno', 'ethnic_electronic'];
  const SLOW_STYLES = ['slow_ballad', 'pop_ballad', 'guofeng_pop', 'ambient'];

  if (bpmRaw >= 120 && bpmRaw <= 180) {
    const halfBpm = bpmRaw / 2;
    let halftimeScore = 0;

    // 1. 高 hihat 密度 (>0.7) - hihat 被误判为 beat
    if (hihatDensity > 0.75) halftimeScore += 3;
    else if (hihatDensity > 0.65) halftimeScore += 2;
    else if (hihatDensity > 0.5) halftimeScore += 1;

    // 2. 低 kick 密度 (<0.4) - 实际 beat 稀疏
    if (kickDensity < 0.30) halftimeScore += 2;
    else if (kickDensity < 0.40) halftimeScore += 1;

    // 3. 高频明显 (>0.22) - hihat 能量高
    if (highFreqRatio > 0.25) halftimeScore += 2;
    else if (highFreqRatio > 0.20) halftimeScore += 1;

    // 4. 动态复杂度低 (<4) - 慢歌特征
    if (dynComplexity < 3.5) halftimeScore += 2;
    else if (dynComplexity < 4.0) halftimeScore += 1;

    // 5. 半速后 BPM 在合理区间 (55-95)
    if (halfBpm >= 55 && halfBpm <= 95) halftimeScore += 1;

    // === 综合决策： halftimeScore + 风格信息 ===
    const isFastStyle = genreAnalysis && FAST_STYLES.includes(genreAnalysis.primary);
    const isSlowStyle = genreAnalysis && SLOW_STYLES.includes(genreAnalysis.primary);
    const styleConfidence = genreAnalysis ? genreAnalysis.confidence : 0;

    // 决策逻辑：
    // - halftimeScore >= 8: 特征非常明显是慢歌，强制半速
    // - halftimeScore >= 6 且 (慢歌风格 或 风格不明确): 半速校正
    // - halftimeScore >= 6 但快歌风格高置信度: 不校正（保守）
    // - halftimeScore < 6: 不校正

    if (halftimeScore >= 8) {
      // 特征非常明显，即使风格判断是快歌也半速
      correctedBpm = halfBpm;
      correction = 'half';
      confidence = Math.min(0.95, halftimeScore / 10);
      correctedBeats = beats.filter((_, i) => i % 2 === 0);
    } else if (halftimeScore >= 6) {
      // 特征中等明显，结合风格判断
      if (isSlowStyle && styleConfidence >= 0.4) {
        // 慢歌风格确认：半速
        correctedBpm = halfBpm;
        correction = 'half';
        confidence = Math.min(0.90, halftimeScore / 10);
        correctedBeats = beats.filter((_, i) => i % 2 === 0);
      } else if (isFastStyle && styleConfidence >= 0.7) {
        // 快歌风格高置信度：保守处理，不校正
        return {
          bpm_corrected: bpmRaw,
          beats_corrected: beats,
          octave_correction: 'none',
          octave_confidence: 0,
          bpm_original: bpmRaw,
          decision_reason: 'fast_style_high_confidence'
        };
      } else {
        // 风格不明确：半速校正（特征优先）
        correctedBpm = halfBpm;
        correction = 'half';
        confidence = Math.min(0.85, halftimeScore / 10);
        correctedBeats = beats.filter((_, i) => i % 2 === 0);
      }
    }
  }

  // === 倍速校正: 检测到 50-80，实际可能是 100-160 ===
  // 典型场景: 快歌只检测到了 downbeat
  if (bpmRaw >= 50 && bpmRaw <= 80 && correction === 'none') {
    const doubleBpm = bpmRaw * 2;
    let doubleScore = 0;

    // 1. 高 kick 密度 (>0.5) - 快歌 beat 密集
    if (kickDensity > 0.55) doubleScore += 2;
    else if (kickDensity > 0.45) doubleScore += 1;

    // 2. 高动态复杂度 (>4) - 快歌特征
    if (dynComplexity > 4.5) doubleScore += 2;
    else if (dynComplexity > 4.0) doubleScore += 1;

    // 3. 倍速后 BPM 在合理区间 (100-160)
    if (doubleBpm >= 100 && doubleBpm <= 160) doubleScore += 1;

    // 4. 动态范围小 (<5) - 电子/快歌特征
    if (dynamicRange < 4.5) doubleScore += 1;

    // 判断是否需要倍速校正
    if (doubleScore >= 4) {
      correctedBpm = doubleBpm;
      correction = 'double';
      confidence = Math.min(0.95, doubleScore / 8);
      // 调整 beats: 在每个 beat 中间插入
      const newBeats = [];
      for (let i = 0; i < beats.length - 1; i++) {
        newBeats.push(beats[i]);
        newBeats.push((beats[i] + beats[i + 1]) / 2);
      }
      newBeats.push(beats[beats.length - 1]);
      correctedBeats = newBeats;
    }
  }

  return {
    bpm_corrected: correctedBpm,
    beats_corrected: correctedBeats,
    octave_correction: correction,
    octave_confidence: confidence,
    bpm_original: bpmRaw
  };
}

// ========== Dynamic Complexity 曲线 ==========
function computeDynComplexityTimeline(samples, sr, durationS, loudnessTimeline) {
  const essentia = getEssentia();
  const frameSec = 2.0;  // 帧长 2 秒
  const hopSec = 0.5;    // 步长 0.5 秒
  const frameSize = Math.round(frameSec * sr);
  const hopSize = Math.round(hopSec * sr);
  const n = samples.length;

  const rawTimeline = [];
  const defaultDc = 3.0;

  for (let t = 0; t + frameSec <= durationS; t += hopSec) {
    const startSample = Math.round(t * sr);
    const endSample = Math.min(n, startSample + frameSize);
    const frameSamples = samples.slice(startSample, endSample);

    if (frameSamples.length < frameSize * 0.5) {
      rawTimeline.push({ t: +t.toFixed(2), dc: defaultDc });
      continue;
    }

    try {
      const frameVec = essentia.arrayToVector(frameSamples);
      const result = essentia.DynamicComplexity(frameVec, 0.2, sr);
      const dc = result.dynamicComplexity;
      frameVec.delete?.();
      rawTimeline.push({ t: +t.toFixed(2), dc: Math.max(0, Math.min(20, dc)) }); // 限制范围 0-20
    } catch (e) {
      rawTimeline.push({ t: +t.toFixed(2), dc: defaultDc });
    }
  }

  // 异常值检测和平滑处理
  // 计算中值作为参考
  const dcValues = rawTimeline.map(x => x.dc).sort((a, b) => a - b);
  const medianDc = dcValues[Math.floor(dcValues.length / 2)] || defaultDc;

  // 平滑处理: 3点滑动平均 + 异常值修正
  const smoothedTimeline = rawTimeline.map((p, i) => {
    // 检测异常值 (偏离中值超过 100%)
    if (Math.abs(p.dc - medianDc) > medianDc) {
      // 用邻近正常值替代
      const neighbors = [];
      for (let j = Math.max(0, i - 2); j <= Math.min(rawTimeline.length - 1, i + 2); j++) {
        if (j !== i && Math.abs(rawTimeline[j].dc - medianDc) <= medianDc) {
          neighbors.push(rawTimeline[j].dc);
        }
      }
      const replacement = neighbors.length ? neighbors.reduce((a, b) => a + b, 0) / neighbors.length : medianDc;
      return { t: p.t, dc: replacement };
    }
    return p;
  });

  // 二次平滑: 3点滑动平均
  const finalTimeline = smoothedTimeline.map((p, i) => {
    if (i === 0 || i === smoothedTimeline.length - 1) return p;
    const avg = (smoothedTimeline[i - 1].dc + p.dc + smoothedTimeline[i + 1].dc) / 3;
    return { t: p.t, dc: avg };
  });

  // 添加 density_band
  return finalTimeline.map(p => ({
    t: p.t,
    dc: +p.dc.toFixed(3),
    density_band: dcToBand(p.dc)
  }));
}

function dcToBand(dc) {
  if (dc < 2) return 'long_take';
  if (dc < 4) return 'normal';
  return 'fast_cut';
}

// ========== 和弦走向 (24 模板匹配, 整曲) ==========
// 分帧 HPCP → 按 beat 聚合 → 对 24 和弦模板 (12 major + 12 minor) 做余弦相似度 → 选最佳
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// 模板: C major = [C E G], C minor = [C Eb G]. 旋转生成其它 key.
const MAJOR_BASE = [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0];
const MINOR_BASE = [1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0];

function buildChordTemplates() {
  const templates = [];
  for (let root = 0; root < 12; root++) {
    const maj = new Float32Array(12), min = new Float32Array(12);
    for (let i = 0; i < 12; i++) { maj[i] = MAJOR_BASE[(i - root + 12) % 12]; min[i] = MINOR_BASE[(i - root + 12) % 12]; }
    templates.push({ name: NOTE_NAMES[root], quality: 'maj', vec: maj });
    templates.push({ name: NOTE_NAMES[root] + 'm', quality: 'min', vec: min });
  }
  return templates;
}
const CHORD_TEMPLATES = buildChordTemplates();

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

function detectChordTimeline(samples, sr, beats) {
  if (!beats || beats.length < 2) return { timeline: [], changes: [] };
  const essentia = getEssentia();
  const frameSize = 4096, hopSize = 2048;
  const fps = sr / hopSize;
  let framesVec;
  try { framesVec = essentia.FrameGenerator(samples, frameSize, hopSize); }
  catch (e) { return { timeline: [], changes: [], error: String(e.message || e) }; }
  const nFrames = framesVec.size();
  if (nFrames < 4) { framesVec.delete?.(); return { timeline: [], changes: [] }; }

  const hpcps = new Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    try {
      const frame = framesVec.get(i);
      const w = essentia.Windowing(frame, true, frameSize, 'hann');
      const spec = essentia.Spectrum(w.frame);
      const peaks = essentia.SpectralPeaks(spec.spectrum);
      const h = essentia.HPCP(peaks.frequencies, peaks.magnitudes);
      const arr = new Float32Array(12);
      const v = h.hpcp; const sz = v.size();
      for (let k = 0; k < Math.min(12, sz); k++) arr[k] = v.get(k);
      hpcps[i] = arr;
    } catch (e) { hpcps[i] = new Float32Array(12); }
  }
  framesVec.delete?.();

  // 每 beat 取 [beat_t - 0.05, next_beat_t - 0.05] 的平均 HPCP (beat-sync)
  const timeline = [];
  for (let b = 0; b < beats.length; b++) {
    const tStart = beats[b] - 0.05;
    const tEnd = (b + 1 < beats.length ? beats[b + 1] : beats[b] + 0.5) - 0.05;
    const fs = Math.max(0, Math.floor(tStart * fps));
    const fe = Math.min(nFrames, Math.ceil(tEnd * fps));
    const avg = new Float32Array(12);
    let cnt = 0;
    for (let f = fs; f < fe; f++) {
      if (!hpcps[f]) continue;
      for (let k = 0; k < 12; k++) avg[k] += hpcps[f][k];
      cnt++;
    }
    if (cnt) for (let k = 0; k < 12; k++) avg[k] /= cnt;
    // 匹配 24 模板
    let bestSim = -1, bestChord = null;
    for (const t of CHORD_TEMPLATES) {
      const sim = cosine(avg, t.vec);
      if (sim > bestSim) { bestSim = sim; bestChord = t; }
    }
    timeline.push({ t: +beats[b].toFixed(3), chord: bestChord ? bestChord.name : '?', conf: +bestSim.toFixed(3) });
  }

  // 平滑 1: 3-tap 众数(与前后相同的拍不变; 孤点替换为邻居)
  for (let i = 1; i < timeline.length - 1; i++) {
    if (timeline[i].chord !== timeline[i - 1].chord && timeline[i].chord !== timeline[i + 1].chord && timeline[i - 1].chord === timeline[i + 1].chord) {
      timeline[i].chord = timeline[i - 1].chord;
      timeline[i].smoothed = true;
    }
  }
  // 平滑 2: 要求和弦至少稳定 2 beat 才算一个"段" (dur < 2 beat 的小段并入前段)
  const runs = [];
  for (let i = 0; i < timeline.length; i++) {
    if (!runs.length || runs[runs.length - 1].chord !== timeline[i].chord) {
      runs.push({ chord: timeline[i].chord, start: i, end: i });
    } else runs[runs.length - 1].end = i;
  }
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i], len = r.end - r.start + 1;
    if (len < 2 && i > 0 && i < runs.length - 1) {
      // 并入前段
      for (let k = r.start; k <= r.end; k++) { timeline[k].chord = runs[i - 1].chord; timeline[k].smoothed = true; }
      runs[i - 1].end = r.end;
      runs[i].chord = runs[i - 1].chord;
    }
  }
  // 整曲切换点: 相邻 run 不同 (切换时间 = 新 run 的首拍)
  const changes = [];
  let prev = null;
  for (const r of runs) {
    if (prev && r.chord !== prev.chord && r.chord !== '?' && prev.chord !== '?') {
      changes.push({ t: timeline[r.start].t, from: prev.chord, to: r.chord });
    }
    prev = r;
  }
  return { timeline, changes };
}

// ========== 人声时间轴 (PredominantPitchMelodia) ==========
// 输出连续有人声的时段
function detectVocalTimeline(samples, sr) {
  const essentia = getEssentia();
  const vec = essentia.arrayToVector(samples);
  let pitch, conf;
  try {
    const r = essentia.PredominantPitchMelodia(vec);
    pitch = r.pitch; conf = r.pitchConfidence;
  } catch (e) { vec.delete?.(); return { segments: [], error: String(e.message || e) }; }
  vec.delete?.();
  const n = pitch.size();
  // Essentia 默认 hopSize = 128 samples, 但 PredominantPitchMelodia 默认 hopSize 128
  // 文档: hopSize 默认 128, 所以 dt = 128 / sr
  const dt = 128 / sr;
  const pArr = new Float32Array(n), cArr = new Float32Array(n);
  for (let i = 0; i < n; i++) { pArr[i] = pitch.get(i); cArr[i] = conf.get(i); }
  pitch.delete?.(); conf.delete?.();
  // 有人声/主旋律判据: pitch > 80 Hz (Essentia 内部已做 voicing 决策, pitch=0 表示无主导旋律).
  // 说明: 无分轨时该算法抓的是"主导旋律线", 纯器乐 solo 段也会被标为有旋律.
  // Essentia 的 pitchConfidence 范围 0~0.3, 不做硬阈值, 仅用 pitch 本身做判据
  const hasVocal = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    hasVocal[i] = (pArr[i] > 80 && pArr[i] < 1200) ? 1 : 0;
  }
  // 形态学闭运算: 0 最多 0.3s 填 1; 小于 0.5s 的连续 1 丢弃
  const closeGap = Math.round(0.3 / dt);
  const minSeg = Math.round(0.5 / dt);
  // 先闭
  {
    let i = 0;
    while (i < n) {
      if (hasVocal[i] === 0) {
        let j = i;
        while (j < n && hasVocal[j] === 0) j++;
        if (j - i <= closeGap && i > 0 && j < n) for (let k = i; k < j; k++) hasVocal[k] = 1;
        i = j;
      } else i++;
    }
  }
  // 再开
  const segments = [];
  let i = 0;
  while (i < n) {
    if (hasVocal[i] === 1) {
      let j = i;
      while (j < n && hasVocal[j] === 1) j++;
      if (j - i >= minSeg) {
        segments.push({ start: +(i * dt).toFixed(2), end: +(j * dt).toFixed(2) });
      }
      i = j;
    } else i++;
  }
  // 合并间隔 < 1.2s 的相邻段 (呼吸停顿/换气)
  const merged = [];
  for (const seg of segments) {
    if (merged.length && seg.start - merged[merged.length - 1].end < 1.2) {
      merged[merged.length - 1].end = seg.end;
    } else merged.push({ ...seg });
  }
  return { segments: merged, dt_raw: dt };
}

// ========== BPM 风格分类 + 感知层 ==========
// 规则来自音乐人:
//   情歌 / 流行抒情   Raw 110-160 → perceived = raw/2
//   EDM / House      Raw 115-132 + kick 密度高 → perceived = raw
//   Trap / 下沉 DJ   Raw 130-150 + kick 稀疏 → perceived = raw/2 (engine 保留)
//   其他             perceived = raw
function classifyGenreAndBpm(rawBpm, kickStrengths) {
  if (!kickStrengths || !kickStrengths.length) return { genre: 'unknown', perceived: rawBpm, engine: rawBpm };
  const sorted = [...kickStrengths].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const thr = med * 1.5 + 1e-6;
  const strongRatio = kickStrengths.filter(k => k > thr).length / kickStrengths.length;

  // EDM: 115-132, 每拍都重 kick
  if (rawBpm >= 115 && rawBpm <= 132 && strongRatio > 0.4) {
    return { genre: 'edm_house', perceived: +rawBpm.toFixed(2), engine: +rawBpm.toFixed(2), kick_strong_ratio: +strongRatio.toFixed(2) };
  }
  // Trap: 130-150, kick 稀疏
  if (rawBpm >= 130 && rawBpm <= 150 && strongRatio < 0.25) {
    return { genre: 'trap', perceived: +(rawBpm / 2).toFixed(2), engine: +rawBpm.toFixed(2), kick_strong_ratio: +strongRatio.toFixed(2) };
  }
  // 情歌 / 流行抒情: 100-160 (BPM 108 这种 mid-tempo 流行需要纳入)
  if (rawBpm >= 100 && rawBpm <= 160) {
    return { genre: 'pop_ballad', perceived: +(rawBpm / 2).toFixed(2), engine: +rawBpm.toFixed(2), kick_strong_ratio: +strongRatio.toFixed(2) };
  }
  // 慢板 / 抒情曲 (<100)
  if (rawBpm < 100) {
    return { genre: 'slow_ballad', perceived: +rawBpm.toFixed(2), engine: +rawBpm.toFixed(2), kick_strong_ratio: +strongRatio.toFixed(2) };
  }
  // 快板 (>160): hardstyle / D&B / 民族快舞等, 保持原速
  return { genre: 'uptempo', perceived: +rawBpm.toFixed(2), engine: +rawBpm.toFixed(2), kick_strong_ratio: +strongRatio.toFixed(2) };
}

// ========== 动态 BPM (多轮校正 + 样条插值) ==========
// 算法:
//   Round 1: 全局粗扫 - 16拍窗口, 得到初始 BPM 序列和全局中值
//   Round 2: 异常值剔除 - 偏离全局中值 > 15% 的点标记异常, 用邻近正常点替代
//   Round 3: phrase 锚定精扫 - 每个 phrase 内独立计算, 边界做过渡平滑
//   Round 4: 输出生成 - 0.5s 采样 + 三次样条插值生成平滑曲线
function computeDynamicBpm(beats, phrases, durationS) {
  if (!beats || beats.length < 4) return { bpm_timeline: [], bpm_segments: [] };

  // --- helpers ---
  const median = arr => {
    const filtered = arr.filter(v => isFinite(v) && v > 0);
    if (!filtered.length) return null;
    const s = [...filtered].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const mean = arr => {
    const filtered = arr.filter(v => isFinite(v));
    return filtered.length ? filtered.reduce((a, b) => a + b, 0) / filtered.length : null;
  };
  const bpmFromIBIs = ibis => {
    if (!ibis || !ibis.length) return null;
    const med = median(ibis);
    return med > 0 ? 60 / med : null;
  };

  // ==================== Round 1: 全局粗扫 ====================
  const COARSE_WIN = 16, COARSE_HOP = 4;
  const coarseSamples = []; // { beatStart, beatEnd, bpm, t }

  for (let start = 0; start + COARSE_WIN <= beats.length; start += COARSE_HOP) {
    const end = start + COARSE_WIN;
    const ibis = [];
    for (let i = start + 1; i < end; i++) ibis.push(beats[i] - beats[i - 1]);
    const bpm = bpmFromIBIs(ibis);
    if (bpm !== null && bpm > 30 && bpm < 300) {
      coarseSamples.push({
        beatStart: start,
        beatEnd: end,
        bpm,
        t: beats[Math.floor((start + end) / 2)]
      });
    }
  }
  // 处理尾部
  const lastCoarse = coarseSamples.length ? coarseSamples[coarseSamples.length - 1].beatStart + COARSE_HOP : 0;
  if (beats.length - lastCoarse >= 4) {
    const ibis = [];
    for (let i = lastCoarse + 1; i < beats.length; i++) ibis.push(beats[i] - beats[i - 1]);
    const bpm = bpmFromIBIs(ibis);
    if (bpm !== null && bpm > 30 && bpm < 300) {
      coarseSamples.push({
        beatStart: lastCoarse,
        beatEnd: beats.length,
        bpm,
        t: beats[Math.floor((lastCoarse + beats.length) / 2)]
      });
    }
  }

  if (!coarseSamples.length) return { bpm_timeline: [], bpm_segments: [] };

  // 计算全局中值 BPM
  const globalMedian = median(coarseSamples.map(s => s.bpm));
  if (!globalMedian) return { bpm_timeline: [], bpm_segments: [] };

  // ==================== Round 2: 异常值剔除 ====================
  const OUTLIER_THRESH = 0.15; // 15%
  const cleanedSamples = coarseSamples.map((s, i) => {
    const deviation = Math.abs(s.bpm - globalMedian) / globalMedian;
    if (deviation > OUTLIER_THRESH) {
      // 异常点: 用邻近正常点的中值替代
      const neighbors = [];
      for (let j = Math.max(0, i - 2); j <= Math.min(coarseSamples.length - 1, i + 2); j++) {
        if (j !== i) {
          const d = Math.abs(coarseSamples[j].bpm - globalMedian) / globalMedian;
          if (d <= OUTLIER_THRESH) neighbors.push(coarseSamples[j].bpm);
        }
      }
      const replacement = neighbors.length ? median(neighbors) : globalMedian;
      return { ...s, bpm: replacement, corrected: true };
    }
    return s;
  });

  // ==================== Round 3: phrase 锚定精扫 ====================
  // 每个 phrase 内独立计算 BPM 中值
  const phraseBpms = [];
  for (const p of phrases) {
    // 找到该 phrase 内的 beat 索引
    const phraseBeats = [];
    for (let i = 0; i < beats.length; i++) {
      if (beats[i] >= p.start - 0.05 && beats[i] <= p.end + 0.05) {
        phraseBeats.push(i);
      }
    }
    if (phraseBeats.length >= 2) {
      const ibis = [];
      for (let k = 1; k < phraseBeats.length; k++) {
        ibis.push(beats[phraseBeats[k]] - beats[phraseBeats[k - 1]]);
      }
      const bpm = bpmFromIBIs(ibis);
      // 异常值校正
      const deviation = bpm ? Math.abs(bpm - globalMedian) / globalMedian : 1;
      const finalBpm = (bpm && deviation <= OUTLIER_THRESH) ? bpm : globalMedian;
      phraseBpms.push({ ...p, bpm: finalBpm });
    } else {
      // phrase 内拍数不足, 用全局中值
      phraseBpms.push({ ...p, bpm: globalMedian });
    }
  }

  // 检测 phrase 间的 BPM 变化, 标记 transition 区域
  const PHRASE_CHANGE_THRESH = 0.05; // 5%
  const transitions = []; // { t, fromBpm, toBpm, type }
  for (let i = 0; i < phraseBpms.length - 1; i++) {
    const curr = phraseBpms[i];
    const next = phraseBpms[i + 1];
    const change = Math.abs(next.bpm - curr.bpm) / curr.bpm;
    if (change > PHRASE_CHANGE_THRESH) {
      transitions.push({
        t: curr.end,
        fromBpm: curr.bpm,
        toBpm: next.bpm,
        type: next.bpm > curr.bpm ? 'accelerando' : 'ritardando'
      });
    }
  }

  // 构建 keypoint 序列 (用于样条插值)
  const keyPoints = []; // { t, bpm }

  // 起点
  keyPoints.push({ t: 0, bpm: cleanedSamples[0].bpm });

  // phrase 边界作为关键点
  for (const p of phraseBpms) {
    // phrase 起点
    if (p.start > 0.1) {
      keyPoints.push({ t: p.start, bpm: p.bpm });
    }
    // phrase 中点 (如果 phrase 足够长)
    if (p.end - p.start > 4) {
      const midT = (p.start + p.end) / 2;
      keyPoints.push({ t: midT, bpm: p.bpm });
    }
  }

  // transition 区域的精细采样
  for (const tr of transitions) {
    // 在 transition 点前后各加一个中间点, 做平滑过渡
    const preT = Math.max(0, tr.t - 1.0);
    const postT = Math.min(durationS, tr.t + 1.0);
    const midBpm = (tr.fromBpm + tr.toBpm) / 2;
    keyPoints.push({ t: preT, bpm: tr.fromBpm });
    keyPoints.push({ t: tr.t, bpm: midBpm });
    keyPoints.push({ t: postT, bpm: tr.toBpm });
  }

  // 粗扫采样点 (去重后加入)
  for (const s of cleanedSamples) {
    const exists = keyPoints.some(k => Math.abs(k.t - s.t) < 0.3);
    if (!exists) {
      keyPoints.push({ t: s.t, bpm: s.bpm });
    }
  }

  // 终点
  keyPoints.push({ t: durationS, bpm: cleanedSamples[cleanedSamples.length - 1].bpm });

  // 按时间排序并去重
  keyPoints.sort((a, b) => a.t - b.t);
  const dedupedPoints = [];
  for (const p of keyPoints) {
    if (!dedupedPoints.length || Math.abs(p.t - dedupedPoints[dedupedPoints.length - 1].t) > 0.05) {
      dedupedPoints.push(p);
    }
  }

  // ==================== Round 4: 输出生成 ====================
  // 三次样条插值 (简化版: 线性插值 + 平滑)
  const SPLINE_SMOOTH = 0.3; // 平滑窗口 (秒)

  // 生成 0.5s 采样点
  const sampleInterval = 0.5;
  const nSamples = Math.ceil(durationS / sampleInterval) + 1;
  const bpmTimeline = [];

  for (let i = 0; i < nSamples; i++) {
    const t = i * sampleInterval;
    if (t > durationS) break;

    // 找到 t 所在区间
    let bpm = globalMedian;
    let found = false;

    for (let j = 0; j < dedupedPoints.length - 1; j++) {
      const p0 = dedupedPoints[j];
      const p1 = dedupedPoints[j + 1];
      if (t >= p0.t - 0.001 && t <= p1.t + 0.001) {
        // 线性插值
        const ratio = (t - p0.t) / (p1.t - p0.t || 1);
        bpm = p0.bpm + ratio * (p1.bpm - p0.bpm);
        found = true;
        break;
      }
    }

    // 如果没找到, 用最近的关键点
    if (!found && dedupedPoints.length) {
      let minDist = Infinity;
      for (const p of dedupedPoints) {
        const dist = Math.abs(p.t - t);
        if (dist < minDist) {
          minDist = dist;
          bpm = p.bpm;
        }
      }
    }

    // 平滑处理: 与前后点做加权平均
    bpmTimeline.push({ t: +t.toFixed(2), bpm: +bpm.toFixed(2) });
  }

  // 后处理平滑 (滑动平均)
  const smoothWindow = Math.max(1, Math.round(SPLINE_SMOOTH / sampleInterval));
  const smoothedTimeline = bpmTimeline.map((p, i) => {
    const start = Math.max(0, i - smoothWindow);
    const end = Math.min(bpmTimeline.length, i + smoothWindow + 1);
    const window = bpmTimeline.slice(start, end);
    const avgBpm = mean(window.map(w => w.bpm));
    return { t: p.t, bpm: +(avgBpm || p.bpm).toFixed(2) };
  });

  // ==================== bpm_segments 段落级汇总 ====================
  const bpmSegments = phrases.map(p => {
    const inPhrase = smoothedTimeline.filter(x => x.t >= p.start - 0.01 && x.t <= p.end + 0.01);
    if (!inPhrase.length) return { ...p, bpm: null, trend: 'unknown' };

    const bpms = inPhrase.map(x => x.bpm);
    const med = median(bpms);

    // 检测段内趋势
    const firstHalf = bpms.slice(0, Math.ceil(bpms.length / 2));
    const secondHalf = bpms.slice(Math.ceil(bpms.length / 2));
    const fhMed = median(firstHalf), shMed = median(secondHalf);
    const halfDiff = Math.abs(shMed - fhMed) / (fhMed + 1e-9);

    let trend = 'stable';
    if (halfDiff > 0.03) trend = fhMed < shMed ? 'accelerando' : 'ritardando';

    return {
      ...p,
      bpm: med ? +med.toFixed(2) : null,
      trend,
    };
  });

  return { bpm_timeline: smoothedTimeline, bpm_segments: bpmSegments };
}

// ========== 启发式 phrase fallback (无 SongFormer 时) ==========
function detectPhrasesHeuristic(samples, sr) {
  const essentia = getEssentia();
  const frameSize = 2048, hopSize = 1024;
  const fps = sr / hopSize;
  const framesVec = essentia.FrameGenerator(samples, frameSize, hopSize);
  const nFrames = framesVec.size();
  if (nFrames < 20) { framesVec.delete?.(); return []; }
  const rms = new Float32Array(nFrames);
  const mfccs = new Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    const frame = framesVec.get(i);
    rms[i] = essentia.RMS(frame).rms;
    const w = essentia.Windowing(frame, true, frameSize, 'hann');
    const spec = essentia.Spectrum(w.frame);
    const m = essentia.MFCC(spec.spectrum);
    const mv = m.mfcc, dim = mv.size();
    const arr = new Float32Array(dim - 1);
    for (let k = 1; k < dim; k++) arr[k - 1] = mv.get(k);
    mfccs[i] = arr;
  }
  framesVec.delete?.();
  const bigHopSec = 0.5, bigHop = Math.round(bigHopSec * fps);
  const nBig = Math.floor(nFrames / bigHop);
  if (nBig < 4) return [];
  const D = mfccs[0].length;
  const bigMfcc = new Array(nBig);
  const bigRms = new Float32Array(nBig);
  for (let b = 0; b < nBig; b++) {
    const s = b * bigHop, e = Math.min(s + bigHop, nFrames);
    const mVec = new Float32Array(D); let rSum = 0;
    for (let i = s; i < e; i++) { for (let k = 0; k < D; k++) mVec[k] += mfccs[i][k]; rSum += rms[i]; }
    for (let k = 0; k < D; k++) mVec[k] /= (e - s);
    bigMfcc[b] = mVec; bigRms[b] = rSum / (e - s);
  }
  const mean = new Float32Array(D), std = new Float32Array(D);
  for (const v of bigMfcc) for (let k = 0; k < D; k++) mean[k] += v[k];
  for (let k = 0; k < D; k++) mean[k] /= nBig;
  for (const v of bigMfcc) for (let k = 0; k < D; k++) std[k] += (v[k] - mean[k]) ** 2;
  for (let k = 0; k < D; k++) std[k] = Math.sqrt(std[k] / nBig) + 1e-9;
  for (const v of bigMfcc) for (let k = 0; k < D; k++) v[k] = (v[k] - mean[k]) / std[k];
  const W = 4;
  const avgV = list => { const d = list[0].length, o = new Float32Array(d); for (const v of list) for (let k = 0; k < d; k++) o[k] += v[k]; for (let k = 0; k < d; k++) o[k] /= list.length; return o; };
  const novelty = new Float32Array(nBig);
  for (let i = W; i < nBig - W; i++) {
    const pre = avgV(bigMfcc.slice(i - W, i));
    const post = avgV(bigMfcc.slice(i, i + W));
    let preR = 0, postR = 0;
    for (let k = 0; k < W; k++) { preR += bigRms[i - W + k]; postR += bigRms[i + k]; }
    preR /= W; postR /= W;
    const rd = Math.abs(postR - preR) / (preR + postR + 1e-9);
    novelty[i] = (1 - cosine(pre, post)) + 0.5 * rd;
  }
  let mu = 0, sg = 0, cnt = nBig - 2 * W;
  for (let i = W; i < nBig - W; i++) mu += novelty[i]; mu /= cnt;
  for (let i = W; i < nBig - W; i++) sg += (novelty[i] - mu) ** 2; sg = Math.sqrt(sg / cnt);
  const th = mu + 0.8 * sg;
  const minGap = Math.round(8 / bigHopSec);
  const peaks = [];
  for (let i = 2; i < nBig - 2; i++) {
    if (novelty[i] > th && novelty[i] > novelty[i - 1] && novelty[i] >= novelty[i + 1] && novelty[i] > novelty[i - 2] && novelty[i] >= novelty[i + 2]) {
      if (!peaks.length || i - peaks[peaks.length - 1] >= minGap) peaks.push(i);
    }
  }
  const duration = samples.length / sr;
  const boundaries = [0, ...peaks.map(i => i * bigHopSec), +duration.toFixed(3)];
  const phrases = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const s = boundaries[i], e = boundaries[i + 1];
    if (e - s < 1) continue;
    phrases.push({ start: +s.toFixed(3), end: +e.toFixed(3), label: `Section ${String.fromCharCode(65 + phrases.length)}` });
  }
  return phrases;
}

// 把 SongFormer segments 转标准 phrase schema
// 注意：不再合并相邻同label段落，保留SongFormer识别的完整段落边界
function mapSongformerSegments(segments) {
  if (!segments || !segments.length) return [];
  return segments.map(s => ({
    start: +parseFloat(s.start).toFixed(3),
    end: +parseFloat(s.end).toFixed(3),
    label: s.label
  }));
}

// ========== phrase 能量带 + 人声占比 (辅助 Layer 1 场景类型判断) ==========
function enrichPhrases(phrases, loudnessTimeline, vocalSegments, loudnessIntegrated) {
  if (!phrases.length) return phrases;
  return phrases.map(p => {
    // 平均 LUFS (shortterm)
    const inRange = loudnessTimeline.filter(x => x.t >= p.start && x.t < p.end);
    const avgLufs = inRange.length ? inRange.reduce((s, x) => s + x.lufs_st, 0) / inRange.length : null;
    // 人声占比
    let vocalDur = 0;
    for (const v of vocalSegments) {
      const ov = Math.max(0, Math.min(v.end, p.end) - Math.max(v.start, p.start));
      vocalDur += ov;
    }
    const vocalRatio = (p.end - p.start) > 0 ? vocalDur / (p.end - p.start) : 0;
    return {
      ...p,
      avg_lufs: avgLufs !== null ? +avgLufs.toFixed(2) : null,
      vocal_ratio: +vocalRatio.toFixed(2),
    };
  });
}

// phrase 能量档位: 用整首 avg_lufs 分位数决定 high/mid/low (相对基准是 integrated)
// 组合策略: silence标签优先 → chorus标签直接判high → 绝对阈值兜底 → 相对分位数
function bandPhrases(phrases) {
  if (!phrases.length) return phrases;

  // 绝对阈值
  const ABSOLUTE_LOW_THRESHOLD = -35;   // 极安静，一定是 low
  const ABSOLUTE_HIGH_THRESHOLD = -10;  // 极响，一定是 high

  return phrases.map(p => {
    // 优先级1: silence 标签直接判为 low
    if (p.label === 'silence') {
      return { ...p, energy_band: 'low' };
    }

    // 优先级2: chorus 标签直接判为 high
    if (p.label === 'chorus') {
      return { ...p, energy_band: 'high' };
    }

    // 优先级3: 绝对阈值兜底
    if (p.avg_lufs !== null) {
      // 极安静 → low
      if (p.avg_lufs < ABSOLUTE_LOW_THRESHOLD) {
        return { ...p, energy_band: 'low' };
      }
      // 极响 → high
      if (p.avg_lufs > ABSOLUTE_HIGH_THRESHOLD) {
        return { ...p, energy_band: 'high' };
      }
    }

    // 优先级4: 相对分位数判断
    const lufsArr = phrases.map(pp => pp.avg_lufs).filter(v => v !== null).sort((a, b) => a - b);
    if (!lufsArr.length) return { ...p, energy_band: 'mid' };

    const q33 = lufsArr[Math.floor(lufsArr.length * 0.33)];
    const q66 = lufsArr[Math.floor(lufsArr.length * 0.66)];

    let band = 'mid';
    if (p.avg_lufs !== null) {
      if (p.avg_lufs >= q66) band = 'high';
      else if (p.avg_lufs <= q33) band = 'low';
    }
    return { ...p, energy_band: band };
  });
}

// ========== SongFormer label 标准化 ==========
// 将SongFormer返回的label映射到标准的semantic_label格式
function normalizeSongformerLabel(label) {
  if (!label) return 'unknown';
  const l = label.toLowerCase().trim();

  // SongFormer常见标签映射
  const labelMap = {
    'intro': 'intro',
    'outro': 'outro',
    'verse': 'verse',
    'chorus': 'chorus',
    'pre-chorus': 'pre_chorus',
    'prechorus': 'pre_chorus',
    'bridge': 'bridge',
    'inst': 'inst',
    'instrumental': 'inst',
    'silence': 'silence',
    'fadeout': 'outro',
    'fade': 'outro',
    'hook': 'chorus',
    'refrain': 'chorus',
    'post-chorus': 'post_chorus',
    'postchorus': 'post_chorus',
    'pre-hook': 'pre_chorus',
    'prehook': 'pre_chorus',
  };

  // 直接匹配
  if (labelMap[l]) return labelMap[l];

  // 处理带数字的变体: verse1, chorus2, etc.
  const match = l.match(/^(intro|verse|chorus|bridge|outro|pre-chorus|prechorus|post-chorus|postchorus)(\d*)$/);
  if (match) {
    const base = labelMap[match[1]] || match[1];
    const num = match[2] || '';
    return base + num;
  }

  // 未知标签原样返回
  return l.replace(/-/g, '_');
}

// ========== 段落语义推断 (intro/verse/pre_chorus/chorus/bridge/outro) ==========
// 基于能量、人声、位置推断段落语义标签，供 AI 导演决定切镜密度
// 当 source='songformer' 时，直接使用原始label作为semantic_label
function inferPhraseSemantics(phrases, duration, source = 'heuristic') {
  if (!phrases || phrases.length === 0) return phrases;

  // 如果是SongFormer来源，直接使用原始label作为semantic_label
  // 同时根据能量带设置cut_density
  if (source === 'songformer') {
    return phrases.map(p => ({
      ...p,
      semantic_label: normalizeSongformerLabel(p.label),
      cut_density: p.energy_band === 'high' ? 'high' : p.energy_band === 'low' ? 'low' : 'medium'
    }));
  }

  // 以下是启发式推断逻辑（用于fallback情况）
  const n = phrases.length;

  // 计算能量变化（用于检测 pre-chorus）
  phrases.forEach((p, i) => {
    const next = phrases[i + 1];
    p._energyDelta = next ? (next.avg_lufs - p.avg_lufs) : 0;
  });

  // 全局能量统计
  const allLufs = phrases.map(p => p.avg_lufs || -50);
  const maxLufs = Math.max(...allLufs);
  const chorusThreshold = maxLufs - 4; // 最高能量 -4dB 作为副歌阈值

  // 计数器
  let verseCount = 0;
  let chorusCount = 0;
  let preCount = 0;
  let bridgeCount = 0;
  let lastChorusIdx = -10; // 上一个 chorus 的索引

  const result = phrases.map((p, i) => {
    const isFirst = i === 0;
    const isLast = i === phrases.length - 1;
    const distFromLastChorus = i - lastChorusIdx;

    // 判断条件
    const isHighEnergy = p.avg_lufs >= chorusThreshold;
    const isNewChorusSection = distFromLastChorus > 3 || lastChorusIdx < 0;

    // 规则1: Intro - 开头 + 低能量 + 无人声
    if (isFirst && p.energy_band === 'low' && p.vocal_ratio < 0.3) {
      return {
        ...p,
        semantic_label: 'intro',
        cut_density: 'low'
      };
    }

    // 规则2: Outro - 结尾 + 低能量
    if (isLast && p.energy_band === 'low') {
      return {
        ...p,
        semantic_label: 'outro',
        cut_density: 'low'
      };
    }

    // 规则3: Chorus - 高能量 + 有人声 + 新的 chorus 组
    if (isHighEnergy && p.vocal_ratio > 0.5 && isNewChorusSection) {
      chorusCount++;
      lastChorusIdx = i;
      return {
        ...p,
        semantic_label: 'chorus' + (chorusCount > 1 ? chorusCount : ''),
        cut_density: 'high'
      };
    }

    // 规则4: Chorus 延续 - 紧跟着上一个 chorus 的高能量段
    if (isHighEnergy && distFromLastChorus <= 2) {
      return {
        ...p,
        semantic_label: 'chorus' + chorusCount + '_ext',
        cut_density: 'high'
      };
    }

    // 规则5: Pre-chorus - 在 chorus 之前，能量上升
    const nextPhrase = phrases[i + 1];
    if (nextPhrase && nextPhrase.avg_lufs >= chorusThreshold && p._energyDelta > 0) {
      preCount++;
      return {
        ...p,
        semantic_label: 'pre_chorus' + (preCount > 1 ? preCount : ''),
        cut_density: 'medium'
      };
    }

    // 规则6: Verse - 中等能量 + 有人声
    if (p.vocal_ratio > 0.3) {
      verseCount++;
      return {
        ...p,
        semantic_label: 'verse' + (verseCount > 1 ? verseCount : ''),
        cut_density: 'medium'
      };
    }

    // 规则7: Bridge - 无人声过渡
    bridgeCount++;
    return {
      ...p,
      semantic_label: 'bridge',
      cut_density: 'medium'
    };
  });

  // 清理临时字段
  return result.map(p => {
    const clean = { ...p };
    delete clean._energyDelta;
    return clean;
  });
}

// ========== 方案B：对齐段落边界到节拍切点 ==========
/**
 * 将每个 phrase 的 start/end 对齐到 suggested_cut_points 中的节拍时间点
 *
 * 对齐规则（选项B：优先 downbeats，其次 medium_beats）：
 * 1. 对于每个段落，在该段落原始范围内找切点
 * 2. 优先使用 strong_beat，其次 medium_beat
 * 3. 确保相邻段落首尾相连，无时间空隙
 *
 * @param {Array} phrases - 段落数组
 * @param {Array} cutPoints - suggested_cut_points 数组
 * @param {Array} beats - 所有节拍时间点（用于扩展边界）
 * @param {number} duration - 歌曲总时长
 * @returns {Array} 对齐后的 phrases
 */
function alignPhrasesToCutPoints(phrases, cutPoints, beats = [], duration = 0) {
  if (!phrases || !phrases.length) return phrases;
  if (!cutPoints || !cutPoints.length) return phrases;

  // 分离不同类型的切点
  const strongBeats = cutPoints.filter(cp => cp.type === 'strong_beat' || cp.type === 'segment_boundary').map(cp => cp.time).sort((a, b) => a - b);
  const mediumBeats = cutPoints.filter(cp => cp.type === 'medium_beat').map(cp => cp.time).sort((a, b) => a - b);
  const allCutTimes = cutPoints.map(cp => cp.time).sort((a, b) => a - b);

  // 在指定范围内找最近的切点，优先 strong_beat
  const findBestCutPointInRange = (rangeStart, rangeEnd) => {
    // 第一步：在范围内找 strong_beat
    const strongInRange = strongBeats.filter(t => t >= rangeStart - 0.1 && t <= rangeEnd + 0.1);
    if (strongInRange.length > 0) {
      // 返回范围内的第一个 strong_beat（最接近 rangeStart）
      return { time: strongInRange[0], type: 'strong_beat' };
    }

    // 第二步：在范围内找 medium_beat
    const mediumInRange = mediumBeats.filter(t => t >= rangeStart - 0.1 && t <= rangeEnd + 0.1);
    if (mediumInRange.length > 0) {
      return { time: mediumInRange[0], type: 'medium_beat' };
    }

    // 第三步：在范围内找任意切点
    const anyInRange = allCutTimes.filter(t => t >= rangeStart - 0.1 && t <= rangeEnd + 0.1);
    if (anyInRange.length > 0) {
      return { time: anyInRange[0], type: 'any' };
    }

    return null;
  };

  // 第一步：计算每个段落的对齐边界
  const alignedPhrases = [];

  for (let i = 0; i < phrases.length; i++) {
    const phrase = phrases[i];
    const prevPhrase = i > 0 ? phrases[i - 1] : null;
    const nextPhrase = i < phrases.length - 1 ? phrases[i + 1] : null;

    // 找该段落范围内的最佳切点作为 start
    const startResult = findBestCutPointInRange(phrase.start, phrase.end);

    let alignedStart;
    let startType;

    // 第一个段落：保持原始 start（通常是 0），不强制对齐到强拍
    if (i === 0) {
      alignedStart = phrase.start;
      startType = 'original_first';
    } else if (startResult) {
      alignedStart = startResult.time;
      startType = startResult.type;
    } else {
      // 没有切点，保持原边界
      alignedStart = phrase.start;
      startType = 'original';
    }

    // 确定 end
    let alignedEnd;
    let endType;

    if (nextPhrase) {
      // 不是最后一个段落：找下一个段落的 start
      const nextStartResult = findBestCutPointInRange(nextPhrase.start, nextPhrase.end);
      if (nextStartResult) {
        alignedEnd = nextStartResult.time;
        endType = 'linked';
      } else {
        // 下一个段落没有切点，用原始边界
        alignedEnd = nextPhrase.start;
        endType = 'original';
      }
    } else {
      // 最后一个段落：end 保持为歌曲总时长，不强制对齐到强拍
      alignedEnd = duration || phrase.end;
      endType = 'original_last';
    }

    // 确保段落有有效时长
    if (alignedEnd <= alignedStart) {
      // 尝试修复：用该段落内的最后一个切点作为 end
      const anyInRange = allCutTimes.filter(t => t > alignedStart && t <= phrase.end + 0.5);
      if (anyInRange.length > 0) {
        alignedEnd = anyInRange[anyInRange.length - 1];
        endType = 'adjusted';
      } else {
        alignedPhrases.push({
          ...phrase,
          _alignment: 'invalid_range'
        });
        continue;
      }
    }

    // 确保不与前一个段落重叠
    if (i > 0 && alignedPhrases.length > 0) {
      const prevAligned = alignedPhrases[alignedPhrases.length - 1];
      if (alignedStart < prevAligned.end) {
        // 与前一个段落重叠，调整 start = 前一个段落的 end
        alignedStart = prevAligned.end;
        startType = 'linked';
      }
    }

    // 再次检查有效性
    if (alignedEnd <= alignedStart) {
      alignedPhrases.push({
        ...phrase,
        _alignment: 'invalid_range'
      });
      continue;
    }

    // 计算该段落内的切点数量
    const cutPointsInRange = allCutTimes.filter(
      t => t >= alignedStart - 0.01 && t <= alignedEnd + 0.01
    );

    alignedPhrases.push({
      ...phrase,
      start: +alignedStart.toFixed(3),
      end: +alignedEnd.toFixed(3),
      original_start: phrase.start,
      original_end: phrase.end,
      _alignment: 'aligned',
      _start_type: startType,
      _end_type: endType,
      _cut_points_count: cutPointsInRange.length
    });
  }

  return alignedPhrases;
}

// ========== suggested_cut_points (四种 type, 整曲, 带 idx + reason + confidence) ==========
const PHRASE_SNAP = 1.0;

function buildCutPoints(beats, downbeats, mediums, chordChanges, phrases, downbeatConfidences = null, mediumConfidences = null) {
  const pts = [];
  if (!downbeats.length) return pts;

  const phraseAt = t => phrases.find(p => t >= p.start - 0.01 && t < p.end) || null;
  const enteringPhrase = t => {
    for (let i = 0; i < phrases.length; i++) {
      const p = phrases[i];
      if (i > 0 && Math.abs(t - p.start) <= PHRASE_SNAP) return p;
      if (Math.abs(t - p.end) <= PHRASE_SNAP && i < phrases.length - 1) return phrases[i + 1];
    }
    return null;
  };
  const isFirst = t => phrases.length && Math.abs(t - phrases[0].start) <= PHRASE_SNAP;
  const isFinal = t => phrases.length && Math.abs(t - phrases[phrases.length - 1].end) <= PHRASE_SNAP;
  const bandCN = b => b === 'high' ? '高能段' : b === 'low' ? '低能段' : '中能段';

  // 获取语义标签（优先使用 semantic_label）
  const getSemanticLabel = p => p?.semantic_label || p?.label || 'unknown';

  // 将置信度转换为推荐级别: high(>=0.7) / medium(>=0.4) / low(<0.4)
  const confLevel = c => c >= 0.7 ? 'high' : c >= 0.4 ? 'medium' : 'low';

  // Strong beats (downbeats)
  for (let i = 0; i < downbeats.length; i++) {
    const t = downbeats[i];
    const next = downbeats[i + 1];
    const p = phraseAt(t);
    const enter = enteringPhrase(t);
    const fst = isFirst(t), lst = isFinal(t);
    const fill = beats.filter(b => b > t + 1e-3 && (next === undefined || b < next - 1e-3)).map(b => +b.toFixed(3));
    const confidence = downbeatConfidences ? (downbeatConfidences[i] || 0) : null;

    let type = 'strong_beat';
    let reason;
    const enterLabel = getSemanticLabel(enter);
    const pLabel = getSemanticLabel(p);
    if (fst) { type = 'segment_boundary'; reason = `音乐起始, 建议主剪辑点`; }
    else if (lst) { type = 'segment_boundary'; reason = `${pLabel} 尾, 建议收束`; }
    else if (enter) { type = 'segment_boundary'; reason = `进入 ${enterLabel}(${bandCN(enter.energy_band)}), 建议画面整体换`; }
    else if (pLabel.startsWith('chorus')) reason = `${pLabel} 内强拍, 主切镜+动作落点`;
    else if (pLabel.startsWith('verse')) reason = `${pLabel} 内强拍, 推进叙事`;
    else if (pLabel === 'intro') reason = `intro 强拍, 铺垫入场`;
    else if (pLabel === 'outro') reason = `outro 强拍, 收束结尾`;
    else if (pLabel === 'bridge') reason = `bridge 强拍, 情绪转折`;
    else if (pLabel.startsWith('pre_chorus')) reason = `${pLabel} 强拍, 能量积蓄`;
    else reason = `${pLabel} 内强拍, 主切镜`;

    const energy = (type === 'segment_boundary' && enter) ? enter.energy_band : (p?.energy_band || 'mid');
    const pt = {
      time: +t.toFixed(3),
      type,
      accent_type: 'downbeat',  // 新增：重拍类型标记（强拍位重拍）
      energy: energy === 'high' ? 'High' : energy === 'low' ? 'Low' : 'Mid',
      fill_beats: fill,
      reason
    };
    if (confidence !== null) {
      pt.confidence = +confidence.toFixed(3);
      pt.confidence_level = confLevel(confidence);
    }
    pts.push(pt);
  }

  // Medium beats (整曲)
  for (let i = 0; i < mediums.length; i++) {
    const t = mediums[i];
    const p = phraseAt(t);
    const energy = p?.energy_band === 'high' ? 'High' : p?.energy_band === 'low' ? 'Low' : 'Mid';
    const pLabel = getSemanticLabel(p);
    const reason = pLabel.startsWith('chorus') ? `${pLabel} 次强拍, 细节快切` :
                   pLabel === 'intro' ? `intro 次强拍, 铺垫` :
                   pLabel === 'outro' ? `outro 次强拍, 收束` :
                   `${pLabel} 次强拍, 细节快切`;
    const confidence = mediumConfidences ? (mediumConfidences[i] || 0) : null;
    const pt = {
      time: +t.toFixed(3),
      type: 'medium_beat',
      accent_type: 'medium',  // 新增：重拍类型标记（次强拍位重拍）
      energy,
      fill_beats: [],
      reason
    };
    if (confidence !== null) {
      pt.confidence = +confidence.toFixed(3);
      pt.confidence_level = confLevel(confidence);
    }
    pts.push(pt);
  }

  // Chord changes (整曲)
  for (const c of chordChanges) {
    const p = phraseAt(c.t);
    const energy = p?.energy_band === 'high' ? 'High' : p?.energy_band === 'low' ? 'Low' : 'Mid';
    pts.push({ time: c.t, type: 'chord_change', energy, fill_beats: [], reason: `和弦切换 ${c.from}→${c.to}, 情绪转折` });
  }

  pts.sort((a, b) => a.time - b.time);
  // 去重: 若两点时间差 < 0.06s, 保留 type 优先级高的 (segment_boundary > strong_beat > chord_change > medium_beat)
  const order = { segment_boundary: 0, strong_beat: 1, chord_change: 2, medium_beat: 3 };
  const dedup = [];
  for (const p of pts) {
    const last = dedup[dedup.length - 1];
    if (last && Math.abs(p.time - last.time) < 0.06) {
      if (order[p.type] < order[last.type]) dedup[dedup.length - 1] = p;
    } else dedup.push(p);
  }
  // 加 idx (序号从 1 开始)
  return dedup.map((p, i) => ({ idx: i + 1, ...p }));
}

// ========== 建议切入点（基于重拍的新逻辑）==========
// 规则：
// - 第一段落：永远从第一个强拍（downbeat）开始，确保开场稳定有力
// - Low/Mid 能量段落：从第一个重拍开始，每隔一个重拍取一个（第1、3、5...个）
// - High 能量段落：所有重拍都取
// - 每个段落都从第一个重拍开始计算
function buildRecommendedCutPoints(downbeats, mediums, phrases) {
  const recommended = [];
  if (!phrases || phrases.length === 0) return recommended;
  if (!downbeats.length && !mediums.length) return recommended;

  // 合并所有重拍并按时间排序
  const allAccents = [
    ...downbeats.map(t => ({ time: t, accent_type: 'downbeat' })),
    ...mediums.map(t => ({ time: t, accent_type: 'medium' }))
  ].sort((a, b) => a.time - b.time);

  // 按段落分组重拍
  for (let phraseIdx = 0; phraseIdx < phrases.length; phraseIdx++) {
    const phrase = phrases[phraseIdx];
    const isFirstPhrase = phraseIdx === 0;

    // 找出该段落内的所有重拍
    const phraseAccents = allAccents.filter(a =>
      a.time >= phrase.start - 0.05 && a.time < phrase.end + 0.05
    ).sort((a, b) => a.time - b.time);

    if (phraseAccents.length === 0) continue;

    const energy = phrase.energy_band || 'mid';
    const pLabel = phrase.semantic_label || phrase.label || 'unknown';

    // ========== 第一段落特殊处理：从第一个强拍开始 ==========
    if (isFirstPhrase) {
      // 找第一个强拍（downbeat）
      const firstDownbeatIdx = phraseAccents.findIndex(a => a.accent_type === 'downbeat');

      if (firstDownbeatIdx !== -1) {
        // 从第一个强拍开始，重新构建重拍序列
        const shiftedAccents = phraseAccents.slice(firstDownbeatIdx);

        if (energy === 'high') {
          // High 能量：所有重拍都取
          for (let i = 0; i < shiftedAccents.length; i++) {
            const accent = shiftedAccents[i];
            recommended.push({
              time: +accent.time.toFixed(3),
              accent_type: accent.accent_type,
              energy: 'High',
              phrase_label: pLabel,
              reason: `${pLabel} 高能段落（首段锚定强拍），第${i + 1}个重拍`,
              is_first_phrase: true
            });
          }
        } else {
          // Low/Mid 能量：从第一个强拍开始，每隔一个取一个
          for (let i = 0; i < shiftedAccents.length; i += 2) {
            const accent = shiftedAccents[i];
            recommended.push({
              time: +accent.time.toFixed(3),
              accent_type: accent.accent_type,
              energy: energy === 'low' ? 'Low' : 'Mid',
              phrase_label: pLabel,
              reason: `${pLabel} ${energy === 'low' ? '低' : '中'}能段落（首段锚定强拍），第${Math.floor(i / 2) + 1}个建议切点`,
              is_first_phrase: true
            });
          }
        }
        continue;  // 跳过后面的常规处理
      }
      // 如果没有强拍，走常规逻辑
    }

    // ========== 其他段落：常规逻辑 ==========
    if (energy === 'high') {
      // High 能量：所有重拍都取
      for (let i = 0; i < phraseAccents.length; i++) {
        const accent = phraseAccents[i];
        recommended.push({
          time: +accent.time.toFixed(3),
          accent_type: accent.accent_type,
          energy: 'High',
          phrase_label: pLabel,
          reason: `${pLabel} 高能段落，第${i + 1}个重拍`
        });
      }
    } else {
      // Low/Mid 能量：从第一个重拍开始，每隔一个取一个
      for (let i = 0; i < phraseAccents.length; i += 2) {
        const accent = phraseAccents[i];
        recommended.push({
          time: +accent.time.toFixed(3),
          accent_type: accent.accent_type,
          energy: energy === 'low' ? 'Low' : 'Mid',
          phrase_label: pLabel,
          reason: `${pLabel} ${energy === 'low' ? '低' : '中'}能段落，第${Math.floor(i / 2) + 1}个建议切点`
        });
      }
    }
  }

  // 按时间排序并添加序号
  recommended.sort((a, b) => a.time - b.time);
  return recommended.map((p, i) => ({ idx: i + 1, ...p }));
}

// ========== 主流程 ==========
async function analyzeSamples(samples, sampleRate, opts = {}) {
  const essentia = getEssentia();
  const vec = essentia.arrayToVector(samples);
  const out = {
    duration_s: +(samples.length / sampleRate).toFixed(3),
    sample_rate: sampleRate,
    __debug: {},
  };
  const safe = (name, fn) => { try { fn(); } catch (e) { out.__debug[`${name}_err`] = String(e.message || e).slice(0, 300); } };

  // --- Beat/Downbeat 检测: madmom 优先，essentia fallback ---
  let madmomData = opts.madmomResult || null;

  if (madmomData && madmomData.beats && madmomData.beats.length > 0) {
    // 节拍偏移校正
    const beatOffset = opts.beatOffset || 0;

    // 使用 madmom 结果（应用偏移量）
    out.beats = madmomData.beats.map(t => +(t + beatOffset).toFixed(3));
    out.bpm_raw = madmomData.bpm || estimateBpmFromBeats(out.beats);
    out.__debug.beat_source = 'madmom';
    out.__debug.madmom_confidence = madmomData.confidence;
    if (beatOffset !== 0) out.__debug.beat_offset = beatOffset;

    // madmom 的 downbeat 和 medium_beats（应用偏移量）
    if (madmomData.downbeats && madmomData.downbeats.length > 0) {
      out._madmom_downbeats = madmomData.downbeats.map(t => +(t + beatOffset).toFixed(3));
      out._madmom_medium_beats = (madmomData.medium_beats || []).map(t => +(t + beatOffset).toFixed(3));
    }

    // 拍号信息
    if (madmomData.time_signature) {
      out.time_signature = madmomData.time_signature;
      out.__debug.meter_source = 'madmom';
    }

    // beat 位置 (用于后续分析)
    if (madmomData.beat_positions) {
      out._beat_positions = madmomData.beat_positions;
    }
  } else {
    // Fallback 到 essentia.js
    safe('rhythm2013', () => {
      const r = essentia.RhythmExtractor2013(vec);
      out.bpm_raw = +r.bpm.toFixed(2);
      out.__debug.bpm_confidence = +r.confidence.toFixed(3);
      const n = r.ticks.size();
      out.beats = Array.from({ length: n }, (_, i) => +r.ticks.get(i).toFixed(3));
      out.__debug.beat_source = 'essentia';
    });
  }

  // 从 beats 估算 BPM (如果 madmom 没有提供)
  function estimateBpmFromBeats(beats) {
    if (!beats || beats.length < 2) return 120;
    const intervals = [];
    for (let i = 1; i < beats.length; i++) {
      intervals.push(beats[i] - beats[i-1]);
    }
    const median = intervals.sort((a, b) => a - b)[Math.floor(intervals.length / 2)];
    return Math.round(60 / median * 100) / 100;
  }

  safe('key', () => {
    const r = essentia.KeyExtractor(vec);
    out.key = r.key; out.scale = r.scale; out.key_strength = +r.strength.toFixed(3);
  });
  safe('dyn_complexity', () => {
    const r = essentia.DynamicComplexity(vec, 0.2, sampleRate);
    out.dyn_complexity = +r.dynamicComplexity.toFixed(3);
  });

  vec.delete?.();

  // --- Layer 1: LUFS timeline ---
  let loud = { timeline: [], shortterm_raw: [], integrated: null, range: null, dt_raw: 0.1 };
  safe('loudness_ebur128', () => { loud = computeLoudnessTimeline(samples, sampleRate); });
  out.lufs_integrated = loud.integrated !== undefined ? +loud.integrated.toFixed(2) : null;
  out.lufs_range = loud.range !== undefined ? +loud.range.toFixed(2) : null;
  out.loudness_timeline = loud.timeline;

  // --- Layer 2: loudness peaks (瞬时爆点) ---
  let peaks = [];
  safe('loudness_peaks', () => { peaks = detectLoudnessPeaks(loud.shortterm_raw, loud.dt_raw); });
  out.loudness_peaks = peaks;

  // --- Top-N 高能时间段 (10s 窗 top-3) ---
  out.top_loudness_segments = findTopLoudSegments(loud.timeline, 10, 3);

  // --- Dynamic Complexity Timeline (新增) ---
  let dcTimeline = [];
  safe('dc_timeline', () => {
    dcTimeline = computeDynComplexityTimeline(samples, sampleRate, out.duration_s, loud.timeline);
    out.dyn_complexity_timeline = dcTimeline;
  });

  // --- Layer 3: editing_density_band (基于全局 dc) ---
  const dc = out.dyn_complexity || 0;
  out.editing_density_band = dc < 2 ? 'long_take' : dc < 4 ? 'normal' : 'fast_cut_glitch';

  // --- 和弦走向 (提前计算, 用于特征分析) ---
  let chordRes = { timeline: [], changes: [] };
  safe('chord', () => { chordRes = detectChordTimeline(samples, sampleRate, out.beats || []); });

  // --- kick 强度 (用于节奏特征分析) ---
  let kickStrengths = [];
  safe('kick_strengths', () => { kickStrengths = computeBeatKickStrengths(samples, sampleRate, out.beats || []); });

  // --- 详细音乐特征分析 (新增) ---
  const excludeChineseGenres = opts.excludeChineseGenres || false;
  safe('music_characteristics', () => {
    out.music_characteristics = analyzeMusicCharacteristics(
      samples, sampleRate, out.beats || [], loud.timeline,
      out.lufs_range, out.dyn_complexity, out.bpm_raw, kickStrengths, excludeChineseGenres
    );

    // --- 八度错误校正 (使用精确特征 + 风格信息) ---
    const mc = out.music_characteristics;
    if (mc && mc.spectral && mc.rhythm) {
      const correction = correctOctaveError(out.bpm_raw, out.beats || [], {
        lowFreqRatio: mc.spectral.low_freq_ratio,
        highFreqRatio: mc.spectral.high_freq_ratio,
        kickDensity: mc.rhythm.kick_density,
        hihatDensity: mc.rhythm.hihat_density,
        dynamicRange: mc.dynamic.lufs_range,
        dynComplexity: out.dyn_complexity || 3,
        genreAnalysis: mc.genre_analysis  // 复用已计算的风格信息，零额外开销
      });

      if (correction.octave_correction !== 'none') {
        out.__debug.octave_correction = {
          original_bpm: correction.bpm_original,
          corrected_bpm: correction.bpm_corrected,
          type: correction.octave_correction,
          confidence: correction.octave_confidence,
          features_used: {
            hihat: mc.rhythm.hihat_density,
            kick: mc.rhythm.kick_density,
            high_freq: mc.spectral.high_freq_ratio,
            dyn_complexity: out.dyn_complexity
          }
        };
        // 应用校正
        const originalBpm = out.bpm_raw;
        out.bpm_raw = correction.bpm_corrected;
        out.beats = correction.beats_corrected;
        out.bpm_octave_corrected = true;

        // 使用校正后的 BPM 重新进行风格分类
        const genreResult = classifyGenreAdvanced(correction.bpm_corrected, {
          lowFreqRatio: mc.spectral.low_freq_ratio,
          midFreqRatio: mc.spectral.mid_freq_ratio,
          highFreqRatio: mc.spectral.high_freq_ratio,
          kickDensity: mc.rhythm.kick_density,
          hihatDensity: mc.rhythm.hihat_density,
          beatStability: mc.rhythm.beat_stability,
          dynamicRange: mc.dynamic.lufs_range,
          rmsVariance: mc.dynamic.rms_variance,
          dynComplexity: out.dyn_complexity
        }, excludeChineseGenres);
        mc.genre_analysis = genreResult;
      }
    }

    // 从详细分析中获取正确的风格信息
    if (out.music_characteristics && out.music_characteristics.genre_analysis) {
      const ga = out.music_characteristics.genre_analysis;
      out.genre_hint = ga.primary;
      out.bpm_perceived = ga.suggested_perceived_bpm;
      out.bpm_engine = out.bpm_raw;
      out.genre_confidence = ga.confidence;
      out.genre_reasoning = ga.reasoning;
    }
  });

  // --- Phrases (SongFormer 优先, 启发式 fallback) ---
  let phrases = [];
  if (Array.isArray(opts.songformerSegments) && opts.songformerSegments.length) {
    phrases = mapSongformerSegments(opts.songformerSegments);
    out.phrases_source = 'songformer';
  } else {
    safe('phrases_heur', () => { phrases = detectPhrasesHeuristic(samples, sampleRate); });
    out.phrases_source = 'heuristic_fallback';
  }

  // --- 人声时间轴 ---
  let vocal = { segments: [] };
  safe('vocal', () => { vocal = detectVocalTimeline(samples, sampleRate); });
  out.vocal_segments = vocal.segments;

  // --- 丰富 phrases (能量带+人声占比+语义标签) ---
  phrases = enrichPhrases(phrases, loud.timeline, vocal.segments, loud.integrated);
  phrases = bandPhrases(phrases);
  phrases = inferPhraseSemantics(phrases, out.duration_s, out.phrases_source);
  out.phrases = phrases;

  // --- 先计算初步的动态 BPM (用原始 beats) ---
  let preliminaryBpmSegments = [];
  safe('preliminary_bpm', () => {
    const { bpm_segments } = computeDynamicBpm(out.beats || [], phrases, out.duration_s);
    preliminaryBpmSegments = bpm_segments || [];
  });

  // --- 段落级 Beat 时间精确定位 ---
  // 禁用：madmom 的 beats 已经很准确，refineBeatTimesBySection 反而会引入误差
  // 原因：该函数假设 beats 应该对齐到 kick/bass attack，但这对于电子舞曲等风格不适用
  // let beatRefinement = { refined: [], offsets: [], confidences: [], sectionShifts: [] };
  // safe('beat_refine', () => {
  //   beatRefinement = refineBeatTimesBySection(samples, sampleRate, out.beats || [], preliminaryBpmSegments, phrases, out.bpm_raw);
  //   if (beatRefinement.refined.length > 0) {
  //     out.beats_original = out.beats;  // 保留原始 beats 供对比
  //     out.beats = beatRefinement.refined;  // 使用校准后的 beats
  //     out.beat_offsets = beatRefinement.offsets;
  //     out.beat_confidences = beatRefinement.confidences;
  //     out.section_shifts = beatRefinement.sectionShifts;  // 每个段落的偏移状态
  //   }
  // });

  // --- 动态 BPM (用校准后的 beats 重新计算) ---
  safe('dynamic_bpm', () => {
    const { bpm_timeline, bpm_segments } = computeDynamicBpm(out.beats || [], phrases, out.duration_s);
    out.bpm_timeline = bpm_timeline;
    out.bpm_segments = bpm_segments;
  });

  // --- 增强版 downbeat 检测 (改进版) ---
  // 使用多特征 + 高能量段落锚定 + 多小节一致性验证
  // 如果 madmom 已提供结果，直接使用
  let downbeats = [], mediums = [], fills = [];
  let downbeatConfidences = null, mediumConfidences = null;

  if (out._madmom_downbeats && out._madmom_downbeats.length > 0) {
    // 使用 madmom 的 downbeat 结果，但需要对齐到 beat 网格
    const beats = out.beats || [];

    // 辅助函数：将时间对齐到最近的 beat
    // 使用较大容差(0.3s = 半个beat间隔)以处理madmom相位误差
    const snapToNearestBeat = (t, tolerance = 0.3) => {
      if (!beats.length) return t;
      let nearest = null, minDist = Infinity;
      let nearestIdx = -1;
      for (let i = 0; i < beats.length; i++) {
        const b = beats[i];
        const dist = Math.abs(b - t);
        if (dist < minDist) { minDist = dist; nearest = b; nearestIdx = i; }
      }
      // 只有在容差范围内才对齐，否则保持原值
      return minDist <= tolerance ? nearest : t;
    };

    // 对齐 downbeats 和 medium_beats 到 beat 网格
    const rawDownbeats = out._madmom_downbeats;
    const rawMediums = out._madmom_medium_beats || [];

    // 先对齐到最近的beat
    const snappedDownbeats = rawDownbeats.map(t => +snapToNearestBeat(t).toFixed(3));
    const snappedMediums = rawMediums.map(t => +snapToNearestBeat(t).toFixed(3));

    // 禁用相位校正，直接信任 madmom 原始输出
    // 原因：madmom 已经考虑了弱起拍(anacrusis)，相位校正反而会搞乱正确的检测结果
    downbeats = snappedDownbeats;
    mediums = snappedMediums;
    out.downbeat_source = 'madmom_snapped';

    // 记录相位信息用于调试（但不校正）
    if (snappedDownbeats.length > 0 && beats.length > 0) {
      const firstDb = snappedDownbeats[0];
      let firstDbIdx = -1;
      for (let i = 0; i < beats.length; i++) {
        if (Math.abs(beats[i] - firstDb) < 0.01) {
          firstDbIdx = i;
          break;
        }
      }
      if (firstDbIdx >= 0) {
        const phaseError = firstDbIdx % 4;
        if (phaseError !== 0) {
          out.__debug.downbeat_phase_offset = phaseError;
          out.__debug.downbeat_first_beat_index = firstDbIdx;
        }
      }
    }

    // 记录对齐调整量
    const downbeatAdjustments = rawDownbeats.map((t, i) => +(t - downbeats[i]).toFixed(3));
    const avgAdjustment = downbeatAdjustments.reduce((a, b) => a + Math.abs(b), 0) / downbeatAdjustments.length;
    if (avgAdjustment > 0.01) {
      out.__debug.downbeat_snap_avg = +avgAdjustment.toFixed(3);
      out.__debug.downbeat_snap_max = Math.max(...downbeatAdjustments.map(Math.abs)).toFixed(3);
    }

    // 从 downbeats 计算 phase 和 step
    const meter = out.time_signature?.numerator || 4;
    out.downbeat_step = meter;
    out.meter = meter;

    // 填充 fill_beats (非 downbeat/medium 的 beats)
    const downbeatSet = new Set(downbeats.map(t => +t.toFixed(3)));
    const mediumSet = new Set(mediums.map(t => +t.toFixed(3)));
    fills = (out.beats || []).filter(t => {
      const rounded = +t.toFixed(3);
      return !downbeatSet.has(rounded) && !mediumSet.has(rounded);
    });

    out.downbeats = downbeats;
    out.medium_beats = mediums;
    out.fill_beats = fills;

    // madmom 没有提供置信度，使用默认值
    out.downbeat_confidences = null;
    out.medium_beat_confidences = null;
    out.meter_confidence = madmomData?.confidence || 0.7;

    out.__debug.downbeat_score = out.meter_confidence;
    out.__debug.downbeat_consistency = out.meter_confidence;
  } else {
    // 使用原来的 essentia 启发式方法
    let sp = { step: 4, phase: 0, score: 0, consistency: 0 };
    if (out.beats && out.beats.length >= 8) {
      safe('downbeat_phase_robust', () => {
        sp = detectDownbeatPhaseRobust(samples, sampleRate, out.beats, loud.timeline, phrases);
      });
    }

    out.downbeat_step = sp.step;
    out.downbeat_phase = sp.phase;
    out.meter = sp.meter || sp.step;  // 拍号
    out.meter_confidence = sp.meterConfidence || 0;
    out.downbeat_source = 'essentia_heuristic';

    out.__debug.downbeat_score = sp.score;
    out.__debug.downbeat_consistency = sp.consistency;
    if (sp.debug) {
      out.__debug.downbeat_debug = sp.debug;
    }
    if (sp.meterDebug) {
      out.__debug.meter_candidates = sp.meterDebug.candidates;
    }

    // --- 整曲 3 层节拍 ---
    const layers = extractBeatLayers(out.beats || [], sp.phase, sp.step, out.beat_confidences);
    downbeats = layers.downbeats;
    mediums = layers.mediums;
    fills = layers.fills;
    downbeatConfidences = layers.downbeatConfidences;
    mediumConfidences = layers.mediumConfidences;

    out.downbeats = downbeats;
    out.medium_beats = mediums;
    out.fill_beats = fills;
    out.downbeat_confidences = downbeatConfidences;
    out.medium_beat_confidences = mediumConfidences;
  }

  // --- 和弦走向输出 ---
  out.chord_timeline = chordRes.timeline;
  out.chord_changes = chordRes.changes;

  // --- suggested_cut_points ---
  out.suggested_cut_points = buildCutPoints(out.beats || [], downbeats, mediums, chordRes.changes, phrases, downbeatConfidences, mediumConfidences);

  // --- 方案B：对齐段落边界到节拍切点 ---
  // 在生成 suggested_cut_points 之后，对齐 phrases 的边界
  const alignedPhrases = alignPhrasesToCutPoints(phrases, out.suggested_cut_points, out.beats, out.duration_s);
  out.phrases = alignedPhrases;

  // --- 建议切入点（基于重拍的新逻辑）---
  out.recommended_cut_points = buildRecommendedCutPoints(downbeats, mediums, alignedPhrases);

  // 更新调试信息
  out.__debug.phrase_alignment = {
    original_count: phrases.length,
    aligned_count: alignedPhrases.filter(p => p._alignment === 'aligned').length,
    no_cut_points_count: alignedPhrases.filter(p => p._alignment === 'no_cut_points').length,
    invalid_count: alignedPhrases.filter(p => p._alignment === 'invalid_after_align').length
  };

  return out;
}

async function analyzeFile(inputPath, opts = {}) {
  const ext = path.extname(inputPath).toLowerCase();
  const wavBuf = ext === '.wav' ? fs.readFileSync(inputPath) : decodeToMonoWav(inputPath);
  const decoded = wav.decode(wavBuf);

  // 语言检测 (异步, 失败不阻塞主流程)
  let languageInfo = null;
  if (opts.skipLanguageDetection !== true) {
    try {
      languageInfo = await detectLanguage(inputPath, 30);
      opts.language = languageInfo.language;
      opts.language_probability = languageInfo.probability;
      opts.excludeChineseGenres = shouldExcludeChineseGenres(languageInfo.language);
    } catch (e) {
      // 语言检测失败不影响主流程
      opts.language = 'unknown';
      opts.excludeChineseGenres = false;
    }
  }

  // 尝试使用 madmom 服务检测 beat/downbeat/time_signature
  if (opts.useMadmom !== false) {  // 默认启用，除非明确设置 useMadmom: false
    console.log('[madmom] 尝试调用 Python 服务...');
    const madmomResult = callMadmomService(inputPath);
    if (!madmomResult.error && !madmomResult.fallback) {
      console.log(`[madmom] 成功! beats=${madmomResult.beats?.length} downbeats=${madmomResult.downbeats?.length} meter=${madmomResult.time_signature?.numerator}/${madmomResult.time_signature?.denominator}`);
      opts.madmomResult = madmomResult;
    } else {
      console.log(`[madmom] 失败，fallback 到 essentia.js: ${madmomResult.error}`);
    }
  }

  const out = await analyzeSamples(decoded.channelData[0], decoded.sampleRate, opts);
  out.file = path.basename(inputPath);

  // 记录语言检测结果
  if (languageInfo) {
    out.language = languageInfo.language;
    out.language_probability = languageInfo.probability;
  }

  // ========== 重拍类型分析 ==========
  // 在获取到 downbeats 和 medium_beats 之后调用
  if (out.downbeats && out.downbeats.length >= 3 && out.medium_beats && out.medium_beats.length >= 3) {
    console.log('[beat_weight] 分析重拍类型...');
    const beatWeightResult = callBeatWeightAnalysis(inputPath, out.downbeats, out.medium_beats);
    if (!beatWeightResult.error) {
      out.beat_weight = {
        weight_type: beatWeightResult.weight_type,
        confidence: beatWeightResult.confidence,
        reason: beatWeightResult.reason
      };
      // 如果有详细数据，也记录下来
      if (beatWeightResult.details) {
        out.beat_weight.details = beatWeightResult.details;
      }
      console.log(`[beat_weight] 类型=${beatWeightResult.weight_type} 置信度=${beatWeightResult.confidence} 原因=${beatWeightResult.reason}`);
    } else {
      console.log(`[beat_weight] 分析失败: ${beatWeightResult.error}`);
      out.beat_weight = {
        weight_type: 'mixed',
        confidence: 0,
        error: beatWeightResult.error
      };
    }
  } else {
    console.log('[beat_weight] 跳过: beat数据不足');
    out.beat_weight = {
      weight_type: 'mixed',
      confidence: 0,
      error: 'insufficient beat data'
    };
  }

  return out;
}

function shutdown() { if (_essentia) { _essentia.shutdown(); _essentia = null; } }

module.exports = {
  analyzeFile, analyzeSamples, shutdown, decodeToMonoWav,
  mapSongformerSegments, detectPhrasesHeuristic,
};

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const opts = {
      modules: {
        beats: false,
        bpm: false,
        phrases: false,
        cuts: false,
        full: true  // 默认全部输出
      },
      jsonPath: null,
      report: false
    };
    const positional = [];

    // 解析参数
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--beats') {
        opts.modules.beats = true;
        opts.modules.full = false;
      } else if (a === '--bpm') {
        opts.modules.bpm = true;
        opts.modules.full = false;
      } else if (a === '--phrases') {
        opts.modules.phrases = true;
        opts.modules.full = false;
      } else if (a === '--cuts') {
        opts.modules.cuts = true;
        opts.modules.full = false;
      } else if (a === '--full') {
        opts.modules.full = true;
      } else if (a === '--json') {
        opts.jsonPath = args[++i];
      } else if (a === '--report') {
        opts.report = true;
      } else if (a.startsWith('--phrases-from=')) {
        // 保留 SongFormer 支持（可选）
        const p = a.split('=')[1];
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        opts.songformerSegments = Array.isArray(j) ? j : Array.isArray(j.segments) ? j.segments : (j.data?.results?.[0]?.segments) || [];
      } else if (a.startsWith('--beat-offset=')) {
        opts.beatOffset = parseFloat(a.split('=')[1]);
      } else if (!a.startsWith('--')) {
        positional.push(a);
      }
    }

    const inp = positional[0];
    if (!inp) {
      console.error('Usage: ai-music-ai-video-analyzer <audio_file> [options]');
      console.error('');
      console.error('Options:');
      console.error('  --beats      只输出节拍相关数据');
      console.error('  --bpm        只输出 BPM 相关数据');
      console.error('  --phrases    只输出段落识别数据');
      console.error('  --cuts       只输出推荐切点');
      console.error('  --full       全部输出（默认）');
      console.error('  --json <path>  保存 JSON 到指定路径');
      console.error('  --report     生成 HTML 可视化报告');
      console.error('  --phrases-from=<file>  使用外部段落数据');
      console.error('  --beat-offset=<秒>    节拍偏移量');
      process.exit(1);
    }

    const defaultOutPath = inp.replace(/\.[^.]+$/, '.analysis.json');
    const outPath = opts.jsonPath || defaultOutPath;

    console.log(`[ai-music-ai-video-analyzer] ${inp}`);
    console.log(`  modules: ${opts.modules.full ? 'full' : [opts.modules.beats && 'beats', opts.modules.bpm && 'bpm', opts.modules.phrases && 'phrases', opts.modules.cuts && 'cuts'].filter(Boolean).join('+') || 'full'}`);

    const r = await analyzeFile(inp, opts);

    // 根据模块化参数过滤输出
    let output = {};
    if (opts.modules.full) {
      output = r;
    } else {
      output.duration_s = r.duration_s;  // Add duration_s to all modular outputs
      if (opts.modules.beats) {
        output.beats = r.beats;
        output.downbeats = r.downbeats;
        output.medium_beats = r.medium_beats;
        output.time_signature = r.time_signature;
        output.beat_weight = r.beat_weight;
      }
      if (opts.modules.bpm) {
        output.bpm = r.bpm;
        output.bpm_raw = r.bpm_raw;
        output.bpm_perceived = r.bpm_perceived;
        output.bpm_timeline = r.bpm_timeline;
        output.bpm_segments = r.bpm_segments;
        output.genre_hint = r.genre_hint;
      }
      if (opts.modules.phrases) {
        output.phrases = r.phrases;
        output.phrases_source = r.phrases_source;
      }
      if (opts.modules.cuts) {
        output.suggested_cut_points = r.suggested_cut_points;
        output.recommended_cut_points = r.recommended_cut_points;
      }
    }

    // 保存 JSON
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.log(`  → ${outPath}`);

    // 生成报告
    if (opts.report) {
      const reportPath = inp.replace(/\.[^.]+$/, '.report.html');
      // 调用 gen_report.cjs
      const { execSync } = require('child_process');
      const reportScript = path.join(__dirname, 'gen_report.cjs');
      execSync(`node "${reportScript}" "${outPath}" "${inp}" "${reportPath}"`, { stdio: 'inherit' });
      console.log(`  → ${reportPath}`);
    }

    // 打印摘要
    console.log(`  bpm_raw=${r.bpm_raw} bpm_perceived=${r.bpm_perceived} genre=${r.genre_hint}`);
    console.log(`  phrases=${r.phrases?.length} beats=${r.beats?.length} cuts=${r.suggested_cut_points?.length}`);

    shutdown();
  })().catch(e => { console.error('FATAL:', e); process.exit(1); });
}
