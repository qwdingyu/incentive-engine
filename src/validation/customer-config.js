/**
 * 客户配置校验 — 对 GenericSettlementService 配置的 Joi 校验
 *
 * 职责：在创建 GenericSettlementService 实例之前，校验客户配置的结构完整性，
 * 防止缺失必填项、函数类型错误等导致运行时异常。
 *
 * 与 createRuleSetValidation 不同，本模块不要求调用方传入 joi 实例，
 * 而是在首次调用时动态加载 joi（peerDependency，可选）。
 * 若 joi 不可用，则回退到原生 Object 校验。
 *
 * 使用示例：
 * ```js
 * const { validateCustomerConfig } = require("@usethink/incentive-engine").Validation;
 * const result = validateCustomerConfig(config);
 * if (!result.valid) console.error(result.errors);
 * ```
 *
 * @version 1.0.0
 */

/**
 * 校验客户配置
 *
 * @param {Object} config - 客户配置对象
 * @param {boolean} [useJoi=true] - 是否使用 Joi 校验（缺省启用；若 Joi 不可用自动回退）
 * @returns {{ valid: boolean, errors?: string[], warnings?: string[] }}
 */
function validateCustomerConfig(config, useJoi = true) {
  const errors = [];
  const warnings = [];

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { valid: false, errors: ["配置必须是非空对象"] };
  }

  // 尝试 Joi 校验
  if (useJoi) {
    try {
      const Joi = require("joi");
      const schema = buildJoiSchema(Joi);
      const { error, value } = schema.validate(config, { abortEarly: false, allowUnknown: true });
      if (error) {
        for (const detail of error.details) {
          errors.push(detail.message);
        }
      }
      // 检查 Joi 无法表达的函数类型（可选字段也需是函数）
      for (const field of ["postProcess", "buildDirectParent", "buildAncestors"]) {
        const val = config[field];
        if (val !== undefined && val !== null && typeof val !== "function") {
          errors.push(`"${field}" 必须是函数`);
        }
      }
      // 警告：未注入 UniqueConstraintError 时唯一约束兜底失效
      if (!config.UniqueConstraintError) {
        warnings.push("未注入 UniqueConstraintError：并发唯一约束冲突时将无法识别为幂等，建议传入 sequelize.UniqueConstraintError");
      }
      return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined, warnings: warnings.length > 0 ? warnings : undefined };
    } catch (e) {
      if (e.code === "MODULE_NOT_FOUND") {
        warnings.push("Joi 不可用，回退到基础校验");
      } else {
        warnings.push(`Joi 加载异常: ${e.message}，回退到基础校验`);
      }
    }
  }

  // 回退：基础 Object 校验
  return basicValidate(config, errors, warnings);
}

/**
 * 构建 Joi schema
 * @param {Object} Joi
 * @returns {Object} Joi schema
 */
function buildJoiSchema(Joi) {
  return Joi.object({
    name: Joi.string().required().messages({ "any.required": "name 是必填项" }),
    ruleSetCode: Joi.string().required().messages({ "any.required": "ruleSetCode 是必填项" }),
    model: Joi.object({
      create: Joi.func().required(),
      findAll: Joi.func().required(),
      findOne: Joi.func().required(),
      findAndCountAll: Joi.func().required(),
    }).required().messages({ "any.required": "model 是必填项" }),
    buildEvent: Joi.func().required().messages({ "any.required": "buildEvent 是必填项" }),
    buildRecord: Joi.func().required().messages({ "any.required": "buildRecord 是必填项" }),
    idempotency: Joi.object({
      buildPreReadWhere: Joi.func().required(),
      buildFallbackWhere: Joi.func().required(),
    }).required().messages({ "any.required": "idempotency 是必填项" }),
    sequelize: Joi.object({
      transaction: Joi.func().required(),
    }).required().messages({ "any.required": "sequelize 是必填项" }),
    ruleSetService: Joi.object({
      getActiveRuleSet: Joi.func().required(),
    }).required().messages({ "any.required": "ruleSetService 是必填项" }),
    logger: Joi.object({
      info: Joi.func().optional(),
      warn: Joi.func().optional(),
      error: Joi.func().optional(),
    }).optional(),
    buildDirectParent: Joi.func().optional(),
    buildAncestors: Joi.func().optional(),
    postProcess: Joi.func().optional(),
  }).required();
}

/**
 * 基础 Object 校验（Joi 不可用时的回退）
 */
function basicValidate(config, errors, warnings) {
  const requiredFields = ["name", "ruleSetCode", "model", "buildEvent", "buildRecord", "idempotency", "sequelize", "ruleSetService"];

  for (const field of requiredFields) {
    if (config[field] === undefined || config[field] === null) {
      errors.push(`"${field}" 是必填项`);
    }
  }

  if (config.buildEvent !== undefined && typeof config.buildEvent !== "function") {
    errors.push("\"buildEvent\" 必须是函数");
  }
  if (config.buildRecord !== undefined && typeof config.buildRecord !== "function") {
    errors.push("\"buildRecord\" 必须是函数");
  }
  if (config.idempotency) {
    if (typeof config.idempotency.buildPreReadWhere !== "function") {
      errors.push("\"idempotency.buildPreReadWhere\" 必须是函数");
    }
    if (typeof config.idempotency.buildFallbackWhere !== "function") {
      errors.push("\"idempotency.buildFallbackWhere\" 必须是函数");
    }
  }
  if (config.sequelize && typeof config.sequelize.transaction !== "function") {
    errors.push("\"sequelize.transaction\" 必须是函数");
  }
  if (config.ruleSetService && typeof config.ruleSetService.getActiveRuleSet !== "function") {
    errors.push("\"ruleSetService.getActiveRuleSet\" 必须是函数");
  }
  // 警告：未注入 UniqueConstraintError 时唯一约束兜底失效
  if (!config.UniqueConstraintError) {
    warnings.push("未注入 UniqueConstraintError：并发唯一约束冲突时将无法识别为幂等，建议传入 sequelize.UniqueConstraintError");
  }
  if (config.model) {
    for (const method of ["create", "findAll", "findOne", "findAndCountAll"]) {
      if (typeof config.model[method] !== "function") {
        errors.push(`"model.${method}" 必须是函数`);
      }
    }
  }

  return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined, warnings: warnings.length > 0 ? warnings : undefined };
}

module.exports = { validateCustomerConfig };