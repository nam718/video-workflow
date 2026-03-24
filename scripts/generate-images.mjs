/**
 * 步骤5：生成参考图（角色/场景/道具）
 * 输入：analysis.json
 * 输出：characters_images.json, scenes_images.json, props_images.json
 */
import { callImageGeneration } from '../shared/call-ai.mjs';

function aspectRatioToSize(ip) {
  const ar = (ip && ip.aspectRatio) || '16:9';
  return ar === '9:16' ? '768x1344' : ar === '1:1' ? '1024x1024' : '1344x768';
}

/**
 * 为角色生成参考图
 * @param {Array} characters - analysis.json 中的角色列表
 * @param {Function} [onProgress] - 进度回调
 * @param {object} [imageParams] - { model: 'jimeng'|'gemini', aspectRatio: '16:9'|'9:16' }
 * @param {string} [visualStyle] - 用户指定的视觉风格（如"写实"、"3D动漫"等）
 * @returns {Promise<object>} { "角色名": "图片URL" }
 */
export async function generateCharacterImages(characters, onProgress, imageParams, visualStyle) {
  const result = {};
  const styleText = visualStyle ? `${visualStyle} style` : 'high quality';
  for (let i = 0; i < characters.length; i++) {
    const c = characters[i];
    if (onProgress) onProgress(i + 1, characters.length, c.name);
    const prompt = `Portrait of ${c.description || c.name}, full body, character design sheet, ${styleText}, detailed, white background`;
    try {
      const urls = await callImageGeneration(prompt, { size: aspectRatioToSize(imageParams) });
      result[c.name] = urls[0] || '';
    } catch (err) {
      console.error(`角色 ${c.name} 图片生成失败:`, err.message);
      result[c.name] = '';
    }
  }
  return result;
}

/**
 * 为场景生成参考图
 */
export async function generateSceneImages(scenes, onProgress, imageParams, visualStyle) {
  const result = {};
  const styleText = visualStyle ? `${visualStyle} style, ` : '';
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    if (onProgress) onProgress(i + 1, scenes.length, s.name);
    const prompt = `${styleText}${s.description || s.name}, cinematic, wide angle, establishing shot, high quality, detailed lighting, no people, no human figures, empty scene`;
    try {
      const urls = await callImageGeneration(prompt, { size: aspectRatioToSize(imageParams) });
      result[s.name] = urls[0] || '';
    } catch (err) {
      console.error(`场景 ${s.name} 图片生成失败:`, err.message);
      result[s.name] = '';
    }
  }
  return result;
}

/**
 * 为道具生成参考图
 */
export async function generatePropsImages(props, onProgress, imageParams, visualStyle) {
  const result = {};
  const styleText = visualStyle ? `${visualStyle} style, ` : '';
  for (let i = 0; i < props.length; i++) {
    const p = props[i];
    if (onProgress) onProgress(i + 1, props.length, p.name);
    const prompt = `${styleText}${p.description || p.name}, product photography, studio lighting, white background, detailed`;
    try {
      const urls = await callImageGeneration(prompt, { size: aspectRatioToSize(imageParams) });
      result[p.name] = urls[0] || '';
    } catch (err) {
      console.error(`道具 ${p.name} 图片生成失败:`, err.message);
      result[p.name] = '';
    }
  }
  return result;
}
