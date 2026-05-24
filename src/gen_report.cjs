// 可视化报告生成 v6: 导演视角, 每指标带"怎么用"语义标签
// Usage:
//   node gen_report.cjs <analysis.json> [audio.mp3] [output.html]
//   node gen_report.cjs --dir <dir>   # 批量: 对 dir 下所有 .analysis.json 生成 .report.html

const fs = require('fs');
const path = require('path');

const GENRE_CN = {
  edm_house: 'EDM / House',
  trap: 'Trap / 下沉 DJ',
  pop_ballad: '情歌 / 流行抒情',
  slow_ballad: '慢板 / 抒情',
  rock: '摇滚',
  hiphop: '嘻哈 / Hip-Hop',
  ambient: '氛围 / Ambient',
  classical: '古典 / Classical',
  ethnic_electronic: '国风/民族电音',
  guofeng_pop: '国风流行',
  ethnic_traditional: '传统民族',
  electronic_dance: '电子舞曲',
  uptempo: '快板',
  other: '未分类',
  unknown: '未知',
};
const GENRE_CUT_TIP = {
  edm_house: '为 drop 服务 · Build-up 视觉蓄力 · Drop 瞬间爆发',
  trap: 'Hi-hat roll = 快切弹幕 · 808 滑音 = 镜头推拉',
  pop_ballad: '主歌每 2 小节一切 · 副歌每 1 小节一切 · 动作落 downbeat',
  slow_ballad: '长镜头为主 · 镜头内部调度 · 色调偏暗中景',
  rock: '强拍切镜 · 吉他 solo 特写 · 动态运镜配合节奏',
  hiphop: 'Beat 驱动 · 鼓点对切 · Flow 段落长镜头',
  ambient: '极简剪辑 · 长镜头渐变 · 氛围画面为主',
  classical: '乐句边界切 · 乐器特写 · 情绪随配器变化',
  ethnic_electronic: '民族音色配电子节奏 · 节奏层快切 · 旋律层长镜头',
  guofeng_pop: '国风画面 · 乐器间奏特写 · 副歌高潮多切',
  ethnic_traditional: '尊重乐句呼吸 · 传统乐器特写 · 自然光影',
  electronic_dance: '节拍驱动 · Drop 爆发 · 鼓点同步快切',
  uptempo: '节奏驱动 · 打击 hit 上重切 · 镜头运动速度匀速',
  other: '按 phrase 边界 + downbeat 卡点',
  unknown: '按 phrase 边界 + downbeat 卡点',
};
const DENSITY_TIP = {
  long_take: '长镜头 · 镜头内部调度 · 信息量低',
  normal: '正常剪辑 · 每 1-2 小节一切 · 中信息量',
  fast_cut_glitch: '快切 + glitch · 多镜头堆叠 · 高信息量',
};
const PHRASE_CN = {
  intro: '前奏', verse: '主歌', chorus: '副歌', bridge: '桥段',
  outro: '尾奏', inst: '器乐段', silence: '静音',
  pre_chorus: '预副歌',
};

// 将 semantic_label 转换为中文显示（处理 verse2, chorus2 等变体）
function semanticToCN(label) {
  if (!label) return '未知';
  // 处理带数字的变体: verse2 -> 主歌2, chorus3 -> 副歌3
  const match = label.match(/^(intro|verse|chorus|bridge|outro|inst|silence|pre_chorus)(\d*)$/);
  if (match) {
    const base = PHRASE_CN[match[1]] || match[1];
    const num = match[2] || '';
    return base + num;
  }
  // 处理 _ext 后缀: chorus_ext -> 副歌延续
  if (label.endsWith('_ext')) {
    const base = label.replace('_ext', '');
    return (PHRASE_CN[base] || base) + '延续';
  }
  return label;
}
const PHRASE_CUT_TIP = {
  intro: '铺垫 · 场景引入 · 低信息量',
  verse: '推进叙事 · 人物/环境细节 · 中景',
  chorus: '主剪辑点 · 能量释放 · 大景/动作',
  bridge: '情绪转折 · 反差 · 特殊色调',
  outro: '收束 · 画面凝定 · 长镜头',
  inst: '导演自由发挥 · 纯画面语言',
  silence: '空镜/过渡 · 无需卡点',
};

