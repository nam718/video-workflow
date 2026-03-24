/**
 * 步骤2：提取角色/场景/道具 + 拆分章节
 * 输入：修正后的剧本
 * 输出：analysis.json + chapters.json
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

/** 提取角色、场景、道具 */
export async function analyzeScript(scriptText) {
  const p = getPrompt('analyze');
  const prompt = renderTemplate(p.user, { script: scriptText });

  return await callAI(prompt, {
    systemPrompt: p.system,
    maxTokens: 8192,
  });
}

/** 拆分章节 */
export async function splitChapters(scriptText) {
  const p = getPrompt('splitChapters');
  const prompt = renderTemplate(p.user, { script: scriptText });

  return await callAI(prompt, {
    systemPrompt: p.system,
    maxTokens: 8192,
  });
}
