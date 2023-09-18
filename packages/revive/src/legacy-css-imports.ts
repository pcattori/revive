import { parse } from '@babel/parser'
import generate from '@babel/generator'
import traverse from '@babel/traverse'
import { isImportDefaultSpecifier } from '@babel/types'

export const transformLegacyCssImports = (source: string) => {
  const ast = parse(source, {
    sourceType: 'module',
    plugins: ['typescript', 'jsx'],
  })

  traverse.default(ast, {
    // Handle `import styles from "./styles.css"`
    ImportDeclaration(path) {
      if (
        path.node.source.value.endsWith('.css') &&
        // CSS Modules are bundled in the Remix compiler so they're already
        // compatible with Vite's default CSS handling
        !path.node.source.value.endsWith('.module.css') &&
        isImportDefaultSpecifier(path.node.specifiers[0])
      ) {
        path.node.source.value += '?url'
      }
    },
  })

  return {
    code: generate.default(ast, { retainLines: true }).code,
    map: null,
  }
}
