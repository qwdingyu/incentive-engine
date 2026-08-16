/**
 * @usethink/incentive-engine validateCustomerConfig 单元测试
 *
 * 覆盖 Joi 路径（Joi 可用时）和基础回退路径（Joi 不可用时），
 * 验证必填项缺失、函数类型错误、可选字段正确性等场景。
 *
 * @version 1.0.0
 */

const { validateCustomerConfig } = require("../src/validation/customer-config");

// ===================== 辅助 =====================

/**
 * 构建一个合法的最小客户配置
 */
function validConfig() {
  return {
    name: "test-customer",
    ruleSetCode: "TEST_RULESET",
    model: {
      create: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      findAndCountAll: jest.fn(),
    },
    buildEvent: jest.fn(),
    buildRecord: jest.fn(),
    idempotency: {
      buildPreReadWhere: jest.fn(),
      buildFallbackWhere: jest.fn(),
    },
    sequelize: {
      transaction: jest.fn(),
    },
    ruleSetService: {
      getActiveRuleSet: jest.fn(),
    },
  };
}

// ===================== 测试 =====================

describe("validateCustomerConfig（Joi 路径）", () => {
  test("合法配置通过校验", () => {
    const result = validateCustomerConfig(validConfig());
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  test("未注入 UniqueConstraintError 时给出警告（不阻断）", () => {
    const result = validateCustomerConfig(validConfig());
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("UniqueConstraintError"))).toBe(true);
  });

  test("注入 UniqueConstraintError 后无警告", () => {
    class FakeUCE extends Error {}
    const cfg = validConfig();
    cfg.UniqueConstraintError = FakeUCE;
    const result = validateCustomerConfig(cfg);
    expect(result.valid).toBe(true);
    expect(result.warnings || []).not.toContain(expect.stringContaining("UniqueConstraintError"));
  });

  test("缺失 name 报错", () => {
    const cfg = validConfig();
    delete cfg.name;
    const result = validateCustomerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("name"))).toBe(true);
  });

  test("缺失 ruleSetCode 报错", () => {
    const cfg = validConfig();
    delete cfg.ruleSetCode;
    const result = validateCustomerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("ruleSetCode"))).toBe(true);
  });

  test("缺失 model 报错", () => {
    const cfg = validConfig();
    delete cfg.model;
    const result = validateCustomerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("model"))).toBe(true);
  });

  test("model.create 不是函数时报错", () => {
    const cfg = validConfig();
    cfg.model.create = "not-a-function";
    const result = validateCustomerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("model.create") || e.includes("create"))).toBe(true);
  });

  test("buildEvent 不是函数时报错", () => {
    const cfg = validConfig();
    cfg.buildEvent = "not-a-function";
    const result = validateCustomerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("buildEvent"))).toBe(true);
  });

  test("buildRecord 不是函数时报错", () => {
    const cfg = validConfig();
    cfg.buildRecord = 123;
    const result = validateCustomerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("buildRecord"))).toBe(true);
  });

  test("idempotency.buildPreReadWhere 不是函数时报错", () => {
    const cfg = validConfig();
    cfg.idempotency.buildPreReadWhere = null;
    const result = validateCustomerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("buildPreReadWhere"))).toBe(true);
  });

  test("sequelize 缺失报错", () => {
    const cfg = validConfig();
    delete cfg.sequelize;
    const result = validateCustomerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("sequelize"))).toBe(true);
  });

  test("ruleSetService 缺失报错", () => {
    const cfg = validConfig();
    delete cfg.ruleSetService;
    const result = validateCustomerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("ruleSetService"))).toBe(true);
  });

  test("可选字段 logger 合法时通过", () => {
    const cfg = validConfig();
    cfg.logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const result = validateCustomerConfig(cfg);
    expect(result.valid).toBe(true);
  });

  test("可选字段 buildDirectParent 合法时通过", () => {
    const cfg = validConfig();
    cfg.buildDirectParent = jest.fn();
    const result = validateCustomerConfig(cfg);
    expect(result.valid).toBe(true);
  });

  test("可选字段 postProcess 不是函数时报错", () => {
    const cfg = validConfig();
    cfg.postProcess = "not-a-function";
    const result = validateCustomerConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("postProcess"))).toBe(true);
  });

  test("空配置报错", () => {
    const result = validateCustomerConfig(null);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("非空"))).toBe(true);
  });

  test("数组配置报错", () => {
    const result = validateCustomerConfig([]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("非空"))).toBe(true);
  });
});

describe("validateCustomerConfig（基础回退路径）", () => {
  beforeAll(() => {
    // 模拟 joi 不可用：删除 require.cache 中 joi 的条目
    // 通过 useJoi=false 控制，不依赖 mock
  });

  test("Joi 禁用时回退到基础校验，合法配置通过", () => {
    const result = validateCustomerConfig(validConfig(), false);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  test("Joi 禁用时缺失必填项仍报错", () => {
    const cfg = validConfig();
    delete cfg.name;
    delete cfg.ruleSetCode;
    const result = validateCustomerConfig(cfg, false);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  test("Joi 禁用时类型错误仍报错", () => {
    const cfg = validConfig();
    cfg.buildEvent = "not-a-function";
    const result = validateCustomerConfig(cfg, false);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("buildEvent"))).toBe(true);
  });
});