/**
 * Compiler for JSON
 */

import * as stencila from '@stencila/schema'
import { coerce } from './util'
import { dump, load, VFile } from './vfile'

export const mediaTypes = ['application/json']

export async function parse(file: VFile): Promise<stencila.Node> {
  return coerce(JSON.parse(dump(file)))
}

export async function unparse(node: stencila.Node): Promise<VFile> {
  return load(JSON.stringify(node, null, '  '))
}
