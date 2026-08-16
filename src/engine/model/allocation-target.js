/**
 * 分配目标 — 通用领域模型（纯数据容器，无方法，无外部依赖）
 *
 * 描述"分到哪"：一笔奖励金额按比例拆到多个科目目标。
 * 目标名由上层定义（locked_rongbei / mall_balance / LIQUID / POINT / cash），
 * 引擎只做"按 targets 比例拆分"，不解释目标含义。
 *
 * 对应《03_通用营销激励引擎架构设计.md》§4.4 AllocationDef.ratios 的最小实现。
 *
 * @version 1.0.0
 */
class AllocationTarget {
  /**
   * @param {Object} params
   * @param {string} params.target - 目标科目标识（上层解释）
   * @param {string|number} params.ratio - 比例（百分比整数，70=70%）
   */
  constructor({ target, ratio }) {
    this.target = target;
    this.ratio = String(ratio);
  }
}

module.exports = { AllocationTarget };
