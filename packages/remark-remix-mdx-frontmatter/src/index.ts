import { ExportNamedDeclaration } from 'estree'
import { Plugin } from 'unified'
import { Literal, Root } from 'mdast'
import { parse as parseYaml } from 'yaml'
import { parse as parseToml } from 'toml'
import { valueToEstree } from 'estree-util-value-to-estree'

type FrontmatterParsers = Record<string, (value: string) => unknown>

export interface RemarkRemixMdxFrontmatterOptions {
  exportName?: string
  parsers?: FrontmatterParsers
}

export const remarkRemixMdxFrontmatter: Plugin<
  [RemarkRemixMdxFrontmatterOptions?],
  Root
> = ({ exportName: frontmatterExportName = 'attributes', parsers } = {}) => {
  const allParsers: FrontmatterParsers = {
    yaml: parseYaml,
    toml: parseToml,
    ...parsers,
  }

  return (rootNode, { basename = '' }) => {
    let frontmatter: unknown

    const node = rootNode.children.find(({ type }) =>
      Object.hasOwnProperty.call(allParsers, type)
    )

    if (node) {
      const parser = allParsers[node.type]
      frontmatter = parser((node as Literal).value)
    }

    const frontmatterHasKey = (key: string): boolean =>
      typeof frontmatter === 'object' &&
      frontmatter !== null &&
      key in frontmatter

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
                      name: frontmatterExportName,
                    },
                    init: valueToEstree(frontmatter),
                  },
                ],
              },
            },
            ...['headers', 'meta', 'handle'].filter(frontmatterHasKey).map(
              (remixExportName: string): ExportNamedDeclaration => ({
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
                        name: remixExportName,
                      },
                      init: {
                        type: 'MemberExpression',
                        optional: false,
                        computed: false,
                        object: {
                          type: 'Identifier',
                          name: frontmatterExportName,
                        },
                        property: {
                          type: 'Identifier',
                          name: remixExportName,
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
