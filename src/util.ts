import * as stencila from '@stencila/schema'
import Ajv from 'ajv'
import betterAjvErrors from 'better-ajv-errors'
import fs from 'fs-extra'
import globby from 'globby'
import produce from 'immer'
import path from 'path'
import { parse as parsePerson } from './person'

const built = path.join(
  path.dirname(require.resolve('@stencila/schema')),
  'built'
)

// Load all schemas for use in by Ajv validator
const schemas = globby
  .sync(path.join(built, '*.schema.json'))
  .map(file => fs.readJSONSync(file))

// Read in aliases for use in coerce function
const aliases = fs.readJSONSync(path.join(built, 'aliases.json'))

/**
 * Create a node of a type
 * @param type The name of the type
 * @param initial Initial values for properties
 * @param validation What validation should done?
 */
export function create<Key extends keyof stencila.Types>(
  type: Key,
  initial: { [key: string]: any } = {},
  validation: 'none' | 'validate' | 'coerce' = 'validate'
): stencila.Types[Key] {
  let node = { type, ...initial }
  if (validation === 'validate') return validate(node, type)
  else if (validation === 'coerce') return coerce(node, type)
  else return node
}

/**
 * Get the type of a node
 * @param node The node to get the type for
 */
export function type(node: any): string {
  if (node === null) return 'null'
  let type = typeof node
  if (type === 'object') {
    if (Array.isArray(node)) return 'array'
    if (node.type) return node.type
  }
  return type
}

/**
 * Is a node of a particular type/s
 * @param node The node to check
 * @param types The type names to check against
 */
export function is(node: any, types: string | string[]): boolean {
  if (typeof types === 'string') return type(node) === types
  else return types.includes(type(node))
}

/**
 * Assert that a node is of a particular type/s
 * @param node The node to check
 * @param types The type names to check against
 */
export function assert(node: any, types: string | string[]): boolean {
  if (is(node, types)) return true
  else {
    const list = typeof types === 'string' ? types : types.join('|')
    throw new Error(`Node type is "${type(node)}" but expected "${list}"`)
  }
}

/**
 * Cast a node to a particular type
 *
 * The node is validated against the type.
 * This means that an error will be throw if during:
 *   - up-casting the node does not have properties
 *     that are required by the schema of the new type
 *   - down-casting the node has properties that
 *     are additional to those in the schema of the new type
 * Use `coerce` if you want to ignore such errors
 * and force mutating the node to the type.
 *
 * @param node The node to cast
 * @param type The type to cast to
 */
export function cast<Key extends keyof stencila.Types>(
  node: any,
  type: Key
): stencila.Types[Key] {
  return produce(node, (casted: any) => {
    casted.type = type
    validate(casted, type)
  })
}

// Cached JSON Schema validation functions
const validators = new Ajv({
  schemas,
  jsonPointers: true
})

/**
 * Validate a node against a type's schema
 * @param node The node to validate
 * @param type The type to validate against
 */
export function validate<Key extends keyof stencila.Types>(
  node: any,
  type: Key
): stencila.Types[Key] {
  const validator = validators.getSchema(
    `https://stencila.github.com/schema/${type}.schema.json`
  )
  if (!validator) throw new Error(`No schema for type "${type}".`)
  if (!validator(node)) {
    const errors = (betterAjvErrors(validator.schema, node, validator.errors, {
      format: 'js'
    }) as unknown) as betterAjvErrors.IOutputError[]
    throw new Error(errors.map(error => `${error.error}`).join(';'))
  }
  return node
}

/**
 * Is a node valid with respect to a particular type's schema
 * @param node The node to check
 * @param type The type to check against
 */
export function valid<Key extends keyof stencila.Types>(
  node: any,
  type: Key
): boolean {
  try {
    validate(node, type)
    return true
  } catch (error) {
    return false
  }
}

// Cached JSON Schema validation/mutation functions
// These use Ajv options that coerce nodes so we
// keep them separate from pure non-mutating validators.
const mutators = new Ajv({
  schemas,
  jsonPointers: true,
  // Add values from `default` keyword when property is missing
  useDefaults: true,
  // Remove any additional properties
  removeAdditional: true,
  // Coerce type of data to match type keyword and coerce scalar
  // data to an array with one element and vice versa, as needed.
  coerceTypes: 'array'
})

/**
 * A list of parsers that can be applied using the `parser` keyword
 */
const parsers: { [key: string]: (data: string) => any } = {
  csv,
  ssv,
  person: parsePerson
}

/**
 * Parse comma separated string data into an array of strings
 */
function csv(data: string): Array<string> {
  return data.split(',')
}

/**
 * Parse space separated string data into an array of strings
 */
function ssv(data: string): Array<string> {
  return data.split(/ +/)
}

/**
 * Custom validation function that handles the `parser`
 * keyword.
 */
const parserValidate: Ajv.SchemaValidateFunction = (
  parser: string,
  data: string,
  parentSchema?: object,
  dataPath?: string,
  parentData?: object | Array<any>,
  parentDataProperty?: string | number,
  rootData?: object | Array<any>
): boolean => {
  function raise(msg: string) {
    parserValidate.errors = [
      {
        keyword: 'parser',
        dataPath: '' + dataPath,
        schemaPath: '',
        params: {
          keyword: 'parser'
        },
        message: msg,
        data: data
      }
    ]
    return false
  }
  const parse = parsers[parser]
  if (!parse) return raise(`no such parser: "${parser}"`)

  let parsed: any
  try {
    parsed = parse(data)
  } catch (error) {
    const parseError = error.message.split('\n')[0]
    return raise(`error when parsing using "${parser}": ${parseError}`)
  }

  if (parentData !== undefined && parentDataProperty !== undefined) {
    ;(parentData as any)[parentDataProperty] = parsed
  }
  return true
}

mutators.addKeyword('parser', {
  type: 'string',
  modifying: true,
  validate: parserValidate
})

/**
 * Coerce a node so it conforms to a type's schema
 *
 * @param node The node to coerce
 * @param typeName The type to coerce it to
 */
export function coerce<Key extends keyof stencila.Types>(
  node: any,
  typeName?: Key
): stencila.Types[Key] {
  if (!typeName) typeName = type(node) as Key

  const mutator = mutators.getSchema(
    `https://stencila.github.com/schema/${typeName}.schema.json`
  )
  if (!mutator) throw new Error(`No schema for type "${typeName}".`)

  return produce(node, (coerced: any) => {
    if (typeof coerced === 'object') coerced.type = typeName
    // Rename property aliases
    rename(coerced)
    // coerce and validate
    if (!mutator(coerced)) {
      const errors = (betterAjvErrors(mutator.schema, node, mutator.errors, {
        format: 'js'
      }) as unknown) as betterAjvErrors.IOutputError[]
      throw new Error(errors.map(error => `${error.error}`).join(';'))
    }
  })
  // Replace aliases with canonical names
  function rename(node: any) {
    if (!node || typeof node !== 'object') return
    if (!(node.type && aliases[node.type])) return

    let propertyAliases = aliases[node.type]
    for (let [key, child] of Object.entries(node)) {
      if (!Array.isArray(node)) {
        const name = propertyAliases[key]
        if (name) {
          node[name] = child
          delete node[key]
        }
      }
      rename(child)
    }
  }
}
