import { ExportNamedDeclaration } from 'estree'
import { Plugin } from 'unified'
import { Literal, Root } from 'mdast'
import { parse as parseYaml } from 'yaml'
import { parse as parseToml } from 'toml'
import { valueToEstree } from 'estree-util-value-to-estree'

type FrontmatterParsers = Record<string, (value: string) => unknown>

export interface RemarkRemixMdxFrontmatterOptions {
  parsers?: FrontmatterParsers
}

const remarkRemixMdxFrontmatter: Plugin<
  [RemarkRemixMdxFrontmatterOptions?],
  Root
> = ({ parsers } = {}) => {
  const allParsers: FrontmatterParsers = {
    yaml: parseYaml,
    toml: parseToml,
    ...parsers,
  }

  return (rootNode, { basename = '' }) => {
    let attributes: unknown

    const node = rootNode.children.find(({ type }) =>
      Object.hasOwnProperty.call(allParsers, type)
    )

    if (node) {
      const parser = allParsers[node.type]
      attributes = parser((node as Literal).value)
    }

    const remixExports = ['headers', 'meta', 'handle'].filter((exportName) => {
      return (
        typeof attributes === 'object' &&
        attributes !== null &&
        exportName in attributes
      )
    })

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
                      name: 'attributes',
                    },
                    init: valueToEstree(attributes),
                  },
                ],
              },
            },
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
                      name: 'filename',
                    },
                    init: {
                      type: 'Literal',
                      value: basename,
                      raw: JSON.stringify(basename),
                    },
                  },
                ],
              },
            },
            ...remixExports.map(
              (exportName: string): ExportNamedDeclaration => ({
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
                        type: 'MemberExpression',
                        optional: false,
                        computed: false,
                        object: {
                          type: 'Identifier',
                          name: 'attributes',
                        },
                        property: {
                          type: 'Identifier',
                          name: exportName,
                        },
                      },
                    },
                  ],
                },
              })
            ),
          ],
        },
      },
    })
  }
}

export default remarkRemixMdxFrontmatter