function fileToBase64(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const data = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.mp3' ? 'audio/mpeg' : ext === '.wav' ? 'audio/wav' : ext === '.m4a' ? 'audio/mp4' : 'audio/mpeg';
  return `data:${mime};base64,${data.toString('base64')}`;
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

// ========== DC 区间检测算法 ==========
// 找 DC 局部峰值区间，最多返回 3 个快切区间
function detectDCIntervals(dcTl, maxFastCut = 3) {
  if (!dcTl || dcTl.length < 2) return [];

  // Step 0: 计算全局 DC 统计值
  const allDcVals = dcTl.map(x => x.dc);
  const globalMean = allDcVals.reduce((a, b) => a + b, 0) / allDcVals.length;
  const globalVariance = allDcVals.reduce((sum, v) => sum + (v - globalMean) ** 2, 0) / allDcVals.length;
  const globalStd = Math.sqrt(globalVariance);

  // 使用 top 15% 作为快切阈值
  const sortedDc = [...allDcVals].sort((a, b) => a - b);
  const top15Idx = Math.floor(sortedDc.length * 0.85);
  const fastCutThreshold = sortedDc[top15Idx];

  // Step 1: 找出所有高于阈值的采样点
  const highDcPoints = dcTl.filter(p => p.dc >= fastCutThreshold);
  if (highDcPoints.length === 0) return [];

  // Step 2: 将相邻的高值点聚合成区间（允许 2 秒间隔）
  const segments = [];
  let currentSeg = { start: highDcPoints[0].t, end: highDcPoints[0].t, dcSum: highDcPoints[0].dc, count: 1 };

  for (let i = 1; i < highDcPoints.length; i++) {
    const gap = highDcPoints[i].t - currentSeg.end;
    if (gap <= 2.0) {
      currentSeg.end = highDcPoints[i].t;
      currentSeg.dcSum += highDcPoints[i].dc;
      currentSeg.count++;
    } else {
      segments.push(currentSeg);
      currentSeg = { start: highDcPoints[i].t, end: highDcPoints[i].t, dcSum: highDcPoints[i].dc, count: 1 };
    }
  }
  segments.push(currentSeg);

  // Step 3: 计算每个区间的 avg_dc，按值排序取 top N
  const fastCutCandidates = segments
    .map(seg => ({
      start: seg.start,
      end: seg.end,
      avg_dc: seg.dcSum / seg.count
    }))
    .filter(seg => seg.end - seg.start >= 1.0) // 至少 1 秒
    .sort((a, b) => b.avg_dc - a.avg_dc)
    .slice(0, maxFastCut);

  // Step 4: 构建完整区间列表（包含 normal 区间）
  const intervals = [];
  const dur = dcTl[dcTl.length - 1].t;
  const sortedFastCut = [...fastCutCandidates].sort((a, b) => a.start - b.start);
  let lastEnd = 0;

  for (const fc of sortedFastCut) {
    if (fc.start > lastEnd) {
      const pts = dcTl.filter(p => p.t >= lastEnd && p.t < fc.start);
      const avgDc = pts.length ? pts.reduce((s, p) => s + p.dc, 0) / pts.length : globalMean;
      intervals.push({
        start: lastEnd,
        end: fc.start,
        avg_dc: avgDc,
        band: 'normal'
      });
    }
    intervals.push({ ...fc, band: 'fast_cut' });
    lastEnd = fc.end;
  }

  if (lastEnd < dur) {
    const pts = dcTl.filter(p => p.t >= lastEnd && p.t <= dur);
    const avgDc = pts.length ? pts.reduce((s, p) => s + p.dc, 0) / pts.length : globalMean;
    intervals.push({
      start: lastEnd,
      end: dur,
      avg_dc: avgDc,
      band: 'normal'
    });
  }

  return intervals;
}

function buildHtml(a, audioDataUri) {
  const durS = a.duration_s || 0;
  // 固定时间尺: 每秒 14px, 让短歌/长歌都能松散展开, 不够宽就水平滚动
  const PX_PER_SEC = 14;
  const innerW = Math.max(900, Math.round(durS * PX_PER_SEC));
  const pxAt = t => (t * PX_PER_SEC).toFixed(1);
  const pxW = w => Math.max(2, w * PX_PER_SEC).toFixed(1);

  // SVG 宽度与内部时间轴一致，确保对齐
  const svgW = innerW;

  // 段落颜色映射（基于语义标签）
  const phraseColors = {
    intro: '#3d4a5c', verse: '#4a6184', chorus: '#d84a6b', bridge: '#8a4aa0',
    outro: '#4a5c6d', inst: '#6b8e23', silence: '#2a2a2a', pre_chorus: '#6a5acd'
  };
  const getPhraseColor = label => {
    // 处理带数字或后缀的标签: verse2 -> verse, chorus_ext -> chorus
    const base = (label || '').replace(/\d+$/, '').replace('_ext', '').replace('_continuation', '');
    return phraseColors[base] || '#555';
  };

  // 生成段落 HTML，使用 semantic_label - 增强版显示时间范围
  const phrasesHtml = (a.phrases || []).map((p, idx) => {
    const semanticLabel = p.semantic_label || p.label || 'unknown';
    const labelCN = semanticToCN(semanticLabel);
    const bandCN = p.energy_band === 'high' ? '高能' : p.energy_band === 'low' ? '低能' : '中能';
    const duration = (p.end - p.start).toFixed(1);
    const lufs = p.avg_lufs?.toFixed(1) || '—';

    // 格式化时间显示
    const fmtTime = t => {
      const m = Math.floor(t / 60);
      const s = (t % 60).toFixed(1);
      return m > 0 ? `${m}:${(s < 10 ? '0' : '') + s}` : `${s}s`;
    };
    const timeRange = `${fmtTime(p.start)}-${fmtTime(p.end)}`;

    // 在块上显示：标签 + 时间范围 + 时长
    const titleText = `${labelCN} | ${timeRange} | ${duration}s | LUFS ${lufs}dB | ${bandCN}`;

    // 计算宽度，决定显示内容
    const widthPx = parseFloat(pxW(p.end - p.start));

    return `<div class="phrase" data-idx="${idx}" data-start="${p.start}" data-end="${p.end}" style="left:${pxAt(p.start)}px;width:${pxW(p.end - p.start)}px;background:${getPhraseColor(semanticLabel)}" title="${esc(titleText)}">
      <span class="p-label">${esc(labelCN)}</span>
      <span class="p-time">${timeRange}</span>
    </div>`;
  }).join('');

  // 辅助函数：时间转 mm:ss 格式
  const formatTime = t => {
    const m = Math.floor(t / 60);
    const s = (t % 60).toFixed(1);
    return m > 0 ? `${m}:${(s < 10 ? '0' : '') + s}` : `${s}s`;
  };

  // 辅助函数：根据时间找所属 phrase
  const findPhraseAt = t => {
    const p = a.phrases?.find(p => t >= p.start && t < p.end);
    return p ? { label: semanticToCN(p.semantic_label || p.label), ...p } : null;
  };

  // ========== 切点检测算法 ==========
  // 基于强拍 + LUFS 组合预测推荐切点
  // 动态阈值：基于歌曲自身的 LUFS 分布

  // 计算所有切点
  function detectCutPoints(analysis) {
    const cutPoints = [];
    const downbeats = analysis.downbeats || [];
    const mediumBeats = analysis.medium_beats || [];
    const lufsTl = analysis.loudness_timeline || [];
    const phrases = analysis.phrases || [];
    const beatWeight = analysis._beat_weight || { weight_type: 'mixed', confidence: 0 };

    // 计算动态 LUFS 阈值（用于标注，不过滤）
    const lufsVals = lufsTl.map(x => x.lufs_st).filter(isFinite);
    let lufsThreshold = -20;
    if (lufsVals.length > 0) {
      const sorted = [...lufsVals].sort((a, b) => a - b);
      const top30Idx = Math.floor(sorted.length * 0.7);
      lufsThreshold = sorted[top30Idx];
      lufsThreshold = Math.max(lufsThreshold, -30);
    }

    // 辅助：获取某时间点的 LUFS 值
    const getLufsAt = (t) => {
      if (!lufsTl.length) return -Infinity;
      let best = lufsTl[0];
      for (const p of lufsTl) {
        if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
      }
      return best.lufs_st;
    };

    // 根据 beat_weight 判断结果选择推荐的拍位
    const weightType = beatWeight.weight_type || 'mixed';

    // 主要拍点：根据判断结果选择
    let primaryBeats = [];

    if (weightType === 'medium') {
      // 次强拍为主重拍 → 推荐所有次强拍
      primaryBeats = mediumBeats.map(t => ({ t, beatType: 'medium' }));
    } else if (weightType === 'downbeat') {
      // 强拍为主重拍 → 推荐所有强拍
      primaryBeats = downbeats.map(t => ({ t, beatType: 'downbeat' }));
    } else {
      // mixed: 两种都推荐
      primaryBeats = [
        ...downbeats.map(t => ({ t, beatType: 'downbeat' })),
        ...mediumBeats.map(t => ({ t, beatType: 'medium' }))
      ].sort((a, b) => a.t - b.t);
    }

    // 添加所有主要拍点作为切点
    primaryBeats.forEach(beat => {
      const lufs = getLufsAt(beat.t);
      cutPoints.push({
        t: beat.t,
        type: lufs > lufsThreshold ? 'accent' : 'beat',
        beatType: beat.beatType,
        lufs,
        lufsThreshold,
        priority: lufs > lufsThreshold ? 3 : 2
      });
    });

    // 段落边界切点
    phrases.forEach((p, idx) => {
      if (idx === 0) return;
      const t = p.start;
      const nearCut = cutPoints.find(cp => Math.abs(cp.t - t) < 0.3);
      if (!nearCut) {
        const lufs = getLufsAt(t);
        cutPoints.push({ t, type: 'phrase', lufs, lufsThreshold, priority: 2, phrase: p.semantic_label || p.label });
      }
    });

    // 按时间排序
    return cutPoints.sort((a, b) => a.t - b.t);
  }

  const cutPoints = detectCutPoints(a);

  // 获取使用的动态阈值
  const lufsThreshold = cutPoints.length > 0 ? cutPoints[0].lufsThreshold : -20;

  // 获取 beat_weight 信息
  const beatWeight = a._beat_weight || { weight_type: 'mixed', confidence: 0, reason: '' };

  // 统计各类切点数量
  const cutStats = {
    accent: cutPoints.filter(cp => cp.type === 'accent').length,
    beat: cutPoints.filter(cp => cp.type === 'beat').length,
    phrase: cutPoints.filter(cp => cp.type === 'phrase').length,
    total: cutPoints.length,
    threshold: lufsThreshold,
    weightType: beatWeight.weight_type,
    weightConf: beatWeight.confidence,
    weightReason: beatWeight.reason
  };

  // 生成切点 HTML
  const cutPointsHtml = cutPoints.map((cp, idx) => {
    let typeIcon, typeColor, typeName;

    if (cp.type === 'accent') {
      typeIcon = cp.beatType === 'downbeat' ? '★' : '◆';
      typeColor = cp.beatType === 'downbeat' ? '#00ff88' : '#ff9500';
      typeName = cp.beatType === 'downbeat' ? '重拍(强拍位)' : '重拍(次强拍位)';
    } else if (cp.type === 'beat') {
      typeIcon = cp.beatType === 'downbeat' ? '▼' : '△';
      typeColor = cp.beatType === 'downbeat' ? '#5ac8fa' : '#ffcc00';
      typeName = cp.beatType === 'downbeat' ? '强拍' : '次强拍';
    } else {
      typeIcon = '◇';
      typeColor = '#af52de';
      typeName = '段落边界';
    }

    return `<div class="cut-point cut-${cp.type}" data-time="${cp.t.toFixed(3)}" data-idx="${idx}" style="left:${pxAt(cp.t)}px" title="${typeName} · ${formatTime(cp.t)} · LUFS ${cp.lufs.toFixed(1)}dB">
      <span class="cut-icon" style="color:${typeColor}">${typeIcon}</span>
    </div>`;
  }).join('');

  // 切点数据供 JS 使用
  const cutPointsData = JSON.stringify(cutPoints.map(cp => ({
    t: cp.t,
    type: cp.type,
    lufs: cp.lufs,
    phrase: cp.phrase || null
  })));

  // LUFS timeline 画 SVG - 使用与时间轴相同的宽度实现同步
  const tl = a.loudness_timeline || [];
  const minL = Math.min(...tl.map(x => x.lufs_st).filter(isFinite), -40);
  const maxL = Math.max(...tl.map(x => x.lufs_st).filter(isFinite), 0);
  const range = maxL - minL || 1;
  const lufsSvgH = 100;
  const lufsPolyPts = tl.map(x => `${pxAt(x.t)},${(lufsSvgH - (x.lufs_st - minL) / range * lufsSvgH).toFixed(1)}`).join(' ');

  const topSegsSvg = (a.top_loudness_segments || []).map((s, i) => {
    const x1 = parseFloat(pxAt(s.start));
    const x2 = parseFloat(pxAt(s.end));
    return `<rect x="${x1.toFixed(1)}" y="2" width="${(x2 - x1).toFixed(1)}" height="${lufsSvgH - 4}" fill="#ff6b9d" fill-opacity="0.14" stroke="#ff6b9d" stroke-width="1" stroke-opacity="0.55" rx="3"/><text x="${(x1 + 4).toFixed(1)}" y="16" fill="#ffbed2" font-size="11" font-weight="500">#${i + 1} · ${s.avg_lufs} LUFS</text>`;
  }).join('');

  // LUFS 曲线交互数据
  const lufsClickData = tl.map(x => {
    const phrase = findPhraseAt(x.t);
    return { t: x.t, lufs: x.lufs_st, phrase: phrase?.label || '', phraseStart: phrase?.start, phraseEnd: phrase?.end };
  });

  // LUFS SVG - 宽度与时间轴一致
  const lufsSvgContent = `
    <div class="curve-tooltip" id="lufs-tooltip" style="display:none;"></div>
    <svg style="width:${innerW}px;height:${lufsSvgH}px;" preserveAspectRatio="none" id="lufs-svg">
      ${topSegsSvg}
      <polyline points="${lufsPolyPts}" fill="none" stroke="#5ac8fa" stroke-width="1.3"/>
      <polyline points="0,${lufsSvgH} ${lufsPolyPts} ${innerW},${lufsSvgH}" fill="#5ac8fa" fill-opacity="0.08" stroke="none"/>
      <text x="4" y="12" fill="#5ac8fa" font-size="10" opacity="0.7">${maxL.toFixed(0)} dB</text>
      <text x="4" y="${lufsSvgH - 4}" fill="#5ac8fa" font-size="10" opacity="0.7">${minL.toFixed(0)} dB</text>
    </svg>`;

  // BPM timeline 画 SVG - 使用与时间轴相同的宽度
  const bpmTl = a.bpm_timeline || [];
  const bpmSegs = a.bpm_segments || [];
  let bpmSvgContent = '';
  let bpmDotData = '';
  if (bpmTl.length >= 2) {
    const bpmVals = bpmTl.map(x => x.bpm).filter(isFinite);
    const minB = Math.min(...bpmVals);
    const maxB = Math.max(...bpmVals);
    const bpmMin = Math.floor(minB - 5);
    const bpmMax = Math.ceil(maxB + 5);
    const bpmSvgH = 100;
    const polyPtsArr = bpmTl.map(x => {
      const sx = pxAt(x.t);
      const sy = (bpmSvgH - (x.bpm - bpmMin) / (bpmMax - bpmMin) * bpmSvgH).toFixed(1);
      return { sx, sy };
    });
    const bpmPolyPts = polyPtsArr.map(p => `${p.sx},${p.sy}`).join(' ');
    const bpmPhraseLines = bpmSegs.filter(s => s.start > 0.5 && s.start < durS - 0.5).map(s => {
      const x = pxAt(s.start);
      return `<line x1="${x}" y1="0" x2="${x}" y2="${bpmSvgH}" stroke="#34c759" stroke-width="1" stroke-dasharray="4,3" opacity="0.5"/>`;
    }).join('');
    const bpmDots = bpmTl.map((x, i) => {
      const p = polyPtsArr[i];
      const sec = bpmSegs.find(s => x.t >= s.start - 0.01 && x.t <= s.end + 0.01);
      const secLabel = sec ? sec.label : '';
      return `<circle class="bpm-dot" data-t="${x.t}" data-bpm="${x.bpm}" data-sec="${esc(secLabel)}" cx="${p.sx}" cy="${p.sy}" r="6" fill="transparent" stroke="transparent"/>`;
    }).join('');
    const dotsArr = bpmTl.map((x, i) => {
      const sec = bpmSegs.find(s => x.t >= s.start - 0.01 && x.t <= s.end + 0.01);
      return { t: x.t, bpm: x.bpm, sec: sec ? sec.label : '' };
    });
    bpmDotData = JSON.stringify(dotsArr);
    bpmSvgContent = `
    <div class="bpm-tooltip" id="bpm-tooltip" style="display:none;"></div>
    <svg style="width:${innerW}px;height:${bpmSvgH}px;" preserveAspectRatio="none" id="bpm-svg">
      ${bpmPhraseLines}
      <polyline points="${bpmPolyPts}" fill="none" stroke="#34c759" stroke-width="1.3"/>
      <polyline points="0,${bpmSvgH} ${bpmPolyPts} ${innerW},${bpmSvgH}" fill="#34c759" fill-opacity="0.06" stroke="none"/>
      ${bpmDots}
      <text x="4" y="12" fill="#34c759" font-size="10" opacity="0.7">${bpmMax.toFixed(0)} BPM</text>
      <text x="4" y="${bpmSvgH - 4}" fill="#34c759" font-size="10" opacity="0.7">${bpmMin.toFixed(0)} BPM</text>
    </svg>`;
  }

  // Dyn Complexity timeline 画 SVG - 使用与时间轴相同的宽度
  const dcTl = a.dyn_complexity_timeline || [];
  let dcSvgContent = '';
  let dcClickData = '';
  let dcIntervals = [];
  if (dcTl.length >= 2) {
    const dcVals = dcTl.map(x => x.dc).filter(isFinite);
    const minDc = Math.min(...dcVals);
    const maxDc = Math.max(...dcVals);
    const dcRange = maxDc - minDc || 1;
    const dcSvgH = 100;

    const dcPolyPtsArr = dcTl.map(x => {
      const sx = pxAt(x.t);
      const sy = (dcSvgH - (x.dc - minDc) / dcRange * (dcSvgH - 20)).toFixed(1);
      return { sx, sy, t: x.t, dc: x.dc };
    });
    const dcPolyPts = dcPolyPtsArr.map(p => `${p.sx},${p.sy}`).join(' ');

    dcClickData = JSON.stringify(dcTl.map(x => {
      const phrase = findPhraseAt(x.t);
      return { t: x.t, dc: x.dc, band: x.density_band, phrase: phrase?.label || '' };
    }));

    dcIntervals = detectDCIntervals(dcTl);

    const fastCutColor = { fill: 'rgba(255, 59, 122, 0.12)', stroke: '#ff3b7a' };
    const dcIntervalRects = dcIntervals.filter(interval => interval.band === 'fast_cut').map(interval => {
      const x1 = parseFloat(pxAt(interval.start));
      const x2 = parseFloat(pxAt(interval.end));
      const width = Math.max(2, x2 - x1).toFixed(1);
      return `<rect class="dc-interval" x="${x1.toFixed(1)}" y="0" width="${width}" height="${dcSvgH}" fill="${fastCutColor.fill}" stroke="${fastCutColor.stroke}" stroke-width="1" stroke-opacity="0.3" rx="2" data-start="${interval.start.toFixed(1)}" data-end="${interval.end.toFixed(1)}" data-band="fast_cut"/>`;
    }).join('');

    const dcIntervalLabels = dcIntervals.filter(interval => interval.band === 'fast_cut').map(interval => {
      const midX = ((parseFloat(pxAt(interval.start)) + parseFloat(pxAt(interval.end))) / 2).toFixed(1);
      return `<text x="${midX}" y="${dcSvgH - 6}" fill="#ff3b7a" font-size="8" text-anchor="middle" font-weight="500" opacity="0.9">快切</text>`;
    }).join('');

    dcSvgContent = `
    <div class="curve-tooltip" id="dc-tooltip" style="display:none;"></div>
    <svg style="width:${innerW}px;height:${dcSvgH}px;" preserveAspectRatio="none" id="dc-svg">
      ${dcIntervalRects}
      <polyline points="${dcPolyPts}" fill="none" stroke="#af52de" stroke-width="1.3"/>
      <polyline points="0,${dcSvgH} ${dcPolyPts} ${innerW},${dcSvgH}" fill="#af52de" fill-opacity="0.06" stroke="none"/>
      ${dcIntervalLabels}
      <text x="4" y="${dcSvgH - 4}" fill="#af52de" font-size="10" opacity="0.7">${minDc.toFixed(1)}</text>
      <text x="4" y="12" fill="#af52de" font-size="10" opacity="0.7">${maxDc.toFixed(1)}</text>
    </svg>`;
  }


  // --- 以下全部采用像素定位, 在 timeline-inner 中 ---
  // 节拍分层 - 添加 data-time 用于涟漪特效触发
  const downbeatsHtml = (a.downbeats || []).map(t => `<div class="bm bm-d" data-time="${t.toFixed(3)}" style="left:${pxAt(t)}px"></div>`).join('');
  const mediumsHtml = (a.medium_beats || []).map(t => `<div class="bm bm-m" data-time="${t.toFixed(3)}" style="left:${pxAt(t)}px"></div>`).join('');
  const fillsHtml = (a.fill_beats || []).map(t => `<div class="bm bm-f" data-time="${t.toFixed(3)}" style="left:${pxAt(t)}px"></div>`).join('');

  const rulerHtml = Array.from({ length: Math.ceil(durS / 5) + 1 }, (_, i) => {
    const t = i * 5;
    const major = i % 2 === 0;
    return `<span class="t ${major ? 'major' : ''}" style="left:${pxAt(t)}px">${major ? `${t}s` : ''}</span>`;
  }).join('');

  const audioBlock = audioDataUri ? `<audio id="audio" controls src="${audioDataUri}"></audio>` : '<div class="no-audio">(未附加音频)</div>';

  const masterStatus = a.lufs_integrated === null || a.lufs_integrated === undefined ? '—'
    : a.lufs_integrated >= -15 ? '商业成品 (流媒体标准)'
    : a.lufs_integrated >= -20 ? '中等响度 (影视/抒情)'
    : 'Demo / 未母带';

  const kickRatio = a.__debug?.kick_strong_ratio;

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>音乐分析报告 · ${esc(a.file || 'unknown')}</title>
<style>
  body{margin:0;padding:20px;background:#0f0f14;color:#e6e6e6;font-family:'SF Pro Display','PingFang SC','Microsoft YaHei',sans-serif;font-size:13px;line-height:1.55;}
  .wrap{max-width:1120px;margin:0 auto;}
  h1{font-size:20px;margin:0 0 6px;}
  h2{font-size:15px;margin:30px 0 10px;color:#9acdff;border-left:3px solid #5ac8fa;padding-left:8px;}
  .subtitle{color:#999;margin-bottom:20px;}
  .cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px;}
  .card{background:#1a1a22;border-radius:8px;padding:12px;border:1px solid #2a2a35;}
  .card .k{font-size:11px;color:#888;margin-bottom:4px;}
  .card .v{font-size:18px;font-weight:600;color:#fff;}
  .card .tip{font-size:10.5px;color:#7dd3fc;margin-top:3px;line-height:1.4;}
  audio{width:100%;margin:10px 0;position:sticky;top:10px;z-index:10;background:#0f0f14;}
  .no-audio{background:#1a1a22;padding:10px;border-radius:6px;text-align:center;color:#666;}

  /* === 时间轴区域 (可横向滚动, 播放时自动跟随) === */
  .tl-toolbar{display:flex;align-items:center;gap:14px;font-size:11.5px;color:#aaa;margin-bottom:8px;}
  .tl-toolbar label{cursor:pointer;user-select:none;}
  .tl-toolbar input[type="checkbox"]{vertical-align:-1px;margin-right:4px;}
  .tl-scroll{overflow-x:auto;overflow-y:hidden;background:#141419;border-radius:8px;padding:14px;border:1px solid #23232d;}
  .tl-scroll::-webkit-scrollbar{height:8px;}
  .tl-scroll::-webkit-scrollbar-track{background:#17171f;}
  .tl-scroll::-webkit-scrollbar-thumb{background:#3d3d4d;border-radius:4px;}
  .tl-inner{position:relative;}
  .lane-label{font-size:11px;color:#aaa;margin:14px 0 6px 0;letter-spacing:0.3px;}
  .lane-label:first-child{margin-top:0;}
  .lane-label b{color:#fff;font-weight:500;}
  .track{position:relative;background:#17171f;border-radius:4px;}
  .track-phrases{height:48px;}
  .track-beats{height:28px;position:relative;}
  .track-curve{position:relative;background:#17171f;border-radius:4px;cursor:crosshair;overflow:hidden;}
  .track-curve svg{display:block;}
  .phrase{position:absolute;top:0;bottom:0;color:#fff;font-size:11px;font-weight:500;display:flex;flex-direction:column;align-items:center;justify-content:center;border-right:1px solid rgba(0,0,0,0.35);cursor:pointer;padding:2px 4px;overflow:hidden;white-space:nowrap;transition:all 0.15s ease;}
  .phrase:hover{filter:brightness(1.2);transform:scaleY(1.05);z-index:2;}
  .phrase.active{box-shadow:inset 0 0 0 2px #fff, 0 0 12px rgba(255,255,255,0.3);}
  .phrase .p-label{font-size:12px;font-weight:600;}
  .phrase .p-time{font-size:9px;opacity:0.7;margin-top:1px;}
  .phrase .p-lufs{font-size:9px;opacity:0.5;}
  .track-beats{height:28px;position:relative;}
  .bm{position:absolute;top:0;bottom:0;width:1px;transition:background 0.1s, box-shadow 0.1s;}
  .bm-d{background:rgba(90,200,250,0.25);width:3px;top:0;bottom:0;}
  .bm-d.active{background:#5ac8fa;box-shadow:0 0 8px #5ac8fa,0 0 16px #5ac8fa;}
  .bm-m{background:rgba(255,204,0,0.25);width:2px;top:2px;bottom:2px;}
  .bm-m.active{background:#ffcc00;box-shadow:0 0 8px #ffcc00,0 0 16px #ffcc00;}
  .bm-f{background:#888;width:1px;top:6px;bottom:6px;opacity:0.5;}
  .bm-ripple{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);pointer-events:none;z-index:2;}
  .bm-ripple .ripple-ring{position:absolute;border-radius:50%;animation:ripple-expand 0.7s ease-out forwards;}
  .bm-d .ripple-ring{border:2px solid #5ac8fa;box-shadow:0 0 8px #5ac8fa;}
  .bm-m .ripple-ring{border:2px solid #ffcc00;box-shadow:0 0 8px #ffcc00;}

  /* === 切点标记层 === */
  .track-cuts{height:32px;position:relative;background:#1a1a22;border-radius:4px;}
  .cut-point{position:absolute;top:50%;transform:translate(-50%,-50%);cursor:pointer;z-index:5;transition:transform 0.15s ease;}
  .cut-point:hover{transform:translate(-50%,-50%) scale(1.4);z-index:10;}
  .cut-icon{font-size:14px;text-shadow:0 0 6px currentColor;opacity:0.9;}
  .cut-point:hover .cut-icon{opacity:1;text-shadow:0 0 10px currentColor,0 0 20px currentColor;}
  .cut-point.active{transform:translate(-50%,-50%) scale(1.6);}
  .cut-point.active .cut-icon{text-shadow:0 0 12px currentColor,0 0 24px currentColor;}
  .cut-combo .cut-icon{font-size:16px;font-weight:bold;}
  .cut-tooltip{position:fixed;background:rgba(15,15,20,0.97);border:1px solid #00ff88;border-radius:8px;padding:10px 14px;font-size:12px;color:#e6e6e6;pointer-events:none;z-index:10000;min-width:180px;box-shadow:0 6px 24px rgba(0,0,0,0.7);}
  .cut-tooltip .ct-time{font-size:15px;font-weight:600;color:#fff;margin-bottom:4px;}
  .cut-tooltip .ct-type{font-weight:500;margin-bottom:2px;}
  .cut-tooltip .ct-type.combo{color:#00ff88;}
  .cut-tooltip .ct-type.downbeat{color:#5ac8fa;}
  .cut-tooltip .ct-type.lufs{color:#ff9500;}
  .cut-tooltip .ct-type.phrase{color:#af52de;}
  .cut-tooltip .ct-lufs{color:#aaa;font-size:11px;margin-top:2px;}

  .ruler{height:22px;position:relative;font-size:10px;color:#777;margin:8px 14px 0;}
  .ruler .t{position:absolute;top:4px;transform:translateX(-50%);color:#666;}
  .ruler .t.major{color:#aaa;top:2px;}
  .ruler .t::before{content:'';position:absolute;top:-4px;left:50%;width:1px;height:4px;background:#555;}
  .ruler .t.major::before{height:6px;background:#777;}

  /* Playhead 贯穿所有层 */
  .playhead{position:absolute;top:0;bottom:0;width:2px;background:#fff;pointer-events:none;z-index:100;box-shadow:0 0 8px rgba(255,255,255,0.8);}

  .legend{display:flex;flex-wrap:wrap;gap:14px;font-size:11px;color:#aaa;margin-top:10px;padding:0 4px;}
  .legend-item{display:flex;align-items:center;gap:4px;}
  .legend-dot{width:10px;height:10px;border-radius:2px;display:inline-block;}
  .svg-wrap{background:#17171f;border-radius:4px;padding:6px;margin-bottom:6px;}
  .curve-track{position:relative;cursor:crosshair;}
  .curve-tooltip{position:fixed;background:rgba(20,20,25,0.95);border:1px solid #5ac8fa;border-radius:6px;padding:10px 14px;font-size:12px;color:#e6e6e6;pointer-events:none;z-index:9999;min-width:180px;box-shadow:0 4px 16px rgba(0,0,0,0.6);}
  .curve-tooltip .tt-time{font-size:15px;font-weight:600;color:#fff;margin-bottom:4px;}
  .curve-tooltip .tt-section{color:#ffcc00;font-weight:500;margin-bottom:2px;}
  .curve-tooltip .tt-value{color:#5ac8fa;margin-top:4px;}
  .bpm-tooltip{position:fixed;background:rgba(20,20,25,0.95);border:1px solid #34c759;border-radius:6px;padding:8px 12px;font-size:12px;color:#e6e6e6;pointer-events:none;z-index:9999;min-width:160px;box-shadow:0 4px 16px rgba(0,0,0,0.6);}
  .bpm-tooltip .tt-time{font-size:14px;font-weight:600;color:#fff;margin-bottom:3px;}
  .bpm-tooltip .tt-bpm{color:#34c759;font-weight:500;}
  .bpm-tooltip .tt-sec{color:#aaa;font-size:11px;}
  .bpm-dot:hover{fill:rgba(52,199,89,0.35);stroke:#34c759;stroke-width:1.5;}
  svg{display:block;overflow:visible;}

  /* === 涟漪特效 === */
  .ripple-container{position:absolute;pointer-events:none;z-index:6;}
  .ripple-ring{position:absolute;border-radius:50%;border:2px solid var(--ripple-color);animation:ripple-expand 0.8s ease-out forwards;}
  @keyframes ripple-expand{
    0%{width:0;height:0;opacity:0.9;}
    100%{width:50px;height:50px;opacity:0;}
  }
</style>
</head><body>
<div class="wrap">
  <h1>${esc(a.file || 'unknown')}</h1>
  <div class="subtitle">总时长 ${durS.toFixed(1)}s · ${a.phrases?.length || 0} 段 · ${a.downbeats?.length || 0} strong beats · 分析源 ${a.phrases_source}</div>

  ${audioBlock}

  <div class="cards">
    <div class="card">
      <div class="k">BPM 感知 / 原始</div>
      <div class="v">${a.bpm_perceived || '—'} <span style="font-size:12px;color:#888;">/ ${a.bpm_raw || '—'}</span></div>
      <div class="tip">风格 ${GENRE_CN[a.genre_hint] || a.genre_hint}${kickRatio !== undefined ? ` · kick 强占 ${Math.round(kickRatio * 100)}%` : ''}</div>
    </div>
    <div class="card">
      <div class="k">Key</div>
      <div class="v">${a.key || '—'} ${a.scale || ''}</div>
      <div class="tip">调式情绪 · ${a.scale === 'minor' ? '偏冷/内敛' : '偏暖/开阔'}</div>
    </div>
    <div class="card">
      <div class="k">LUFS (EBU R128)</div>
      <div class="v">${a.lufs_integrated ?? '—'} <span style="font-size:12px;color:#888;">动态 ${a.lufs_range ?? '—'}</span></div>
      <div class="tip">${masterStatus}</div>
    </div>
    <div class="card">
      <div class="k">剪辑密度 (Dyn Complexity)</div>
      <div class="v">${a.dyn_complexity ?? '—'}</div>
      <div class="tip">${DENSITY_TIP[a.editing_density_band] || '—'}</div>
    </div>
    <div class="card">
      <div class="k">拍号 (Time Signature)</div>
      <div class="v">${a.time_signature?.numerator || a.meter || '—'}/${a.time_signature?.denominator || 4}</div>
      <div class="tip">${a.time_signature?.detected ? '自动检测' : '默认值'} · 每小节 ${a.time_signature?.numerator || a.meter || '—'} 拍</div>
    </div>
  </div>

  <h2>时间轴同步视图 (可横向滚动 · 点击跳转播放 · 播放时自动跟随)</h2>
  <div class="legend" style="margin-bottom:8px;">
    <span class="legend-item"><span class="legend-dot" style="background:#5ac8fa;"></span> LUFS 情绪高度</span>
    <span class="legend-item"><span class="legend-dot" style="background:#af52de;"></span> DC 剪辑密度</span>
    ${bpmSvgContent ? '<span class="legend-item"><span class="legend-dot" style="background:#34c759;"></span> BPM 曲线</span>' : ''}
    <span class="legend-item"><span class="legend-dot" style="background:#ff3b7a;"></span> 快切区间</span>
    <span class="legend-item"><span class="legend-dot" style="background:#ff6b9d;"></span> Top-${(a.top_loudness_segments || []).length} 高能段</span>
  </div>
  <div class="legend" style="margin-bottom:8px;padding-top:6px;border-top:1px solid #2a2a35;">
    <span style="color:#888;font-size:11px;margin-right:8px;">重拍切点 (阈值: ${cutStats.threshold.toFixed(1)}dB | 判断: ${cutStats.weightType === 'downbeat' ? '强拍重' : cutStats.weightType === 'medium' ? '次强拍重' : '混合'}):</span>
    <span class="legend-item"><span style="color:#00ff88;">★</span> 强拍位重拍 (${cutPoints.filter(cp => cp.type === 'accent' && cp.beatType === 'downbeat').length})</span>
    <span class="legend-item"><span style="color:#ff9500;">◆</span> 次强拍位重拍 (${cutPoints.filter(cp => cp.type === 'accent' && cp.beatType === 'medium').length})</span>
    <span class="legend-item"><span style="color:#af52de;">◇</span> 段落边界 (${cutStats.phrase})</span>
    <span style="color:#666;font-size:10px;margin-left:8px;">共 ${cutStats.total} 个</span>
  </div>
  <div class="tl-toolbar">
    <label><input type="checkbox" id="auto-scroll" checked> 自动跟随播放位置</label>
    <span>总时长 ${durS.toFixed(1)}s · 时间尺 ${PX_PER_SEC} px/秒 · 全长 ${Math.round(innerW)}px</span>
  </div>
  <div class="tl-scroll" id="tl-scroll">
    <div class="tl-inner" id="tl-inner" style="width:${innerW}px">
      <!-- LUFS 情绪高度曲线 -->
      <div class="lane-label"><b>Layer 1 · 情绪高度曲线 (LUFS short-term)</b></div>
      <div class="track track-curve curve-clickable" data-type="lufs" id="lufs-track">
        ${lufsSvgContent}
      </div>

      <!-- DC 剪辑密度曲线 -->
      ${dcSvgContent ? `
      <div class="lane-label"><b>动态复杂度曲线 (剪辑密度)</b></div>
      <div class="track track-curve curve-clickable" data-type="dc" id="dc-track">
        ${dcSvgContent}
      </div>` : ''}

      <!-- BPM 动态曲线 -->
      ${bpmSvgContent ? `
      <div class="lane-label"><b>动态 BPM 曲线</b></div>
      <div class="track track-curve" id="bpm-track">
        ${bpmSvgContent}
      </div>` : ''}

      <!-- 段落结构 -->
      <div class="lane-label"><b>段落结构</b> (语义标签 · Intro/Verse/Chorus/Outro)</div>
      <div class="track track-phrases">${phrasesHtml}</div>

      <!-- 推荐切点 -->
      <div class="lane-label"><b>重拍切点</b> (★强拍位重拍 · ◆次强拍位重拍 ◇段落边界)</div>
      <div class="track track-cuts" id="cuts-track">
        <div class="cut-tooltip" id="cut-tooltip" style="display:none;"></div>
        ${cutPointsHtml}
      </div>

      <!-- 节拍分层 -->
      <div class="lane-label"><b>节拍分层</b> (蓝=强拍 · 黄=次强拍 · 灰=fill)</div>
      <div class="track track-beats">${fillsHtml}${mediumsHtml}${downbeatsHtml}</div>

      <div class="playhead" id="playhead" style="left:0px"></div>
      <div class="ruler">${rulerHtml}</div>
    </div>
  </div>
</div>

<script>
(function() {
  const audio = document.getElementById('audio');
  const scroll = document.getElementById('tl-scroll');
  const inner = document.getElementById('tl-inner');
  const playhead = document.getElementById('playhead');
  const autoScroll = document.getElementById('auto-scroll');
  const PX = ${PX_PER_SEC};
  const DUR = ${durS};
  const INNER_W = ${innerW};

  // 点击时间轴任何位置 → 跳转 + 播放
  if (inner) {
    inner.addEventListener('click', e => {
      // 如果点击的是段落块或曲线SVG，由各自的处理器处理
      if (e.target.closest('.phrase')) return;
      if (e.target.closest('svg')) return;
      const rect = inner.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const t = Math.max(0, Math.min(DUR, x / PX));
      userScrollUntil = Date.now() + 2000; // 点击后2秒内不自动滚动
      if (playhead) playhead.style.left = (t * PX) + 'px'; // 立即更新playhead
      if (audio) { audio.currentTime = t; audio.play(); }
    });
  }

  // 播放更新 → 移动 playhead, 可选自动滚动跟随
  let userScrollUntil = 0;
  if (scroll) {
    scroll.addEventListener('wheel', () => { userScrollUntil = Date.now() + 1500; }, { passive: true });
    scroll.addEventListener('mousedown', () => { userScrollUntil = Date.now() + 1500; });
  }

  if (audio && playhead) {
    const beatElements = document.querySelectorAll('.bm-d, .bm-m');
    const HIGHLIGHT_TOLERANCE = 0.15;

    audio.addEventListener('timeupdate', () => {
      const x = audio.currentTime * PX;
      playhead.style.left = x + 'px';
      if (autoScroll && autoScroll.checked && Date.now() > userScrollUntil) {
        const target = x - scroll.clientWidth / 2;
        const max = INNER_W - scroll.clientWidth;
        scroll.scrollLeft = Math.max(0, Math.min(max, target));
      }

      beatElements.forEach(el => {
        const beatTime = parseFloat(el.dataset.time);
        if (isNaN(beatTime)) return;
        const diff = Math.abs(audio.currentTime - beatTime);
        if (diff < HIGHLIGHT_TOLERANCE) {
          el.classList.add('active');
        } else {
          el.classList.remove('active');
        }
      });
    });
    audio.addEventListener('seeked', () => {
      beatElements.forEach(el => {
        const beatTime = parseFloat(el.dataset.time);
        if (isNaN(beatTime)) return;
        const diff = Math.abs(audio.currentTime - beatTime);
        if (diff < HIGHLIGHT_TOLERANCE) {
          el.classList.add('active');
        } else {
          el.classList.remove('active');
        }
      });
    });
  }

  // === LUFS 曲线点击跳转交互 ===
  (function() {
    const svg = document.getElementById('lufs-svg');
    const tooltip = document.getElementById('lufs-tooltip');
    const data = ${JSON.stringify(lufsClickData)};
    if (!svg || !tooltip || !data || !data.length) return;

    const fmtTime = t => {
      const m = Math.floor(t / 60);
      const s = (t % 60).toFixed(1);
      return m > 0 ? m + ':' + (s < 10 ? '0' : '') + s : s + 's';
    };

    svg.addEventListener('mousemove', e => {
      const rect = svg.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const t = Math.max(0, Math.min(DUR, x / PX));
      let best = 0, bestDist = Infinity;
      for (let i = 0; i < data.length; i++) {
        const dist = Math.abs(data[i].t - t);
        if (dist < bestDist) { bestDist = dist; best = i; }
      }
      const d = data[best];
      tooltip.innerHTML = '<div class="tt-time">' + fmtTime(d.t) + '</div>'
        + (d.phrase ? '<div class="tt-section">' + d.phrase + '</div>' : '')
        + '<div class="tt-value">' + d.lufs.toFixed(1) + ' LUFS</div>';
      // 跟随鼠标显示tooltip
      tooltip.style.left = (e.clientX + 15) + 'px';
      tooltip.style.top = (e.clientY + 10) + 'px';
      tooltip.style.display = 'block';
    });
    svg.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
    svg.addEventListener('click', e => {
      e.stopPropagation();
      const rect = svg.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const t = Math.max(0, Math.min(DUR, x / PX));
      userScrollUntil = Date.now() + 2000; // 点击后2秒内不自动滚动
      if (playhead) playhead.style.left = (t * PX) + 'px'; // 立即更新playhead
      if (audio) { audio.currentTime = t; audio.play(); }
    });
  })();

  // === Dyn Complexity 曲线点击跳转交互 ===
  (function() {
    const svg = document.getElementById('dc-svg');
    const tooltip = document.getElementById('dc-tooltip');
    const data = ${dcClickData};
    if (!svg || !tooltip || !data || !data.length) return;

    const fmtTime = t => {
      const m = Math.floor(t / 60);
      const s = (t % 60).toFixed(1);
      return m > 0 ? m + ':' + (s < 10 ? '0' : '') + s : s + 's';
    };

    const bandCN = b => b === 'fast_cut' ? ' · 快切' : '';

    svg.addEventListener('mousemove', e => {
      const rect = svg.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const t = Math.max(0, Math.min(DUR, x / PX));
      let best = 0, bestDist = Infinity;
      for (let i = 0; i < data.length; i++) {
        const dist = Math.abs(data[i].t - t);
        if (dist < bestDist) { bestDist = dist; best = i; }
      }
      const d = data[best];
      tooltip.innerHTML = '<div class="tt-time">' + fmtTime(d.t) + '</div>'
        + (d.phrase ? '<div class="tt-section">' + d.phrase + '</div>' : '')
        + '<div class="tt-value">' + d.dc.toFixed(2) + ' DC' + bandCN(d.band) + '</div>';
      // 跟随鼠标显示tooltip
      tooltip.style.left = (e.clientX + 15) + 'px';
      tooltip.style.top = (e.clientY + 10) + 'px';
      tooltip.style.display = 'block';
    });
    svg.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
    svg.addEventListener('click', e => {
      e.stopPropagation();
      const rect = svg.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const t = Math.max(0, Math.min(DUR, x / PX));
      userScrollUntil = Date.now() + 2000;
      if (playhead) playhead.style.left = (t * PX) + 'px';
      if (audio) { audio.currentTime = t; audio.play(); }
    });
  })();

  // === BPM 曲线悬停交互 ===
  (function() {
    const svg = document.getElementById('bpm-svg');
    const tooltip = document.getElementById('bpm-tooltip');
    if (!svg || !tooltip) return;
    const dotsData = ${bpmDotData};
    if (!dotsData || !dotsData.length) return;
    const fmtTime = t => {
      const m = Math.floor(t / 60);
      const s = (t % 60).toFixed(1);
      return m > 0 ? m + ':' + (s < 10 ? '0' : '') + s : s + 's';
    };
    svg.addEventListener('mousemove', e => {
      const rect = svg.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const t = Math.max(0, Math.min(DUR, x / PX));
      let best = 0, bestDist = Infinity;
      for (let i = 0; i < dotsData.length; i++) {
        const dist = Math.abs(dotsData[i].t - t);
        if (dist < bestDist) { bestDist = dist; best = i; }
      }
      const d = dotsData[best];
      tooltip.innerHTML = '<div class="tt-time">' + fmtTime(d.t) + '</div>'
        + '<div class="tt-bpm">' + d.bpm.toFixed(1) + ' BPM</div>'
        + '<div class="tt-sec">' + (d.sec ? d.sec : '') + '</div>';
      // 跟随鼠标显示tooltip
      tooltip.style.left = (e.clientX + 15) + 'px';
      tooltip.style.top = (e.clientY + 10) + 'px';
      tooltip.style.display = 'block';
    });
    svg.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
    svg.addEventListener('click', e => {
      e.stopPropagation();
      const rect = svg.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const t = Math.max(0, Math.min(DUR, x / PX));
      userScrollUntil = Date.now() + 2000;
      if (playhead) playhead.style.left = (t * PX) + 'px';
      if (audio) { audio.currentTime = t; audio.play(); }
    });
  })();

  // === 段落点击跳转交互 ===
  (function() {
    const phrases = document.querySelectorAll('.phrase');
    if (!phrases.length || !audio) return;

    phrases.forEach(el => {
      el.addEventListener('click', e => {
        e.stopPropagation();
        const start = parseFloat(el.dataset.start);
        if (!isNaN(start) && audio) {
          audio.currentTime = start;
          audio.play();
        }
      });
    });

    // 播放时高亮当前段落
    const updatePhraseHighlight = () => {
      const t = audio.currentTime;
      phrases.forEach(el => {
        const start = parseFloat(el.dataset.start);
        const end = parseFloat(el.dataset.end);
        if (t >= start && t < end) {
          el.classList.add('active');
        } else {
          el.classList.remove('active');
        }
      });
    };

    audio.addEventListener('timeupdate', updatePhraseHighlight);
    audio.addEventListener('seeked', updatePhraseHighlight);
  })();

  // === 切点交互 ===
  (function() {
    const cutsTrack = document.getElementById('cuts-track');
    const tooltip = document.getElementById('cut-tooltip');
    const data = ${cutPointsData};
    if (!cutsTrack || !tooltip || !data || !data.length) return;

    const fmtTime = t => {
      const m = Math.floor(t / 60);
      const s = (t % 60).toFixed(1);
      return m > 0 ? m + ':' + (s < 10 ? '0' : '') + s : s + 's';
    };

    const typeName = {
      accent: '重拍',
      beat: '重拍',
      phrase: '段落边界',
      combo: '强拍+高能',
      downbeat: '重拍',
      lufs: '高能峰值'
    };

    // 鼠标悬停显示 tooltip
    cutsTrack.addEventListener('mousemove', e => {
      const rect = cutsTrack.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const t = Math.max(0, Math.min(DUR, x / PX));
      // 找最近的切点
      let best = null, bestDist = Infinity;
      data.forEach(cp => {
        const dist = Math.abs(cp.t - t);
        if (dist < bestDist) { bestDist = dist; best = cp; }
      });
      if (best && bestDist < 0.5) { // 0.5秒内才显示
        tooltip.innerHTML = '<div class="ct-time">' + fmtTime(best.t) + '</div>'
          + '<div class="ct-type ' + best.type + '">' + typeName[best.type] + '</div>'
          + '<div class="ct-lufs">LUFS: ' + best.lufs.toFixed(1) + ' dB</div>'
          + (best.phrase ? '<div class="ct-lufs">段落: ' + best.phrase + '</div>' : '');
        tooltip.style.left = (e.clientX + 15) + 'px';
        tooltip.style.top = (e.clientY + 10) + 'px';
        tooltip.style.display = 'block';
      } else {
        tooltip.style.display = 'none';
      }
    });
    cutsTrack.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });

    // 点击切点跳转
    cutsTrack.addEventListener('click', e => {
      const cutEl = e.target.closest('.cut-point');
      if (!cutEl) return;
      e.stopPropagation();
      const t = parseFloat(cutEl.dataset.time);
      if (!isNaN(t) && audio) {
        userScrollUntil = Date.now() + 2000;
        if (playhead) playhead.style.left = (t * PX) + 'px';
        audio.currentTime = t;
        audio.play();
      }
    });

    // 播放时高亮最近的切点
    if (audio) {
      const cutElements = document.querySelectorAll('.cut-point');
      audio.addEventListener('timeupdate', () => {
        const t = audio.currentTime;
        cutElements.forEach(el => {
          const ct = parseFloat(el.dataset.time);
          if (Math.abs(t - ct) < 0.15) {
            el.classList.add('active');
          } else {
            el.classList.remove('active');
          }
        });
      });
    }
  })();
})();
</script>
</body></html>`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--dir') {
    const dir = args[1];
    if (!dir) { console.error('Usage: --dir <dir>'); process.exit(1); }
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.analysis.json'));
    for (const f of files) {
      const base = f.replace(/\.analysis\.json$/, '');
      const jsonPath = path.join(dir, f);
      const htmlPath = path.join(dir, base + '.report.html');
      // 找同名音频 (在 analysis json 的上级目录的常见命名规则里找)
      const a = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      // 尝试几个可能路径
      const audioCandidates = [
        path.join(dir, '..', '..', '02_输入样本_mp3', base + '.mp3'),
        path.join(dir, '..', '02_输入样本_mp3', base + '.mp3'),
        path.join(dir, '..', '音乐节拍验证', base + '.mp3'),
        path.join(path.dirname(dir), '音乐节拍验证', base + '.mp3'),
        path.join('C:/Users/atmob/Desktop/音乐节拍验证', base + '.mp3'),
      ];
      let audioUri = null;
      for (const c of audioCandidates) {
        if (fs.existsSync(c)) { audioUri = fileToBase64(c); break; }
      }
      const html = buildHtml(a, audioUri);
      fs.writeFileSync(htmlPath, html);
      console.log(`✓ ${htmlPath} (audio: ${audioUri ? 'embedded' : 'none'})`);
    }
    return;
  }

  const jsonPath = args[0];
  const audioPath = args[1];
  const outPath = args[2] || jsonPath.replace(/\.analysis\.json$/, '.report.html');
  if (!jsonPath) { console.error('Usage: gen_report.cjs <analysis.json> [audio] [out.html]'); process.exit(1); }
  const a = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const audioUri = audioPath ? fileToBase64(audioPath) : null;
  fs.writeFileSync(outPath, buildHtml(a, audioUri));
  console.log(`✓ ${outPath}`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });