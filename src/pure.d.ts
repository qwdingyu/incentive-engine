/**
 * TypeScript 类型声明 — @usethink/incentive-engine/pure
 *
 * 与 `src/pure.js` 的运行时导出**一一对应**：只有 7 个纯计算子模块，
 * 不含 `Adapters` / `Services` / `Validation` / `Utils`。
 *
 * ⚠️ 为什么不用 `export * from "./index"`：
 * 那会把 `Adapters`/`Services`/`Validation`/`Utils` 也当作可用值导出，
 * 而它们在本入口的运行时**并不存在**。类型说有、运行时没有 = 消费方
 * `engine.Utils.xxx` 通过类型检查却在运行时抛 `undefined`，
 * 这正是本次重构要根除的失败模式（详见 src/pure.js 头部的事故记录）。
 * 因此这里逐一显式列出真实存在的子模块，多一个都不加。
 *
 * 纯类型（type/interface）不占运行时，可以整体透传：`export type *`。
 *
 * @version 1.0.0
 * @license MIT
 */

// 纯类型全量透传（DecimalString / Numeric / RewardDefLike / RewardRecord / ... ）。
// `export type *` 只搬运类型侧，不会凭空声明任何运行时值。
export type * from "./index";

// 运行时真实存在的 7 个子模块（值 + 其命名空间下的类型）。
// 顺序与 src/pure.js 的 module.exports 保持一致，便于逐行核对。
export {
  Distribute,
  Evaluate,
  Allocate,
  Orchestrate,
  Model,
  Reverse,
  Decimal,
} from "./index";

/**
 * 默认导出 —— 与 `src/pure.js` 的 `module.exports` 形状一致，
 * 且与包根默认导出**同名同嵌套**，因此消费方从包根切到 `/pure`
 * 只需改 import 路径，`engine.Distribute.distributeByDefs(...)` 一行都不用动。
 */
declare const pureEngine: {
  Distribute: typeof import("./index").Distribute;
  Evaluate: typeof import("./index").Evaluate;
  Allocate: typeof import("./index").Allocate;
  Orchestrate: typeof import("./index").Orchestrate;
  Model: typeof import("./index").Model;
  Reverse: typeof import("./index").Reverse;
  Decimal: typeof import("./index").Decimal;
};

export default pureEngine;
