/**
 * CONFIG_FIELD_KEYS 字段名常量契约测试
 *
 * 验证 CONFIG_FIELD_KEYS 的常量值与 ruleSetConfigSchema 实际接受的字段名一致。
 * 防止修改 schema 字段名时忘记同步常量（常量是消费方 rbb 的唯一事实来源，
 * 常量与 schema 漂移会静默破坏上层 diff/回滚逻辑）。
 */

const Joi = require("joi");
const { Validation } = require("../src/index");
const { createRuleSetValidation, CONFIG_FIELD_KEYS } = Validation;

describe("CONFIG_FIELD_KEYS 字段名常量契约", () => {
  const { ruleSetConfigSchema } = createRuleSetValidation(Joi);

  test("常量已导出且冻结", () => {
    expect(CONFIG_FIELD_KEYS).toBeDefined();
    expect(Object.isFrozen(CONFIG_FIELD_KEYS)).toBe(true);
  });

  test("REWARD_ID 是 rewardDef 的子字段名且 schema 接受", () => {
    // 用 CONFIG_FIELD_KEYS.REWARD_ID 构造配置，schema 必须通过
    const cfg = {
      rewardDefs: [{ [CONFIG_FIELD_KEYS.REWARD_ID]: "r1", type: "DIRECT", target: "PARENT", rate: "10" }],
      rankDefs: [{ rankId: "V0", levelIndex: 0, conditions: [], metadata: {} }],
    };
    const { error } = ruleSetConfigSchema.validate(cfg);
    expect(error).toBeUndefined();
    // 用错误字段名（rewardID）必须校验失败——证明常量值才是 schema 认可的字段名
    const wrongCfg = {
      rewardDefs: [{ rewardID: "r1", type: "DIRECT", target: "PARENT", rate: "10" }],
      rankDefs: [{ rankId: "V0", levelIndex: 0, conditions: [], metadata: {} }],
    };
    const wrongError = ruleSetConfigSchema.validate(wrongCfg).error;
    expect(wrongError).toBeDefined();
  });

  test("RANK_ID / CAP_ID 与 schema 字段一致", () => {
    // 验证常量值与 schema 子 schema 中的字段名一致
    // 通过 describe() 获取 rewardDefSchema 的键集合
    const { rewardDefSchema, rankDefSchema, capDefSchema } = createRuleSetValidation(Joi);
    const rewardKeys = Object.keys(rewardDefSchema.describe().keys);
    expect(rewardKeys).toContain(CONFIG_FIELD_KEYS.REWARD_ID);
    const rankKeys = Object.keys(rankDefSchema.describe().keys);
    expect(rankKeys).toContain(CONFIG_FIELD_KEYS.RANK_ID);
    const capKeys = Object.keys(capDefSchema.describe().keys);
    expect(capKeys).toContain(CONFIG_FIELD_KEYS.CAP_ID);
  });

  test("所有字段名常量都在对应子 schema 的描述中", () => {
    const { rewardDefSchema, rankDefSchema, capDefSchema } = createRuleSetValidation(Joi);
    const rewardKeys = Object.keys(rewardDefSchema.describe().keys);
    const rankKeys = Object.keys(rankDefSchema.describe().keys);
    const capKeys = Object.keys(capDefSchema.describe().keys);
    // 验证 TYPE/TARGET/RATE 在 rewardDef 中
    expect(rewardKeys).toContain(CONFIG_FIELD_KEYS.TYPE);
    expect(rewardKeys).toContain(CONFIG_FIELD_KEYS.TARGET);
    expect(rewardKeys).toContain(CONFIG_FIELD_KEYS.RATE);
    expect(rewardKeys).toContain(CONFIG_FIELD_KEYS.FIXED_AMOUNT);
    expect(rewardKeys).toContain(CONFIG_FIELD_KEYS.AMOUNT);
    expect(rewardKeys).toContain(CONFIG_FIELD_KEYS.AMOUNT_FROM);
    // 验证 LEVEL_INDEX 在 rankDef 中
    expect(rankKeys).toContain(CONFIG_FIELD_KEYS.LEVEL_INDEX);
    // 验证 SCOPE/LIMIT 在 capDef 中
    expect(capKeys).toContain(CONFIG_FIELD_KEYS.SCOPE);
    expect(capKeys).toContain(CONFIG_FIELD_KEYS.LIMIT);
  });
});