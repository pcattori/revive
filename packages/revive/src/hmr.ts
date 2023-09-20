import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import * as path from 'node:path'

import babel from '@babel/core'
import { type Plugin } from 'vite'

import * as VirtualModule from './vmod.js'
import { replaceImportSpecifier } from './replace-import-specifier.js'

const _require = createRequire(import.meta.url)

const reactRefreshDir = path.dirname(
  _require.resolve('react-refresh/package.json')
)
const runtimeFilePath = path.join(
  reactRefreshDir,
  'cjs/react-refresh-runtime.development.js'
)

let remixReactProxyId = VirtualModule.id('remix-react-proxy')
let hmrRuntimeId = VirtualModule.id('hmr-runtime')

export const plugins: Plugin[] = [
  {
    name: 'revive-hmr-livereload',
    enforce: 'post', // Ensure we're operating on the transformed code to support MDX etc.
    resolveId(id) {
      if (id === remixReactProxyId) {
        return VirtualModule.resolve(remixReactProxyId)
      }
    },
    transform(code, id) {
      // Don't transform the proxy itself, otherwise it will import itself
      if (id === VirtualModule.resolve(remixReactProxyId)) {
        return
      }

      // Don't transform files that don't need the proxy
      if (!code.includes('@remix-run/react') && !code.includes('LiveReload')) {
        return
      }

      // Rewrite imports to use the proxy
      return replaceImportSpecifier({
        code,
        specifier: '@remix-run/react',
        replaceWith: remixReactProxyId,
      })
    },
    load(id) {
      if (id === VirtualModule.resolve(remixReactProxyId)) {
        return [
          'import { createElement } from "react";',
          'export * from "@remix-run/react";',
          'export const LiveReload = process.env.NODE_ENV !== "development" ? () => null : ',
          '() => createElement("script", {',
          ' type: "module",',
          ' suppressHydrationWarning: true,',
          ' dangerouslySetInnerHTML: { __html: `',
          `   import RefreshRuntime from "${VirtualModule.url(hmrRuntimeId)}"`,
          '   RefreshRuntime.injectIntoGlobalHook(window)',
          '   window.$RefreshReg$ = () => {}',
          '   window.$RefreshSig$ = () => (type) => type',
          '   window.__vite_plugin_react_preamble_installed__ = true',
          ' `}',
          '});',
        ].join('\n')
      }
    },
  },
  {
    name: 'revive-hmr-runtime',
    enforce: 'pre',
    resolveId(id) {
      if (id === hmrRuntimeId) return VirtualModule.resolve(hmrRuntimeId)
    },
    async load(id) {
      if (id !== VirtualModule.resolve(hmrRuntimeId)) return
      return [
        'const exports = {}',
        await fs.readFile(runtimeFilePath, 'utf8'),
        'export default exports',
      ].join('\n')
    },
  },
  {
    name: 'revive-react-refresh-babel',
    enforce: 'pre',
    async transform(code, id, options) {
      if (id.includes('/node_modules/')) return

      const [filepath] = id.split('?')
      if (!/.[tj]sx?$/.test(filepath)) return

      const devRuntime = 'react/jsx-dev-runtime'
      const ssr = options?.ssr === true
      const isJSX = filepath.endsWith('x')
      const useFastRefresh = !ssr && (isJSX || code.includes(devRuntime))
      if (!useFastRefresh) return

      const result = await babel.transformAsync(code, {
        filename: id,
        sourceFileName: filepath,
        parserOpts: {
          sourceType: 'module',
          allowAwaitOutsideFunction: true,
          plugins: ['jsx', 'typescript'],
        },
        plugins: ['react-refresh/babel'],
        sourceMaps: true,
      })
      if (result === null) return

      code = result.code!
      const refreshContentRE = /\$Refresh(?:Reg|Sig)\$\(/
      if (refreshContentRE.test(code)) {
        code = addRefreshWrapper(code, id)
      }
      return { code, map: result.map }
    },
  },
]

function addRefreshWrapper(code: string, id: string): string {
  // TODO
  return code
}
