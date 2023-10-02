import { defineConfig } from 'vite'
import mdx from '@mdx-js/rollup'
import remarkFrontmatter from 'remark-frontmatter'
import remarkRemixMdxFrontmatter from 'remark-remix-mdx-frontmatter'
import { revive } from 'revive'

export default defineConfig({
  // do not pre-bundle @remix-run/react so we can patch it in via `LOCAL_BUILD_DIRECTORY` from the remix-run/remix repo
  optimizeDeps: {
    exclude: ['@remix-run/react'],
  },
  plugins: [
    revive(),
    mdx({
      remarkPlugins: [remarkFrontmatter, remarkRemixMdxFrontmatter],
    }),
  ],
})
