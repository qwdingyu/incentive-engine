/**
 * @usethink/incentive-engine/pure 子入口契约测试（v4.1.0）
 *
 * `./pure` 的存在理由是给**打包型消费方**（Cloudflare Workers / esbuild 单文件 ESM）
 * 一个零 Node 内建依赖的导入图。它的价值完全建立在两条契约上，本文件就守这两条：
 *
 *  1. **形状契约** —— `./pure` 的导出必须与包根同名、同嵌套。
 *     消费方从包根切到 `/pure` 只应改 import 路径，`engine.Distribute.distributeByDefs(...)`
 *     一行都不用动。
 *     事故复盘：曾有消费方为绕开 crypto 而深导入 `src/engine/distribute/index.js`，
 *     该文件把 `Distribute` 这一层抹平了 → `engine.Distribute` 为 undefined →
 *     调用抛 TypeError → 被消费方的 try/catch 吞掉 → 奖励全部静默不发放且零报错。
 *     形状一旦漂移必须在这里就红。
 *
 *  2. **最小面契约** —— 只能有 7 个纯计算子模块，多一个都不行。
 *     `Utils`（用 crypto）/`Services`（用 sequelize）/`Validation`（用 joi）/`Adapters`
 *     一旦混入，导入图就会重新带上外部依赖，本入口即失去意义。
 *
 * 导入图「0 个 node 内建」这条断言由 `scripts/smoke-pure.js` 做静态遍历 + esbuild
 * 真实打包双重把关（jest 环境下 require 内建不会报错，测不出来）。
 *
 * @version 1.0.0
 */

const pure = require("../src/pure.js");
const root = require("../src/index.js");
const { selectVersionByRoutingKey } = require("../src/utils");

/** ./pure 允许且必须导出的键，顺序与 src/pure.js 的 module.exports 一致 */
const PURE_KEYS = ["Distribute", "Evaluate", "Allocate", "Orchestrate", "Model", "Reverse", "Decimal"];

/** 只允许出现在包根、绝不能进 ./pure 的键（各自会拖进 crypto/sequelize/joi） */
const ROOT_ONLY_KEYS = ["Adapters", "Services", "Validation", "Utils"];

describe("pure 子入口 — 最小面契约", () => {
  test("导出键恰好是 7 个纯计算子模块（不多不少）", () => {
    expect(Object.keys(pure).sort()).toEqual([...PURE_KEYS].sort());
  });

  test("不含任何带外部依赖的子模块", () => {
    for (const key of ROOT_ONLY_KEYS) {
      expect(pure[key]).toBeUndefined();
    }
    // 反向确认：这些键在包根确实存在，说明上面的 undefined 是「刻意不带」而非「拼错了键名」
    for (const key of ROOT_ONLY_KEYS) {
      expect(root[key]).toBeDefined();
    }
  });

  test("包根仍导出全部 11 个子模块（v4.1.0 是纯增量，不得削减包根）", () => {
    expect(Object.keys(root).sort()).toEqual([...PURE_KEYS, ...ROOT_ONLY_KEYS].sort());
  });
});

describe("pure 子入口 — 形状契约（与包根同名同嵌套）", () => {
  test.each(PURE_KEYS)("%s 与包根是同一个对象引用", (key) => {
    // 同一引用是最强的形状保证：pure.js 只做 re-export，不重新包装、不抹平层级。
    expect(pure[key]).toBe(root[key]);
  });

  test.each(PURE_KEYS)("%s 的子键集合与包根完全一致", (key) => {
    expect(Object.keys(pure[key]).sort()).toEqual(Object.keys(root[key]).sort());
  });

  test("嵌套调用形状可用：engine.Distribute.distributeByDefs 是函数", () => {
    expect(typeof pure.Distribute.distributeByDefs).toBe("function");
    expect(typeof pure.Decimal.add).toBe("function");
    expect(typeof pure.Allocate.applyCaps).toBe("function");
  });
});

describe("pure 子入口 — 计算结果与包根逐字节一致", () => {
  const params = {
    event: { sourceNodeId: "u1", eventValue: "1000" },
    directParent: { id: "u0", rankRate: "10" },
    ancestors: [{ id: "u0", rankRate: "10" }],
    rewardDefs: [
      { rewardId: "fixed", type: "CUSTOM", target: "SOURCE", amount: "2" },
      { rewardId: "referral", type: "DIRECT", target: "PARENT", rate: "5" },
    ],
  };

  test("distributeByDefs 结果与包根一致且值符合预期", () => {
    const viaPure = pure.Distribute.distributeByDefs(params);
    const viaRoot = root.Distribute.distributeByDefs(params);
    expect(viaPure).toEqual(viaRoot);
    expect(viaPure.map((r) => [r.rewardId, r.amount])).toEqual([
      ["fixed", "2"],
      ["referral", "50"],
    ]);
  });

  test("Decimal 精度语义一致（浮点陷阱回归）", () => {
    expect(pure.Decimal.add("0.1", "0.2")).toBe("0.3");
    expect(pure.Decimal.add("0.1", "0.2")).toBe(root.Decimal.add("0.1", "0.2"));
  });
});

describe("灰度路由惰性 crypto 重构（v4.1.0）— 分桶结果不得漂移", () => {
  // version-select.js 把 `require("crypto")` 从模块顶层挪进了函数体，
  // 目的是消除「打成 ESM 后模块一加载就抛 Dynamic require」的崩溃。
  // 这类重构最大的风险是**悄悄改变 A/B 分桶**：分桶一变，线上正在跑的灰度实验
  // 会整体错位且毫无报错。下面把已知分桶结果钉死，作为回归基线。
  const config = { enabled: true, versions: [{ version: "v1", weight: 50 }, { version: "v2", weight: 50 }] };
  const BASELINE = [
    ["u1", "v2"],
    ["u2", "v1"],
    ["u3", "v1"],
    ["user-1001", "v2"],
    ["tenant-a:user-9", "v2"],
    ["abc", "v2"],
  ];

  test.each(BASELINE)("routingKey %s 稳定命中 %s", (key, expected) => {
    expect(selectVersionByRoutingKey(config, key).version).toBe(expected);
  });

  test("同一 routingKey 多次调用结果幂等（惰性 require 不引入状态）", () => {
    for (const [key] of BASELINE) {
      const first = selectVersionByRoutingKey(config, key).version;
      for (let i = 0; i < 5; i++) {
        expect(selectVersionByRoutingKey(config, key).version).toBe(first);
      }
    }
  });
});
