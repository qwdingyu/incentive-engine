/**
 * 等级评估器 — 纯计算，无外部依赖
 *
 * v2.2.0 重构：条件评估逻辑委托给 condition-evaluator 独立模块，
 * 本模块保留等级评估编排逻辑（遍历等级、确定最高等级）。
 *
 * v2.0.0 泛化：evaluateTier 支持两种评估模式：
 * 1) 通用条件模式（tier.conditions 非空时优先）：遍历 COMPARE 条件列表
 *    [{ field, operator, value, subKey? }]，任意客户通过配置声明等级晋升条件。
 * 2) 遗留字段模式（兼容，tier.conditions 为空时回退）：读 metadata 的
 *    minDirectCount / minTeamPerformance / minHigherTierCount / requiredHigherTier。
 *
 * 高级别下属检查支持 per-tier 差异化：node.higherTierCounts 是一个映射，
 * key 为 requiredHigherTier 等级号，value 为对应人数（通用条件 subKey 表达同一语义）。
 *
 * 重要口径（v1.2.0 修复）：getHighestQualifiedTier 必须扫描全部等级、保留最后一个满足者，
 * 不能在首个不满足等级处提前 break —— 真实等级配置可能"非单调"：
 * 例如默认 vip_tiers 中 V4 要求团队业绩 >= 1000 万，而 V5-V9 不要求团队业绩（只依赖
 * 直推数与高级别下属数）。若在 V4 不满足时 break，会把本应晋升 V5 的会员误判为 V3，
 * 直接导致团队极差比例 30% -> 15% 的资金损失。抽取前 vip.service 的原实现就是扫描全部等级。
 *
 * @version 2.3.0
 */

const Decimal = require("../../decimal");
const { evaluateCondition } = require("./condition-evaluator");

/**
 * 从 RankDef 或类似对象中提取数值条件（遗留字段模式）
 * @private
 */
function _getMinDirectCount(tier) {
  if (tier.metadata) return tier.metadata.minDirectCount ?? 0;
  return tier.min_direct_count ?? 0;
}
function _getMinTeamPerformance(tier) {
  if (tier.metadata) return tier.metadata.minTeamPerformance ?? "0";
  return tier.min_team_performance ?? "0";
}
function _getMinHigherTierCount(tier) {
  if (tier.metadata) return tier.metadata.minHigherTierCount ?? 0;
  return tier.min_higher_tier_count ?? 0;
}
// 注意：required_higher_tier 必须原样返回，区分 null（显式"不需要高级别下属"）与 undefined（字段缺失/原始对象兼容模式）。
function _getRequiredHigherTier(tier) {
  if (tier.metadata) return tier.metadata.requiredHigherTier;
  return tier.required_higher_tier;
}
function _getLevelIndex(tier) {
  // RankDef 实例（含 metadata）→ tier.levelIndex
  // 普通对象（无 metadata）→ tier.levelIndex ?? tier.tier_level ?? 0
  if (tier.metadata) return tier.levelIndex;
  return tier.levelIndex ?? tier.tier_level ?? 0;
}
// 等级关联的分成比例（百分比整数）。读取顺序：metadata.rankRate → 顶层 rankRate → 遗留 rank_rate → "0"。
// 注意：RANK 阶段写入 node.rankRate 用 tier.rankRate（顶层字段），
// 因此 fail-closed 判定必须与之一致地读 rankRate（含 metadata 回退）。
function _getRankRate(tier) {
  if (tier.metadata && tier.metadata.rankRate !== undefined) return String(tier.metadata.rankRate);
  if (tier.rankRate !== undefined) return String(tier.rankRate);
  if (tier.rank_rate !== undefined) return String(tier.rank_rate);
  return "0";
}

/**
 * 判断单个节点是否满足某个等级的条件（纯计算）
 *
 * @param {Object} node - 节点 { directCount, teamPerformance, higherTierCounts?, higherTierCount?, attrs? }
 * @param {Object} tier - 等级定义（RankDef 实例或含 tier_level/min_direct_count 等字段的对象）
 * @returns {boolean} 是否满足条件
 */
