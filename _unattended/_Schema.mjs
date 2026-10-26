/**
 * 最小 JSON Schema 校验器（只支持本项目 5 个契约用到的子集）
 *
 * 为什么不引 ajv：工作台**零依赖**（没有 package.json / node_modules）。
 * 文档 §八 要求"契约有 AI 可执行的检测"——执行器本身不需要是个完整实现，
 * 但**不允许"看起来通过了"**：不认识的 keyword 一律报错，而不是静默跳过。
 *
 * 支持：type / const / enum / required / properties / additionalProperties(bool) /
 *        items / minItems / minLength / pattern / minimum / not / format(date-time) / $ref(本文件内 #/definitions)
 */

export class SchemaError extends Error {
  constructor (msg, path) {
    super(`${path || '#'}: ${msg}`)
    this.name = 'SchemaError'
    this.path = path
  }
}

const KNOWN_KEYWORDS = new Set([
  '$schema', '$id', 'title', 'description', 'examples', 'definitions', '$ref',
  'type', 'const', 'enum', 'required', 'properties', 'additionalProperties',
  'items', 'minItems', 'minLength', 'pattern', 'minimum', 'not', 'format'
])

function typeOf (v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (Number.isInteger(v)) return 'integer'
  if (typeof v === 'number') return 'number'
  return typeof v
}

function typeMatches (v, want) {
  const t = typeOf(v)
  if (want === 'number') return t === 'number' || t === 'integer'
  if (want === 'integer') return t === 'integer'
  return t === want
}

function check (schema, value, path, root) {
  if (schema === true || schema === undefined) return []
  if (schema === false) return [`${path}: 不允许任何值`]
  const errs = []

  // 不认识的 keyword = 硬错误（不许静默跳过，否则"通过"是假的）
  for (const k of Object.keys(schema)) {
    if (!KNOWN_KEYWORDS.has(k)) errs.push(`${path}: 未知 keyword \`${k}\`（本校验器不支持，别指望它）`)
  }

  if (schema.$ref) {
    const ref = String(schema.$ref)
    if (!ref.startsWith('#/definitions/')) return [`${path}: 只支持本文件内 #/definitions/$ref`]
    const def = root?.definitions?.[ref.slice('#/definitions/'.length)]
    if (!def) return [`${path}: $ref 指向不存在的定义 ${ref}`]
    return check(def, value, path, root)
  }

  if (schema.type !== undefined) {
    const want = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!want.some(t => typeMatches(value, t))) errs.push(`${path}: 类型应为 ${want.join('|')}，实际 ${typeOf(value)}`)
  }
  if (schema.const !== undefined && value !== schema.const) errs.push(`${path}: 应恒等于 ${JSON.stringify(schema.const)}，实际 ${JSON.stringify(value)}`)
  if (Array.isArray(schema.enum) && !schema.enum.some(e => e === value)) errs.push(`${path}: 应是 ${schema.enum.map(e => JSON.stringify(e)).join('/')} 之一，实际 ${JSON.stringify(value)}`)
  if (typeof schema.pattern === 'string' && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) errs.push(`${path}: 不匹配 ${schema.pattern}`)
  if (schema.minLength !== undefined && typeof value === 'string' && value.length < schema.minLength) errs.push(`${path}: 长度应 ≥ ${schema.minLength}`)
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) errs.push(`${path}: 应 ≥ ${schema.minimum}`)
  if (schema.format === 'date-time' && typeof value === 'string' && !Number.isFinite(Date.parse(value))) errs.push(`${path}: 不是合法日期时间：${value}`)

  if (schema.not !== undefined) {
    const sub = check(schema.not, value, path, root)
    if (!sub.length) errs.push(`${path}: 命中了 not（${JSON.stringify(schema.not)}）`)
  }

  if (typeOf(value) === 'object') {
    for (const k of schema.required ?? []) {
      if (!Object.hasOwn(value, k)) errs.push(`${path}: 缺必填字段 \`${k}\``)
    }
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, k)) errs.push(...check(sub, value[k], `${path}/${k}`, root))
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).filter(k => !Object.hasOwn(schema.properties ?? {}, k))
      if (extra.length) errs.push(`${path}: 不允许多余字段 ${extra.join('、')}`)
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${path}: 至少 ${schema.minItems} 项`)
    if (schema.items) value.forEach((v, i) => errs.push(...check(schema.items, v, `${path}/${i}`, root)))
  }

  return errs
}

/**
 * 校验；返回 `{ ok, errors[] }`（不抛，便于体检汇总）。
 */
export function validate (schema, value, path = '#') {
  const errors = check(schema, value, path, schema)
  return { ok: errors.length === 0, errors }
}

/** 严格版：不过就抛（单测/CLI 用） */
export function assertValid (schema, value, path = '#') {
  const r = validate(schema, value, path)
  if (!r.ok) throw new SchemaError(r.errors.join('；'), path)
  return true
}
