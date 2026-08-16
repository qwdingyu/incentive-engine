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
 * @version 1.0.0
 */

const crypto = require("crypto");

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