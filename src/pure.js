/**
 * @usethink/incentive-engine/pure — 零 Node 依赖的纯计算子入口
 *
 * 与包根（`src/index.js`）的差别只有一处：**不含任何 Node 内建模块依赖**，
 * 因此可以被 esbuild 以 `--format=esm` / `--platform=browser` 直接打包，
 * 产物里不会出现动态 require 辅助函数。
 *
 * 为什么需要这个入口：
 * 包根会 require `./utils`（灰度路由用 `crypto`）、`./services`（懒加载 `sequelize`）、
 * `./validation`（懒加载 `joi`）。这些在长驻 Node 环境（rbb）完全正常，但对
 * **打包型消费方**（Cloudflare Workers / esbuild ESM 单文件）是负担：
 * - `crypto` 在包根是模块级 require → 打成 ESM 后模块一加载就抛
 *   `Dynamic require of "crypto" is not supported`（v4.1.0 已改惰性，但见下一条）；
 * - 即使惰性化，`--platform=browser` 下 esbuild 仍会静态解析
 *   `require("crypto")` 并报 `Could not resolve "crypto"` —— 只有让 crypto
 *   **根本不在导入图里**才能通过，这就是本入口存在的唯一理由。
 *
 * ⚠️ 形状契约（改动前务必读）：
 * 本入口的导出**必须与包根同名同嵌套**。即消费方写
 * `engine.Distribute.distributeByDefs(...)`，把导入从包根换成 `./pure` 后
 * 一个字都不用改。历史事故：有人改成深导入 `src/engine/distribute/index.js`，
 * 那一层把 `Distribute` 拍平了（模块本身就是 Distribute），于是
 * `engine.Distribute` 变成 undefined → `TypeError` 被消费方的 try/catch 吞掉 →
 * 奖励全部静默不发、只留一行日志。任何"简化嵌套"的改动都会重演这个故障。
 *
 * 包含（与包根同形状的子集）：
 * - Distribute / Evaluate / Allocate / Orchestrate / Model / Reverse（来自 ./engine）
 * - Decimal（来自 ./decimal，仅依赖 npm 包 decimal.js，可打包）
 *
 * 不包含（依赖 Node 内建或可选 peer）：
 * - Utils（crypto）、Services（sequelize）、Validation（joi）、Adapters（经 services）
 *   需要这些请从包根导入：`require("@usethink/incentive-engine")`。
 *
 * @version 1.0.0
 * @license MIT
 */

const Engine = require("./engine");
const Decimal = require("./decimal");

module.exports = {
  ...Engine,
  Decimal,
};
