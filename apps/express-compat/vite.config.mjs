import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import mdx from '@mdx-js/rollup'
import remarkFrontmatter from 'remark-frontmatter'
import remarkMdxFilename from 'remark-mdx-filename'
import remarkRemixMdxFrontmatter from 'remark-remix-mdx-frontmatter'
import { revive, legacyRemixCssImportSemantics } from 'revive'

import remixConfig from './remix.config.mjs'

export default defineConfig({
  plugins: [
    revive(remixConfig),
    legacyRemixCssImportSemantics(),
    tsconfigPaths(),
    mdx({
      remarkPlugins: [
        remarkFrontmatter,
        [remarkRemixMdxFrontmatter, { exportName: 'attributes' }],
        remarkMdxFilename,
      ],
    }),
  ],
})