function evaluateTier(node, tier) {
  const levelIndex = _getLevelIndex(tier);
  // V0 无条件门槛
  if (levelIndex === 0) return true;

  // ===== 通用条件模式（conditions 配置驱动，委托 condition-evaluator） =====
  const conditions = tier.conditions;
  if (Array.isArray(conditions) && conditions.length > 0) {
    // 兼容遗留格式：conditions 是纯 COMPARE 数组，包装为 AND 后统一评估
    const wrapper = conditions.length === 1 && conditions[0].type
      ? conditions[0] // 已是复合条件（AND/OR/NOT）
      : { type: "AND", children: conditions.map((c) =>
          c.type ? c : { type: "COMPARE", ...c }
        ) };
    // 等级评估的数据源就是被评估的节点本身：以 target 命名数据源传入，
    // 使 rankDefs 里显式写 source:"target" 的条件同样可用（语义一致）。
    // 等级评估没有事件上下文，因此 source:"event" 会在 condition-evaluator 抛错 ——
    // 这是配置错误（等级门槛不该依赖某一次事件），不应静默按节点求值。
    return evaluateCondition(wrapper, node, { target: node });
  }

  // ===== 遗留字段模式（兼容层：宿主等级表的 min_* 字段直接映射，未翻译为 conditions） =====
  // 有效直推数检查
  const minDirectCount = _getMinDirectCount(tier);
  // 团队业绩检查
  const minTeamPerformance = _getMinTeamPerformance(tier);
  // 高级别下属数检查（支持 per-tier 差异化）
  const minHigherTierCount = _getMinHigherTierCount(tier);
  const requiredHigherTier = _getRequiredHigherTier(tier);

  // 资金安全（P0-2 fail-closed）：levelIndex > 0 的等级若既无 conditions、
  // 也无任何遗留门槛来源（min_* 全为 0），且有关联分成比例（rankRate > 0），
  // 说明该等级「无晋升门槛 + 会发钱」—— 配置漏写 conditions 会让所有节点
  // 直接命中该等级、顶格分成比例（超发）。此时必须判定为「不满足」。
  //
  // 但若 rankRate 为 0 或未定义（无分成比例），等级命中本身不直接发钱，
  // 非单调等级设计（如 V3 无条件但 levelIndex 比 V2 高）是合法业务模式，
  // 不应被 fail-closed 破坏。此时放宽判定，允许通过。
  //
  // 注意：minHigherTierCount > 0 本身就是有效门槛（声明了「需要高级别下属」），
  // 不应因 requiredHigherTier === null 而否定它 —— requiredHigherTier 为 null 时
  // 只是「跳过该检查（视为满足）」，门槛声明仍然存在，等级仍是有条件的。
  const hasAnyLegacyGate =
    minDirectCount > 0 ||
    minTeamPerformance > 0 ||
    minHigherTierCount > 0;
  if (!hasAnyLegacyGate) {
    // 无门槛等级：仅当有关联分成比例（rankRate > 0）时 fail-closed，
    // 否则只是等级提升（不发钱），非单调设计是合法业务模式。
    const tierRankRate = _getRankRate(tier);
    if (tierRankRate && Decimal.gt(tierRankRate, "0")) {
      return false;
    }
  }

  if (minDirectCount > 0) {
    if ((node.directCount || 0) < minDirectCount) return false;
  }

  if (minTeamPerformance > 0) {
    if (!Decimal.gte(node.teamPerformance || "0", String(minTeamPerformance))) return false;
  }

  if (minHigherTierCount > 0) {
    // required_higher_tier 显式为 null（DB 明确 NULL）时，
    // 原实现跳过高级别下属检查（视为满足），不能降级到单值模式误判失败。
    if (requiredHigherTier !== null) {
      // 优先使用 node.higherTierCounts[requiredHigherTier]（per-tier 模式），
      // 字段缺失（原始对象兼容模式）时降级为 node.higherTierCount（单值模式）。
      let actualCount = 0;
      if (requiredHigherTier !== undefined) {
        actualCount = (node.higherTierCounts && node.higherTierCounts[requiredHigherTier]) || 0;
      } else {
        actualCount = node.higherTierCount || 0;
      }
      if (actualCount < minHigherTierCount) return false;
    }
  }

  return true;
}

/**
 * 获取节点可达的最高等级（纯计算）
 *
 * 与抽取前 vip.service.evaluateTier 行为等价：必须遍历全部等级，
 * 保留最后一个满足条件的等级（低等级先满足、高等级后覆盖）。
 * 不能用"首个不满足即 break"的短路优化，理由见文件头部 v1.2.0 说明：
 * 等级条件可能非单调（如 V5+ 不要求团队业绩），break 会导致资金级误判。
 *
 * @param {Object} node - 节点条件数据
 * @param {Array<Object>} tiers - 等级定义列表（按 levelIndex 升序）
 * @returns {Object|null} 最高满足条件的等级对象，无满足条件时返回 null
 */
function getHighestQualifiedTier(node, tiers = []) {
  let qualified = null;
  for (const tier of tiers) {
    if (evaluateTier(node, tier)) {
      qualified = tier;
    }
  }
  return qualified;
}

module.exports = { evaluateTier, getHighestQualifiedTier };
