import { parse } from '@babel/parser'
import generate from '@babel/generator'
import traverse from '@babel/traverse'

export const replaceImportSpecifier = ({
  code,
  specifier,
  replaceWith,
}: {
  code: string
  specifier: string
  replaceWith: string
}) => {
  const ast = parse(code, { sourceType: 'module' })

  traverse.default(ast, {
    ImportDeclaration(path) {
      if (path.node.source.value === specifier) {
        path.node.source.value = replaceWith
      }
    },
  })

  return {
    code: generate.default(ast, { retainLines: true }).code,
    map: null,
  }
}
