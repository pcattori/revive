import type { NodePath } from '@babel/traverse'
import type { types as BabelTypes } from '@babel/core'
import { parse } from '@babel/parser'
import * as t from '@babel/types'

// Avoid CJS-ESM default export interop differences across different tools
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
import _traverse = require('@babel/traverse')
import _generate = require('@babel/generator')
const traverse = _traverse.default
const generate = _generate.default

export { traverse, generate, parse, t }
export type { BabelTypes, NodePath }
