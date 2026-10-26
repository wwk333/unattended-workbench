/**
 * 契约层总出口 —— 消费方只 `import ... from './契约/index.mjs'`。
 *
 * 为什么要有：契约有 6 个文件，让每个消费方各记一套 import 路径，
 * 迟早有人 import 错版本（或者绕过契约自己拼字符串）。这里只做转发，不含逻辑。
 */

export * as 枚举 from './枚举.mjs'
export * as 信封 from './信封.mjs'
export * as 快照 from './快照.mjs'
export * as 写方 from './写方.mjs'
export * as 权限 from './权限.mjs'
export * as 画像 from './画像.mjs'

export { ENUMS, BLOCKED_OWNERS, assertState, isValidState, assertTransition, canTransition, UNKNOWN } from './枚举.mjs'
export { envelope, validateEnvelope, assertEnvelope, envelopeGreen, healthOf, ENVELOPE_REQUIRED } from './信封.mjs'
export { computeSnapshot, snapshotIdFromManifest, snapshotIdFromGateResult, migrateSnapshotField, diffManifests } from './快照.mjs'
export { loadRegistry, validateRegistry, assertRegistry, DEAD_FIELDS, assertWriter } from './写方.mjs'
export { checkWrite, assertAllowed, regionOfRoute, REGIONS, CONFIG_AUDIT_FIELDS } from './权限.mjs'
export { profileKey, normalizeProfile, indexProfiles, canRunConcurrently, assertConfigWriteAllowed } from './画像.mjs'
