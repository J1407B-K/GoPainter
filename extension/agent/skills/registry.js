// Skill 仅提供任务编排说明；不能授予工具权限。
(() => {
  const skills = new Map();
  function register(skill) {
    if (!skill?.id || !Array.isArray(skill.tools)) throw new Error('无效 Agent skill 声明');
    if (skills.has(skill.id)) throw new Error(`重复注册 Agent skill：${skill.id}`);
    skills.set(skill.id, Object.freeze(skill));
  }
  globalThis.GoPainterAgentSkills = Object.freeze({ register, get: (id) => skills.get(id) || null });
})();
