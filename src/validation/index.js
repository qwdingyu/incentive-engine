/**
 * 激励规则集配置 — joi 校验规则定义（引擎契约）
 *
 * 职责：校验 config_json 的引擎通用原语结构（rewardDefs/rankDefs/capDefs/allocators/pipelineDef），
 * 防止上层写入非法配置导致引擎计算异常。
 *
 * ⚠️ 本模块是工厂函数，需要调用方传入 joi 实例：
 *   const Joi = require("joi");
 *   const { createRuleSetValidation } = require("@usethink/incentive-engine").Validation;
 *   const schemas = createRuleSetValidation(Joi);
 *   const { ruleSetConfigSchema } = schemas;
 * 这样可以避免 joi 跨包版本不一致导致的 "Cannot mix different versions" 错误。
 *
 * @version 3.2.0
 */

/**
 * 创建一组规则集校验 schema
 * @param {Object} Joi - joi 实例（由调用方传入，确保全局唯一）
 * @returns {Object} { ruleSetConfigSchema, engineEventPreviewSchema, ... }
 */
function createRuleSetValidation(Joi) {
  if (!Joi || !Joi.object) {
    throw new Error("createRuleSetValidation 需要有效的 joi 实例作为参数");
  }

  // ==================== 基础校验器 ====================

  const pctRateSchema = Joi.alternatives().try(
    Joi.number().min(0).max(1000).allow(null),
    Joi.string().custom((value, helpers) => {
      const num = Number(value);
      if (isNaN(num) || num < 0 || num > 1000) {
        return helpers.error("number.minMax", { min: 0, max: 1000, value });
      }
      return value;
    }).allow(null, "")
  );

  const nonNegativeSchema = Joi.alternatives().try(
    Joi.number().min(0),
    Joi.string().custom((value, helpers) => {
      const num = Number(value);
      if (isNaN(num) || num < 0) {
        return helpers.error("number.min", { min: 0, value });
      }
      return value;
    }).allow("")
  );

  // ==================== 子结构定义 ====================

  const rewardDefSchema = Joi.object({
    rewardId: Joi.string().max(64).required(),
    type: Joi.string().valid("DIRECT", "LEVEL", "FIXED", "CUSTOM").required(),
    rate: pctRateSchema,
    fixedAmount: nonNegativeSchema,
    target: Joi.string().valid("SOURCE", "PARENT").optional(),
    skipRankZero: Joi.boolean().optional(),
    accumulateInChain: Joi.boolean().optional(),
    allocatorId: Joi.string().max(64).allow(null).optional(),
    conditions: Joi.array().items(Joi.object()).optional(),
    metadata: Joi.object().optional(),
  }).custom(validateRewardFixedAmount, "FIXED 固定金额交叉校验");

  const conditionSchema = Joi.object({
    field: Joi.string().max(64).required(),
    operator: Joi.string().valid("GTE", "GT", "LTE", "LT", "EQ").required(),
    value: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
    subKey: Joi.alternatives().try(Joi.string(), Joi.number()).allow(null).optional(),
  });

  const rankDefSchema = Joi.object({
    rankId: Joi.string().max(64).required(),
    levelIndex: Joi.number().integer().min(0).required(),
    // 等级关联的分成比例（百分比整数）：RANK 阶段命中该等级时写入节点 rankRate。
    rankRate: pctRateSchema,
    conditions: Joi.array().items(conditionSchema).optional(),
    metadata: Joi.object().optional(),
  });

  const capDefSchema = Joi.object({
    capId: Joi.string().max(64).required(),
    scope: Joi.string().valid("PLATFORM_DAILY", "PER_USER_DAILY").required(),
    limit: nonNegativeSchema.required(),
    onExceed: Joi.string().valid("REJECT", "ALERT_ONLY").default("REJECT").optional(),
  });

  const allocatorSchema = Joi.object({
    allocatorId: Joi.string().max(64).required(),
    type: Joi.string().valid("PERCENTAGE_SPLIT").required(),
    targets: Joi.array().items(Joi.object({
      target: Joi.string().max(64).required(),
      ratio: nonNegativeSchema.required(),
    })).min(1).required(),
  });

  const pipelineStageConfigSchema = Joi.object({
    totalBudget: Joi.alternatives()
      .try(Joi.number().min(1).max(1000), Joi.string().custom((value, helpers) => {
        const num = Number(value);
        if (isNaN(num) || num < 1 || num > 1000) {
          return helpers.error("number.minMax", { min: 1, max: 1000, value });
        }
        return value;
      }).allow(""))
      .optional(),
    onExceed: Joi.string().valid("CAP", "WARN", "REJECT").optional(),
  }).unknown(true);

  const pipelineStageSchema = Joi.object({
    id: Joi.string().max(64).optional(),
    handler: Joi.string().valid("DISTRIBUTE", "CAP", "OVER", "SPLIT", "RANK").required(),
    config: pipelineStageConfigSchema.optional(),
  });

  const pipelineDefSchema = Joi.object({
    stages: Joi.array().items(pipelineStageSchema).min(1).required(),
  });

  // ==================== 唯一性/交叉校验器 ====================

  /**
   * FIXED 类型交叉校验：type="FIXED" 时必须提供大于 0 的 fixedAmount。
   * 防止配置作者误把 FIXED 当 DIRECT 用（只写 rate 不写 fixedAmount），
   * 或 fixedAmount 配成 0，导致引擎静默不发奖/不可预期的行为。
   */
  function validateRewardFixedAmount(value, helpers) {
    if (value.type === "FIXED") {
      const fa = value.fixedAmount;
      const ok = fa !== undefined && fa !== null && fa !== "" && Number(fa) > 0;
      if (!ok) {
        return helpers.error("any.custom", {
          message: `FIXED 奖励类型必须提供大于 0 的 fixedAmount（rewardId=${value.rewardId}）`,
        });
      }
    }
    return value;
  }

  function validateRewardIdUniqueness(arr, helpers) {
    const ids = arr.map((d) => d.rewardId);
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id)) return helpers.error("any.custom", { message: `rewardId ${id} 重复` });
      seen.add(id);
    }
    return arr;
  }

  function validateRankIdUniqueness(arr, helpers) {
    const ids = arr.map((d) => d.rankId);
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id)) return helpers.error("any.custom", { message: `rankId ${id} 重复` });
      seen.add(id);
    }
    return arr;
  }

  function validateCapIdUniqueness(arr, helpers) {
    const ids = arr.map((d) => d.capId);
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id)) return helpers.error("any.custom", { message: `capId ${id} 重复` });
      seen.add(id);
    }
    return arr;
  }

  // ==================== 完整规则集配置 Schema ====================

  const ruleSetConfigSchema = Joi.object({
    rewardDefs: Joi.array().items(rewardDefSchema).min(1).required()
      .custom(validateRewardIdUniqueness, "rewardId 唯一性校验"),
    rankDefs: Joi.array().items(rankDefSchema).min(1).required()
      .custom(validateRankIdUniqueness, "rankId 唯一性校验"),
    capDefs: Joi.array().items(capDefSchema).optional()
      .custom(validateCapIdUniqueness, "capId 唯一性校验"),
    allocators: Joi.array().items(allocatorSchema).optional(),
    pipelineDef: pipelineDefSchema.optional(),
  }).required();

  // ==================== 引擎事件预览 Schema ====================

  const engineEventPreviewSchema = Joi.object({
    event: Joi.object({
      sourceNodeId: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
      eventType: Joi.string().max(64).optional(),
      eventValue: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
      eventId: Joi.string().max(64).allow(null).optional(),
      attrs: Joi.object().optional(),
    }).required(),
    directParent: Joi.object({
      id: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
      rankRate: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
    }).allow(null).optional(),
    ancestors: Joi.array().items(Joi.object({
      id: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
      rankRate: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
    })).optional(),
    capState: Joi.object({
      platformPaid: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
      memberPaid: Joi.object().pattern(
        Joi.alternatives(),
        Joi.alternatives().try(Joi.string(), Joi.number())
      ).optional(),
    }).allow(null).optional(),
  });

  return {
    pctRateSchema,
    nonNegativeSchema,
    rewardDefSchema,
    conditionSchema,
    rankDefSchema,
    capDefSchema,
    allocatorSchema,
    pipelineStageConfigSchema,
    pipelineStageSchema,
    pipelineDefSchema,
    ruleSetConfigSchema,
    validateRewardIdUniqueness,
    validateRankIdUniqueness,
    validateCapIdUniqueness,
    engineEventPreviewSchema,
  };
}

const { validateCustomerConfig } = require("./customer-config");

module.exports = { createRuleSetValidation, validateCustomerConfig };


