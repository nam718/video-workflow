/**
 * 快速测试图表渲染
 * node hongguo/_test_chart.mjs
 */
import { renderCharts, analyzeAllTags, buildChartNarrations } from './chart-renderer.mjs';
import fs from 'fs';
import path from 'path';

const SCRIPT_DIR = import.meta.dirname;
const dataFile = path.join(SCRIPT_DIR, 'data/douyin_ai_ranking_2026-03-19.json');
const data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
const tmpDir = path.join(SCRIPT_DIR, '.tmp_ai_video');
fs.mkdirSync(tmpDir, { recursive: true });

console.log('数据条数:', data.length);

// 1. 测试分析
const analysis = analyzeAllTags(data);
console.log('\n活跃标签:');
analysis.tags.forEach(t => console.log(` ${t.name}: ${t.count}部, 均热度${(t.avgHeat/10000).toFixed(0)}万`));

// 2. 测试解说文案
const narr = buildChartNarrations(analysis);
console.log('\nK线解说:', narr.klineText);
console.log('\n红海蓝海解说:', narr.oceanText);

// 3. 测试图表渲染
console.log('\n=== 开始渲染图表 ===');
const results = await renderCharts(data, tmpDir, '2026-03-19');
console.log('\n=== 渲染结果 ===');
if (!results.length) {
  console.log('❌ 无图表生成');
} else {
  results.forEach(r => {
    const size = fs.statSync(r.videoPath).size;
    console.log(`✅ ${r.type}: ${r.videoPath} (${(size/1024).toFixed(0)} KB)`);
  });
}
