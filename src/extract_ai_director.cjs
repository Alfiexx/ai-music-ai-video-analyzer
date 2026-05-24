/**
 * 从AI导演工作流导出的JSON中提取三个板块的数据:
 * 1. 创意与上下文 (creative)
 * 2. 场次规划 (sceneBlocks)
 * 3. 分镜设计 (shots - 嵌套在sceneBlocks中)
 */

const fs = require('fs');
const path = require('path');

// 读取输入文件
const inputPath = process.argv[2] || 'c:\\Users\\Alfie\\Downloads\\war.json';
const outputDir = process.argv[3] || path.join(__dirname, '新产出', 'json');

// 确保输出目录存在
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

console.log('读取文件:', inputPath);
const rawData = fs.readFileSync(inputPath, 'utf-8');
const data = JSON.parse(rawData);

// 提取三个板块的数据
const document = data.state?.document || {};

// 1. 创意与上下文
const creative = document.creative || {};

// 2. 场次规划 (包含分镜设计)
const sceneBlocks = document.sceneBlocks || {};

// 分析数据结构
const result = {
  version: data.version,
  type: data.type,
  extractedAt: new Date().toISOString(),
  source: path.basename(inputPath),
  stages: {
    // 阶段2: 创意与上下文
    creative: {
      summary: creative.summary,
      outline: creative.outline
    },
    // 阶段4: 场次规划 (包含分镜设计)
    sceneBlocks: {
      items: sceneBlocks.items || []
    }
  }
};

// 统计信息
const sceneCount = sceneBlocks.items?.length || 0;
let shotCount = 0;
sceneBlocks.items?.forEach(block => {
  shotCount += block.shots?.length || 0;
});

console.log('\n=== 数据分析结果 ===');
console.log('场次数量:', sceneCount);
console.log('分镜数量:', shotCount);

// 创意与上下文分析
if (creative.outline) {
  console.log('\n--- 创意与上下文 ---');
  if (creative.outline.project_overview) {
    console.log('项目概述:', creative.outline.project_overview.substring(0, 100) + '...');
  }
  if (creative.outline.artist_design) {
    console.log('角色设计数量:', creative.outline.artist_design.length);
  }
}

// 场次规划分析
if (sceneBlocks.items) {
  console.log('\n--- 场次规划 ---');
  sceneBlocks.items.forEach((block, index) => {
    const shotCnt = block.shots?.length || 0;
    console.log(`场次${index + 1}: ${block.name} (${block.start}-${block.end}s, ${shotCnt}个分镜)`);
  });
}

// 输出文件路径
const outputFileName = path.basename(inputPath, '.json') + '_extracted.json';
const outputPath = path.join(outputDir, outputFileName);

// 写入文件
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
console.log('\n输出文件:', outputPath);

// 同时输出一个简化版本，只包含关键字段
const simplifiedResult = {
  version: data.version,
  extractedAt: new Date().toISOString(),
  source: path.basename(inputPath),

  // 创意与上下文
  creative: {
    summary: creative.summary,
    outline: {
      project_overview: creative.outline?.project_overview,
      creative_concept_structure: creative.outline?.creative_concept_structure,
      artist_design: creative.outline?.artist_design
    }
  },

  // 场次规划 (简化版，只保留关键信息)
  sceneBlocks: {
    items: sceneBlocks.items?.map(block => ({
      scene_block_id: block.scene_block_id,
      name: block.name,
      start: block.start,
      end: block.end,
      environment_info: block.environment_info,
      overall_style: block.overall_style,
      story_purpose: block.story_purpose,
      paragraph_content: block.paragraph_content,
      lyrics_allocation: block.lyrics_allocation,
      editing_density: block.editing_density,
      rhythm_description: block.rhythm_description,
      reference_ids: block.reference_ids,
      phrase_refs: block.phrase_refs,
      // 分镜设计
      shots: block.shots?.map(shot => ({
        index: shot.index,
        start: shot.start,
        end: shot.end,
        label: shot.label,
        start_frame: shot.start_frame,
        action_camera: shot.action_camera,
        end_frame: shot.end_frame,
        lyrics_ref: shot.lyrics_ref,
        reference_ids: shot.reference_ids,
        cut_point_reason: shot.cut_point_reason,
        scene_block_id: shot.scene_block_id,
        shot_id: shot.shot_id,
        target_duration: shot.target_duration,
        title: shot.title,
        summary: shot.summary
      }))
    }))
  }
};

const simplifiedOutputPath = path.join(outputDir, path.basename(inputPath, '.json') + '_simplified.json');
fs.writeFileSync(simplifiedOutputPath, JSON.stringify(simplifiedResult, null, 2), 'utf-8');
console.log('简化版输出:', simplifiedOutputPath);