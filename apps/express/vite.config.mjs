import { defineConfig } from 'vite'
import mdx from '@mdx-js/rollup'
import remarkFrontmatter from 'remark-frontmatter'
import remarkMdxFilename from 'remark-mdx-filename'
import remarkRemixMdxFrontmatter from 'remark-remix-mdx-frontmatter'
import { revive, legacyRemixCssImportSemantics } from 'revive'

export default defineConfig({
  plugins: [
    revive(),
    legacyRemixCssImportSemantics(),
    mdx({
      remarkPlugins: [
        remarkFrontmatter,
        remarkRemixMdxFrontmatter,
        remarkMdxFilename,
      ],
    }),
  ],
})
