/**
 * 规则集适配器 — 把规则集配置组装为引擎流水线阶段
 *
 * 职责：将 incentive_rule_sets.config_json（引擎通用原语）与运行时输入
 * （事件/直接上级/祖先链）组装成 engine.Orchestrate.executePipeline 的 stages。
 * 供规则集 preview 与任意客户服务（如电商示范）共用，避免重复组装逻辑。
 *
 * v1.1.0 新增 RANK 阶段装配：把规则集 rankDefs 注入 RANK stage，
 * 默认对直接上级与祖先链就地评估等级并写入 rankRate（供随后 DISTRIBUTE 消费）。
 *
 * @version 1.1.0
 */

/**
 * 从规则集配置组装流水线阶段
 *
 * @param {Object} config - 规则集 config_json
 *   { rewardDefs, capDefs, pipelineDef? }
 * @param {Object} input - 运行时输入
 *   { event, directParent?, ancestors? }
 * @returns {Array<Object>} executePipeline stages
 */
function buildPipelineStages(config, { event, directParent = null, ancestors = [] }) {
  const rewardDefs = config.rewardDefs || [];
  const capDefs = config.capDefs || [];

  // 优先使用规则集声明的 pipelineDef，缺省为 DISTRIBUTE → CAP。
  const declaredStages = config.pipelineDef?.stages || [
    { handler: "DISTRIBUTE" },
    { handler: "CAP" },
  ];

  return declaredStages.map((stage) => {
    if (stage.handler === "DISTRIBUTE") {
      return {
        id: stage.id || "distribute",
        handler: "DISTRIBUTE",
        config: { event, directParent, ancestors, rewardDefs },
      };
    }
    if (stage.handler === "RANK") {
      // RANK（等级评估）：把规则集 rankDefs 注入 RANK stage，并默认对
      // 直接上级 + 祖先链就地评估等级并写入 rankRate（供随后 DISTRIBUTE 消费）。
      // 可用 stage.config.nodes 显式覆盖待评节点；overwrite=true 才覆盖宿主
      // 已预计算的 rankRate（默认不覆盖，保持向后兼容）。
      const declaredNodes = stage.config?.nodes;
      const nodes = Array.isArray(declaredNodes) && declaredNodes.length > 0
        ? declaredNodes.slice()
        : [directParent, ...(ancestors || [])];
      // 去空、按 id 去重（同一节点在 directParent 与 ancestors 中可能重复出现）。
      const seen = new Set();
      const uniqueNodes = nodes.filter((n) => {
        if (!n || typeof n !== "object" || n.id === undefined || n.id === null) return false;
        if (seen.has(n.id)) return false;
        seen.add(n.id);
        return true;
      });
      return {
        id: stage.id || "rank",
        handler: "RANK",
        config: {
          rankDefs: config.rankDefs || [],
          nodes: uniqueNodes,
          overwrite: stage.config?.overwrite === true,
        },
      };
    }
    if (stage.handler === "CAP") {
      return { id: stage.id || "cap", handler: "CAP", config: { capDefs } };
    }
    if (stage.handler === "OVER") {
      // OVER（预算兜底保护）：注入动态 eventValue，规则集配置只需声明
      // totalBudget（百分比整数）和 onExceed（CAP/WARN/REJECT）。
      // eventValue 从引擎事件动态获取，避免硬编码在规则集配置中。
      return {
        id: stage.id || "over",
        handler: "OVER",
        config: {
          totalBudget: stage.config?.totalBudget || "100",
          eventValue: event?.eventValue || "0",
          onExceed: stage.config?.onExceed || "CAP",
        },
      };
    }
    // SPLIT（拆分）：由 Orchestrate 的 executePipeline 在 stage 级处理，
    // 适配器只需透传，不做额外装配。如需向 SPLIT stage 注入 config，
    // 可在 pipelineDef 中声明，适配器将原样传递。
    if (stage.handler === "SPLIT") {
      return { id: stage.id || "split", handler: "SPLIT", config: stage.config || {} };
    }
    return stage;
  });
}

module.exports = { buildPipelineStages };
