import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import * as path from 'node:path'

import babel from '@babel/core'
import { ViteDevServer, type Plugin } from 'vite'
import { RemixConfig, readConfig } from '@remix-run/dev/dist/config.js'

import * as VirtualModule from './vmod.js'
import { replaceImportSpecifier } from './replace-import-specifier.js'
import {
  getRouteModuleExports,
  resolveFsUrl,
  resolveRelativeRouteFilePath,
} from './utils.js'

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

export const plugins = (refs: {
  viteChildCompiler: ViteDevServer | null
}): Plugin[] => [
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
        await fs.readFile(_require.resolve('./refresh-utils.cjs'), 'utf8'),
        'export default exports',
      ].join('\n')
    },
    async handleHotUpdate({ server, file, modules }) {
      let config = await readConfig()
      if (!file.startsWith(config.appDirectory)) return
      let routePath = path.relative(config.appDirectory, file)
      let route = Object.values(config.routes).find((r) => r.file === routePath)
      if (!route) return modules

      const sourceExports = await getRouteModuleExports(
        refs.viteChildCompiler,
        config,
        route.file
      )

      let info = {
        id: route.id,
        parentId: route.parentId,
        path: route.path,
        index: route.index,
        caseSensitive: route.caseSensitive,
        module: `${resolveFsUrl(
          resolveRelativeRouteFilePath(route, config)
        )}?import`, // Ensure the Vite dev server responds with a JS module
        hasAction: sourceExports.includes('action'),
        hasLoader: sourceExports.includes('loader'),
        hasErrorBoundary: sourceExports.includes('ErrorBoundary'),
        imports: [],
      }

      server.ws.send({
        type: 'custom',
        event: 'revive:hmr',
        data: {
          route: info,
        },
      })
      return modules
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
        code = await addRefreshWrapper(code, id)
      }
      return { code, map: result.map }
    },
  },
]

function isRoute(config: RemixConfig, id: string): boolean {
  if (!id.startsWith(config.appDirectory)) return false
  let routePath = path.relative(config.appDirectory, id)
  let route = Object.values(config.routes).find((r) => r.file === routePath)
  return route !== undefined
}

async function addRefreshWrapper(code: string, id: string): Promise<string> {
  let config = await readConfig()
  let footer = isRoute(config, id) ? FOOTER : NON_ROUTE_FOOTER
  return (
    HEADER.replace('__SOURCE__', JSON.stringify(id)) +
    code +
    footer.replace('__SOURCE__', JSON.stringify(id))
  )
}

const HEADER = `
import RefreshRuntime from "${hmrRuntimeId}";

const inWebWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
let prevRefreshReg;
let prevRefreshSig;

if (import.meta.hot && !inWebWorker) {
  if (!window.__vite_plugin_react_preamble_installed__) {
    throw new Error(
      "@vitejs/plugin-react can't detect preamble. Something is wrong. " +
      "See https://github.com/vitejs/vite-plugin-react/pull/11#discussion_r430879201"
    );
  }

  prevRefreshReg = window.$RefreshReg$;
  prevRefreshSig = window.$RefreshSig$;
  window.$RefreshReg$ = (type, id) => {
    RefreshRuntime.register(type, __SOURCE__ + " " + id)
  };
  window.$RefreshSig$ = RefreshRuntime.createSignatureFunctionForTransform;
}`.replace(/\n+/g, '')

const FOOTER = `
if (import.meta.hot && !inWebWorker) {
  window.$RefreshReg$ = prevRefreshReg;
  window.$RefreshSig$ = prevRefreshSig;

  RefreshRuntime.__hmr_import(import.meta.url).then((currentExports) => {
    RefreshRuntime.registerExportsForReactRefresh(__SOURCE__, currentExports);
    // TODO: dynamically accept component exports
    import.meta.hot.acceptExports(["default", "headers", "links", "meta"]);
  });
}`

// TODO: use acceptExports for component exports in non-route files
// handle Remix exports (meta,links,headers) only for route files
const NON_ROUTE_FOOTER = `
if (import.meta.hot && !inWebWorker) {
  window.$RefreshReg$ = prevRefreshReg;
  window.$RefreshSig$ = prevRefreshSig;

  RefreshRuntime.__hmr_import(import.meta.url).then((currentExports) => {
    RefreshRuntime.registerExportsForReactRefresh(__SOURCE__, currentExports);
    import.meta.hot.acceptExports(["default", "headers", "links", "meta"], (nextExports) => {
      if (!nextExports) return;
      for (let xport of ["headers", "links", "meta"]) {
        if (!RefreshRuntime.isSameFunction(currentExports[xport], nextExports[xport])) {
          return import.meta.hot.invalidate();
        }
      }
      RefreshRuntime.enqueueUpdate();
    });
  });
}`
