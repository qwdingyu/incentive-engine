/**
 * 灰度版本路由选择器 — 纯函数，无外部依赖
 *
 * 职责：根据 routingKey 的 hash 值，从灰度配置的多个版本中选择一个版本。
 * 用于规则集灰度发布/A-B测试：不同会员（routingKey）被路由到不同版本。
 *
 * 算法：
 * - 使用 crypto.createHash("md5") 对 routingKey 做 hash，取前 4 字节转整数（0~65535），
 * - 模 100 后映射到版本权重区间。
 *
 * ⚠️ crypto 必须**惰性 require**（v4.1.0 起），不得提回模块顶层。
 * 原因：本包是 CJS，被 esbuild 以 `--format=esm` 打包时，CJS 包装器内的 require
 * 会被替换成动态 require 辅助函数；纯 ESM 下它一执行就抛
 * `Dynamic require of "crypto" is not supported`。放在模块顶层 = 模块一加载就崩，
 * 消费方即使从不调用灰度路由也会在进程启动期直接挂掉（cf-lottery 曾因此生产宕机）。
 * 移进函数体后，只有真正调用 selectVersionByRoutingKey 才会触发，
 * 长驻 Node（rbb）行为完全不变，哈希与分桶结果也不变。
 *
 * 注意：惰性化只解决"模块级立即崩溃"。若目标运行时根本没有 crypto
 * （如 Cloudflare Workers 未开 nodejs_compat），打包阶段仍会因静态解析
 * `require("crypto")` 而报错 —— 那种场景请改用零 node 依赖的 `./pure` 子入口。
 *
 * @version 1.1.0
 */

/**
 * 根据 routingKey 从灰度配置中选择版本
 *
 * @param {Object} grayscaleConfig - 灰度配置 { enabled, versions: [{version, weight, config_json}] }
 * @param {string} routingKey - 路由依据（如会员 ID）
 * @returns {Object|null} 选中的版本对象 { version, config_json }，无版本时返回 null
 */
function selectVersionByRoutingKey(grayscaleConfig, routingKey) {
  if (!grayscaleConfig || !grayscaleConfig.enabled) return null;

  const versions = grayscaleConfig.versions || [];
  if (versions.length === 0) return null;
  if (versions.length === 1) return versions[0];

  // 计算 routingKey 的 hash 值（0~99）
  // 惰性 require：见文件头说明，禁止提到模块顶层
  const crypto = require("crypto");
  const hash = crypto.createHash("md5").update(String(routingKey)).digest();
  const bucket = (hash.readUInt16BE(0) + hash.readUInt16BE(2)) % 100;

  // 按权重分配区间
  let cumulative = 0;
  for (const v of versions) {
    cumulative += v.weight || 0;
    if (bucket < cumulative) return v;
  }

  // 兜底：返回最后一个版本
  return versions[versions.length - 1];
}

/**
 * 验证灰度配置的权重总和是否为 100
 *
 * @param {Object} grayscaleConfig - 灰度配置
 * @returns {boolean}
 */
function validateGrayscaleWeights(grayscaleConfig) {
  if (!grayscaleConfig || !grayscaleConfig.versions) return true;
  const total = grayscaleConfig.versions.reduce((s, v) => s + (v.weight || 0), 0);
  return total === 100;
}

module.exports = {
  selectVersionByRoutingKey,
  validateGrayscaleWeights,
};