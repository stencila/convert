/**
 * @module util
 */

// TODO: This file uses any a lot. Needs a refactor and re-enable linting
/* eslint-disable
      @typescript-eslint/no-explicit-any,
      @typescript-eslint/explicit-function-return-type,
      @typescript-eslint/no-use-before-define
*/

import * as stencila from '@stencila/schema'
import {
  isEntity,
  isBlockContent,
  isInlineContent,
  nodeType
} from '@stencila/schema/dist/util'
import Ajv from 'ajv'
import betterAjvErrors from 'better-ajv-errors'
import fs from 'fs-extra'
import produce from 'immer'
import path from 'path'
import { decodeSync as decodePerson } from '../codecs/person'

/**
 * Create a node of a type
 * @param type The name of the type
 * @param initial Initial values for properties
 * @param validation What validation should done?
 */
export async function create<Key extends keyof stencila.Types>(
  type: Key,
  initial: { [key: string]: any } = {},
  validation: 'validate' | 'coerce' = 'validate'
): Promise<stencila.Types[Key]> {
  const node = { type, ...initial }
  if (validation === 'validate') return validate(node, type)
  else if (validation === 'coerce') return coerce(node, type)
  else throw new Error(`Must either validate or coerce the node`)
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
export async function cast<Key extends keyof stencila.Types>(
  node: any,
  type: Key
): Promise<stencila.Types[Key]> {
  return (produce(node, async (casted: any) => {
    casted.type = type
    await validate(casted, type)
  }) as unknown) as stencila.Types[Key]
}

// Cached JSON Schema validation functions
const validators = new Ajv({
  jsonPointers: true,
  loadSchema
})

/**
 * Load a JSON Schema based on its URI
 */
async function loadSchema(uri: string) {
  const match = uri.match(/([\w]+)\.schema\.json$/)
  if (match) return readSchema(match[1] as keyof stencila.Types)
  throw new Error(`Can not resolve schema "${uri}"`)
}

const schemasPath = path.dirname(require.resolve('@stencila/schema'))

/**
 * Read a JSON Schema file from `@stencila/schema`
 */
async function readSchema<Key extends keyof stencila.Types>(type: Key) {
  try {
    return await fs.readJSON(path.join(schemasPath, `${type}.schema.json`))
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new Error(`No schema for type "${type}".`)
    throw error
  }
}

/**
 * Get the `Ajv` validation function for a type
 */
async function getValidator<Key extends keyof stencila.Types>(
  ajv: Ajv.Ajv,
  type: Key
): Promise<Ajv.ValidateFunction> {
  let validator = ajv.getSchema(
    `https://stencila.github.com/schema/${type}.schema.json`
  )
  if (!validator) {
    const schema = await readSchema(type)
    validator = await ajv.compileAsync(schema)
  }
  return validator
}

/**
 * Get the `Schema` object for a type
 */
async function getSchema<Key extends keyof stencila.Types>(
  ajv: Ajv.Ajv,
  type: Key
): Promise<any> {
  const validator = await getValidator(ajv, type)
  const schema = validator.schema
  if (schema === undefined || typeof schema === 'boolean')
    throw new Error(`Woaah! No schema on validator for type "${type}".`)
  return schema
}

/**
 * Validate a node against a type's schema
 * @param node The node to validate
 * @param type The type to validate against
 */
export async function validate<Key extends keyof stencila.Types>(
  node: any,
  type?: Key
): Promise<stencila.Types[Key]> {
  if (type === undefined) type = nodeType(node) as Key
  const validator = await getValidator(validators, type)
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
export async function valid<Key extends keyof stencila.Types>(
  node: any,
  type: Key
): Promise<boolean> {
  try {
    await validate(node, type)
    return true
  } catch (error) {
    return false
  }
}

// Cached JSON Schema validation/mutation functions
// These use Ajv options that coerce nodes so we
// keep them separate from pure non-mutating validators.
const mutators = new Ajv({
  jsonPointers: true,
  // Add values from `default` keyword when property is missing
  useDefaults: true,
  // Remove any additional properties
  removeAdditional: true,
  // Coerce type of data to match type keyword and coerce scalar
  // data to an array with one element and vice versa, as needed.
  coerceTypes: 'array',
  loadSchema
})

/**
 * A list of codecs that can be applied using the `codec` keyword
 *
 * TODO: Make these actual codecs (i.e. conforming to the `Codec`
 * interface with a `decode` async function)
 */
const codecs: { [key: string]: (data: string) => any } = {
  csv,
  ssv,
  person: decodePerson
}

/**
 * Decode comma separated string data into an array of strings
 */
function csv(data: string): string[] {
  return data.split(',')
}

/**
 * Decode space separated string data into an array of strings
 */
function ssv(data: string): string[] {
  return data.split(/ +/)
}

/**
 * Custom validation function that handles the `codec`
 * keyword.
 */
const codecValidate: Ajv.SchemaValidateFunction = (
  codec: string,
  data: string,
  parentSchema?: object,
  dataPath?: string,
  parentData?: object | any[],
  parentDataProperty?: string | number
  // rootData?: object | any[]
): boolean => {
  function raise(msg: string) {
    codecValidate.errors = [
      {
        keyword: 'decoding',
        dataPath: dataPath || '',
        schemaPath: '',
        params: {
          keyword: 'codec'
        },
        message: msg,
        data: data
      }
    ]
    return false
  }
  const decode = codecs[codec]
  if (!decode) return raise(`no such codec: "${codec}"`)

  let decoded: any
  try {
    decoded = decode(data)
  } catch (error) {
    const decodeError = error.message.split('\n')[0]
    return raise(`error using "${codec}" codec: ${decodeError}`)
  }

  if (parentData !== undefined && parentDataProperty !== undefined) {
    ;(parentData as any)[parentDataProperty] = decoded
  }
  return true
}

mutators.addKeyword('codec', {
  type: 'string',
  modifying: true,
  validate: codecValidate
})

/**
 * Coerce a node so it conforms to a type's schema
 *
 * @param node The node to coerce
 * @param typeName The type to coerce it to
 */
export async function coerce<Key extends keyof stencila.Types>(
  node: any,
  type?: Key
): Promise<stencila.Types[Key]> {
  if (type === undefined) type = nodeType(node) as Key
  const mutator = await getValidator(mutators, type)

  return (produce(node, async (coerced: any) => {
    if (typeof coerced === 'object') coerced.type = type
    // Rename property aliases
    await rename(coerced)
    // coerce and validate
    if (!mutator(coerced)) {
      const errors = (betterAjvErrors(mutator.schema, node, mutator.errors, {
        format: 'js'
      }) as unknown) as betterAjvErrors.IOutputError[]
      throw new Error(errors.map(error => `${error.error}`).join(';'))
    }
  }) as unknown) as stencila.Types[Key]

  // Replace aliases with canonical names
  async function rename(node: Node) {
    if (isEntity(node)) {
      const schema = await getSchema(mutators, node.type as Key)
      if (!schema.propertyAliases) return

      for (const [key, child] of Object.entries(node)) {
        const name = schema.propertyAliases[key]
        if (name) {
          // @ts-ignore
          node[name] = child
          // @ts-ignore
          delete node[key]
        }
        await rename(child)
      }
    } else if (Array.isArray(node)) {
      for (const child of node) {
        await rename(child)
      }
    }
  }
}

/* Wrap non-`BlockContent` nodes in `Paragraph` nodes to conform to schema */
export const wrapInBlockNode = (node: stencila.Node): stencila.BlockContent => {
  return isBlockContent(node)
    ? node
    : { type: 'Paragraph', content: [node].filter(isInlineContent) }
}
