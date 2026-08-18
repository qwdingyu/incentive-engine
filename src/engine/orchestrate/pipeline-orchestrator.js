/**
 * 流水线编排器 — 通用纯编排，无外部依赖
 *
 * v2.2.0 新增 OVER handler：总预算兜底保护，参见 budget-controller.js applyBudgetGuard。
 *
 * v2.1.0 泛化：executePipeline 按 stages 配置顺序执行，共享 context（如封顶水位）。
 * 内置 handler（引擎领域无关）：
 * - RANK：按 rankDefs 评估节点等级，把最优等级的 rankRate 写入节点（grade→rankRate）
 * - DISTRIBUTE：按 rewardDefs 分发（distributeByDefs）
 * - CAP：按 capDefs 封顶裁剪（applyCaps），水位写回 context.capState
 * - SPLIT：按 targets 拆分（splitByTargets）
 * - OVER：总预算兜底保护（applyBudgetGuard），写回 context.overBudgetWarnings
 *
 * v2.3.0 新增 RANK handler：把等级评估纳入标准流水线。此前节点 rankRate 需
 * 宿主在调用前预计算；RANK 阶段就地评估 config.nodes 并写入 node.rankRate，
 * 随后的 DISTRIBUTE 即可消费（节点为对象引用，原地写立即可见）。
 *
 * 任意客户通过 stages 配置组合自己的流水线（对齐《03_通用营销激励引擎架构设计.md》§5.3
 * PipelineDef：阶段、依赖、共享状态）。
 * 松茸场景的订单收益流水线（含通用→松茸记录映射）见 src/adapters/songrong-reward-adapter.js，
 * 本模块不包含任何松茸业务。
 *
 * @version 2.3.0
 */

const { distributeByDefs } = require("../distribute");
const { getHighestQualifiedTier } = require("../evaluate");
const { applyCaps, applyBudgetGuard, splitByTargets } = require("../allocate");

/**
 * 执行多阶段流水线（通用纯编排）
 *
 * 阶段间数据传递：每个 stage 接收 prev（上一阶段输出），输出作为下一阶段输入；
 * 最终输出在 results.final。
 *
 * @param {Object} params
 * @param {Array<Object>} params.stages - 阶段定义
 *        { id?, handler: "DISTRIBUTE"|"CAP"|"SPLIT", config }
 *        - DISTRIBUTE config: { event, directParent?, ancestors?, rewardDefs }
 *        - CAP config:       { capDefs }
 *        - SPLIT config:     { targets }
 * @param {Object} [params.context] - 共享状态（如 { capState: { platformPaid, memberPaid } }）
 * @returns {Object} { results: {阶段id: 输出}, final: 最后阶段输出, context }
 */
function executePipeline({ stages = [], context = {} }) {
  const results = {};
  let current = null;
  // 共享封顶水位：跨阶段/跨调用保持（同一批次内后续记录不会超发）。
  if (!context.capState) {
    context.capState = { platformPaid: "0", memberPaid: new Map() };
  }

  for (const stage of stages) {
    const { id = stage.handler, handler, config = {} } = stage;

    if (handler === "DISTRIBUTE") {
      current = distributeByDefs({
        event: config.event,
        directParent: config.directParent ?? null,
        ancestors: config.ancestors ?? [],
        rewardDefs: config.rewardDefs ?? [],
      });
    } else if (handler === "RANK") {
      // RANK：等级评估阶段 —— 对 config.nodes 就地求最高等级，并把该等级的
      // rankRate 写入 node.rankRate（供随后 DISTRIBUTE 消费，节点为对象引用）。
      // 默认不覆盖宿主已预计算的 rankRate（config.overwrite=true 才覆盖）；
      // 未命中任何等级 → rankRate="0"（即最低等级，由 skipRankZero 等语义消费）。
      // 本阶段不产生分发记录，结果置空数组，避免被误当作已分发数据。
      const nodes = config.nodes || [];
      const overwrite = config.overwrite === true;
      // 等级列表按 levelIndex 升序，getHighestQualifiedTier 依赖顺序保留最高等级。
      const rankDefs = (config.rankDefs || []).slice().sort(
        (a, b) => (a.levelIndex ?? 0) - (b.levelIndex ?? 0)
      );
      for (const node of nodes) {
        if (!node || typeof node !== "object") continue;
        // 已有 rankRate 且不覆盖 → 跳过（宿主显式预计算优先）。
        if (!overwrite && node.rankRate !== undefined && node.rankRate !== null) continue;
        const tier = getHighestQualifiedTier(node, rankDefs);
        node.rankRate = String(tier?.rankRate ?? "0");
        if (tier?.rankId) node.rankId = tier.rankId;
      }
      current = [];
    } else if (handler === "CAP") {
      if (current === null) {
        throw new Error("CAP 阶段前无输入数据（DISTRIBUTE 必须在 CAP 之前）");
      }
      current = applyCaps(current, config.capDefs ?? [], context.capState);
    } else if (handler === "OVER") {
      if (current === null) {
        throw new Error("OVER 阶段前无输入数据（DISTRIBUTE 必须在 OVER 之前）");
      }
      // 总预算兜底保护：在 DISTRIBUTE 之后、CAP 之前插入，防止配错比例导致超发。
      current = applyBudgetGuard(current, {
        totalBudget: config.totalBudget,
        eventValue: config.eventValue,
        onExceed: config.onExceed || "CAP",
      }, context);
    } else if (handler === "SPLIT") {
      if (config.totalAmount === undefined || config.totalAmount === null) {
        throw new Error("SPLIT 阶段缺少 totalAmount（独立阶段，需显式传入待拆分金额）");
      }
      // SPLIT 输出 { splits, snapshot } 非记录数组，与后续阶段（CAP）不兼容，
      // 因此 SPLIT 必须是最后一个阶段。若后续还有阶段，提前报错而非静默崩溃。
      const stageIndex = stage.id || stage.handler || "?";
      const remainingStages = stages.slice(stages.indexOf(stage) + 1).filter((s) => s);
      if (remainingStages.length > 0) {
        throw new Error(
          `SPLIT 阶段 "${stageIndex}" 后还有 ${remainingStages.length} 个阶段（${remainingStages.map((s) => s.handler || s.id).join(", ")}），` +
          "SPLIT 必须是最后一个阶段，否则后续阶段会因输入格式不兼容而崩溃"
        );
      }
      current = splitByTargets(config.totalAmount, config.targets);
    } else {
      throw new Error(`未知流水线阶段 handler: "${handler}"（支持: DISTRIBUTE, RANK, CAP, OVER, SPLIT）`);
    }

    results[id] = current;
  }

  return { results, final: current, context };
}

module.exports = { executePipeline };
