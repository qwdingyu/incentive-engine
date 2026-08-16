/**
 * 内存规则集服务 — 模拟宿主项目的 ruleSetService.getActiveRuleSet
 *
 * 真实项目中替换为查询 incentive_rule_sets 表并返回 config_json 的服务。
 *
 * @param {Object} ruleSets - 规则集表：{ [code]: config_json }
 * @returns {Object} 具有 getActiveRuleSet(code) 的服务对象
 */
function createMemoryRuleSetService(ruleSets = {}) {
  return {
    async getActiveRuleSet(code) {
      if (!ruleSets[code]) {
        return { success: false, message: `规则集不存在: ${code}` };
      }
      return { success: true, data: { config_json: ruleSets[code] } };
    },
  };
}

module.exports = { createMemoryRuleSetService };
