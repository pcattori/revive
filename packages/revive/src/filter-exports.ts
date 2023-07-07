import { parse } from '@babel/parser'
import generate from '@babel/generator'
import traverse from '@babel/traverse'
import * as t from '@babel/types'
import type { NodePath } from '@babel/traverse'
import type { types as BabelTypes } from '@babel/core'

export const filterExports = (
  _id: string,
  source: string,
  exports: string[]
) => {
  const document = parse(source, {
    sourceType: 'module',
    plugins: ['typescript', 'jsx'],
  })

  traverse.default(document, {
    ExportNamedDeclaration: (path) => {
      removeExports(path, exports)
    },
  })

  return {
    code: generate.default(document).code,
    map: null,
  }
}

function removeExports(
  path: NodePath<BabelTypes.ExportNamedDeclaration>,
  exports: string[]
) {
  const shouldRemoveExport = (exportName: string) =>
    !exports.includes(exportName)

  const specifiers = path.get(
    'specifiers'
  ) as NodePath<BabelTypes.ExportSpecifier>[]

  if (specifiers.length) {
    specifiers.forEach((specifier) => {
      const name = t.isIdentifier(specifier.node.exported)
        ? specifier.node.exported.name
        : specifier.node.exported.value
      if (shouldRemoveExport(name)) {
        specifier.remove()
      }
    })

    if (path.node.specifiers.length < 1) {
      path.remove()
    }
    return
  }

  const declaration = path.get('declaration') as NodePath<
    BabelTypes.FunctionDeclaration | BabelTypes.VariableDeclaration
  >
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!declaration.node) {
    return
  }

  switch (declaration.node.type) {
    case 'FunctionDeclaration': {
      const name = declaration.node.id!.name
      if (shouldRemoveExport(name)) {
        path.remove()
      }
      break
    }
    case 'VariableDeclaration': {
      const inner = declaration.get(
        'declarations'
      ) as NodePath<BabelTypes.VariableDeclarator>[]
      inner.forEach((d) => {
        if (d.node.id.type !== 'Identifier') {
          return
        }
        const name = d.node.id.name
        if (shouldRemoveExport(name)) {
          d.remove()
        }
      })
      break
    }
    default: {
      break
    }
  }
}
