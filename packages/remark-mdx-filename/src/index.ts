import { Plugin } from 'unified'
import { Root } from 'mdast'

export interface RemarkMdxFilenameOptions {
  exportName?: string
}

export const remarkMdxFilename: Plugin<[RemarkMdxFilenameOptions?], any> = ({
  exportName = 'filename',
} = {}) => {
  return (rootNode: Root, { basename: filename = '' }) => {
    rootNode.children.unshift({
      type: 'mdxjsEsm',
      value: '',
      data: {
        estree: {
          type: 'Program',
          sourceType: 'module',
          body: [
            {
              type: 'ExportNamedDeclaration',
              specifiers: [],
              declaration: {
                type: 'VariableDeclaration',
                kind: 'const',
                declarations: [
                  {
                    type: 'VariableDeclarator',
                    id: {
                      type: 'Identifier',
                      name: exportName,
                    },
                    init: {
                      type: 'Literal',
                      value: filename,
                      raw: JSON.stringify(filename),
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    })
  }
}

export default remarkMdxFilename
