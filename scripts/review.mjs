/**
 * 步骤1：剧本审查
 * 输入：原始剧本文本
 * 输出：修正后的剧本
 */
import { callAIPlain } from '../shared/call-ai.mjs';

export async function reviewScript(scriptText) {
  const prompt = `你是一个专业的剧本审查编辑。请审查以下剧本，修正错别字、语法错误、标点符号问题，并理顺不通顺的表达。

要求：
- 保持原文风格和意思不变
- 只修正明显的错误
- 直接输出修正后的完整剧本，不要添加任何说明

剧本原文：
${scriptText}`;

  return await callAIPlain(prompt, {
    systemPrompt: '你是一个专业的剧本审查编辑，擅长纠错和润色。直接输出修正结果。',
    maxTokens: 8192,
  });
}
