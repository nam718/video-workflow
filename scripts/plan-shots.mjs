/**
 * 步骤3：分镜规划
 * 输入：chapters.json + analysis.json
 * 输出：shot_plans.json
 */
import { callAI } from '../shared/call-ai.mjs';
import { DEFAULT_PROMPTS, renderTemplate } from '../shared/prompt-defaults.mjs';
import { getPromptTemplates } from '../shared/call-ai.mjs';

function getPrompt(key) {
  const custom = getPromptTemplates();
  const def = DEFAULT_PROMPTS[key];
  return {
    system: (custom[key] && custom[key].system) || def.system,
    user: (custom[key] && custom[key].user) || def.user,
  };
}

/** 对单个章节生成分镜 */
async function planChapterShots(chapter, analysis, shotDuration = 5) {
  const charList = (analysis.characters || []).map(c => c.name).join('、');
  const p = getPrompt('planShots');

  const prompt = renderTemplate(p.user, {
    shotDuration,
    scene: chapter.scene,
    timeOfDay: chapter.timeOfDay || '白天',
    characters: charList,
    content: chapter.content,
  });

  return await callAI(prompt, {
    systemPrompt: p.system,
    maxTokens: 16384,
  });
}

/** 为所有章节生成分镜 */
export async function planShots(chapters, analysis, shotDuration = 5) {
  const allShots = [];
  let globalShotNum = 1;

  for (const chapter of chapters) {
    const result = await planChapterShots(chapter, analysis, shotDuration);
    const shots = result.shots || [];
    for (const shot of shots) {
      shot.shotNumber = globalShotNum++;
      shot.chapter = chapter.chapterNumber;
      shot.scene = chapter.scene;
      shot.timeOfDay = chapter.timeOfDay;
      allShots.push(shot);
    }
  }

  return allShots;
}
