/**
 * 引擎节点 — 通用领域模型（纯数据容器，无方法，无外部依赖）
 *
 * 引擎不假设任何业务实体，只操作抽象节点：
 * - id：全局唯一标识（任意客户场景下的成员/用户/渠道）
 * - parentId：推荐链/血缘链父节点 ID（单亲树，双轨等特殊结构由上层适配）
 * - rankId：当前等级/身份标识（如 "V5" / "MEMBER" / "ACTIVE"）
 * - attrs：扩展属性 KV（引擎不解释，条件评估与奖励定义从 attrs 读取字段）
 * - tags：标签集合（引擎不解释，预留条件匹配）
 *
 * 抽象网络节点的最小实现：引擎只认 id / parentId / 等级 / 扩展属性，不认业务实体。
 *
 * @version 1.0.0
 */
class EngineNode {
  /**
   * @param {Object} params
   * @param {string|number} params.id - 节点全局唯一标识
   * @param {string|number|null} params.parentId - 父节点 ID（无则 null）
   * @param {string} params.rankId - 当前等级标识
   * @param {Object} params.attrs - 扩展属性（条件评估字段的数据源，如 directCount/teamPerformance）
   * @param {Set|Array} [params.tags] - 标签集合（预留）
   */
  constructor({ id, parentId = null, rankId = "DEFAULT", attrs = {}, tags = [] }) {
    this.id = id;
    this.parentId = parentId;
    this.rankId = rankId;
    this.attrs = attrs;
    this.tags = tags instanceof Set ? tags : new Set(tags);
  }
}

module.exports = { EngineNode };
