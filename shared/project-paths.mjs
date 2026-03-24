/**
 * 项目路径管理
 */
import path from 'path';
import fs from 'fs';

export function projectPaths(root) {
  if (!root || typeof root !== 'string') throw new Error('projectPath 不能为空');
  return {
    root,
    script:        path.join(root, '01_script'),
    original:      path.join(root, '01_script', 'original.txt'),
    corrected:     path.join(root, '01_script', 'corrected.txt'),
    planning:      path.join(root, '02_planning'),
    analysis:      path.join(root, '02_planning', 'analysis.json'),
    chapters:      path.join(root, '02_planning', 'chapters.json'),
    shotPlans:     path.join(root, '02_planning', 'shot_plans.json'),
    prompts:       path.join(root, '03_prompts'),
    shots:         path.join(root, '03_prompts', 'shots.json'),
    assets:        path.join(root, '04_assets'),
    charImages:    path.join(root, '04_assets', 'characters_images.json'),
    sceneImages:   path.join(root, '04_assets', 'scenes_images.json'),
    propsImages:   path.join(root, '04_assets', 'props_images.json'),
    generation:    path.join(root, '05_generation'),
    shotVideos:    path.join(root, '05_generation', 'shot_videos.json'),
    config:        path.join(root, 'project_config.json'),
  };
}

/** 确保项目目录结构存在 */
export function ensureProjectDirs(root) {
  const p = projectPaths(root);
  const dirs = [p.script, p.planning, p.prompts, p.assets, p.generation];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
  return p;
}
