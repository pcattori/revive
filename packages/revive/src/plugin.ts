import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { BinaryLike, createHash } from 'node:crypto'
import { RemixConfig, readConfig } from '@remix-run/dev/dist/config.js'
import { Manifest } from '@remix-run/dev/dist/manifest.js'
import { ServerBuild } from '@remix-run/server-runtime'
import { getRouteModuleExports } from '@remix-run/dev/dist/compiler/utils/routeExports.js'
import {
  Plugin,
  Manifest as ViteManifest,
  ResolvedConfig as ResolvedViteConfig,
  normalizePath as viteNormalizePath,
} from 'vite'
import jsesc from 'jsesc'
import babel from '@babel/core'

import { createRequestHandler } from './node/adapter.js'
import { getStylesForUrl, isCssModulesFile } from './styles.js'
import * as VirtualModule from './vmod.js'
import { filterExports } from './filter-exports.js'
import { transformLegacyCssImports } from './legacy-css-imports.js'
import { replaceImportSpecifier } from './replace-import-specifier.js'

export let serverEntryId = VirtualModule.id('server-entry')
let serverManifestId = VirtualModule.id('server-manifest')
let browserManifestId = VirtualModule.id('browser-manifest')
let remixReactProxyId = VirtualModule.id('remix-react-proxy')
let hmrRuntimeId = VirtualModule.id('hmr-runtime')

const normalizePath = (p: string) => {
  let unixPath = p.replace(/[\\/]+/g, '/').replace(/^([a-zA-Z]+:|\.\/)/, '')
  return viteNormalizePath(unixPath)
}

const resolveFSPath = (filePath: string) => `/@fs${normalizePath(filePath)}`

type Route = RemixConfig['routes'][string]
const resolveRelativeRouteFilePath = (route: Route, config: RemixConfig) => {
  const file = route.file
  const fullPath = path.resolve(config.appDirectory, file)

  return normalizePath(fullPath)
}

const getServerEntry = (config: RemixConfig) => {
  return `
  import * as entryServer from ${JSON.stringify(
    resolveFSPath(path.resolve(config.appDirectory, config.entryServerFile))
  )};
  ${Object.keys(config.routes)
    .map((key, index) => {
      const route = config.routes[key]!
      return `import * as route${index} from ${JSON.stringify(
        resolveFSPath(resolveRelativeRouteFilePath(route, config))
      )};`
    })
    .join('\n')}
    export { default as assets } from ${JSON.stringify(serverManifestId)};
    export const assetsBuildDirectory = ${JSON.stringify(
      config.relativeAssetsBuildDirectory
    )};
    ${
      config.future
        ? `export const future = ${JSON.stringify(config.future)}`
        : ''
    };
    export const publicPath = ${JSON.stringify(config.publicPath)};
    export const entry = { module: entryServer };
    export const routes = {
      ${Object.keys(config.routes)
        .map((key, index) => {
          const route = config.routes[key]!
          return `${JSON.stringify(key)}: {
        id: ${JSON.stringify(route.id)},
        parentId: ${JSON.stringify(route.parentId)},
        path: ${JSON.stringify(route.path)},
        index: ${JSON.stringify(route.index)},
        caseSensitive: ${JSON.stringify(route.caseSensitive)},
        module: route${index}
      }`
        })
        .join(',\n  ')}
    };`
}

let vmods = [serverEntryId, serverManifestId, browserManifestId]

const getHash = (source: BinaryLike, maxLength?: number): string => {
  const hash = createHash('sha256').update(source).digest('hex')
  return typeof maxLength === 'number' ? hash.slice(0, maxLength) : hash
}

const resolveBuildAssetPaths = (
  config: RemixConfig,
  manifest: ViteManifest,
  appRelativePath: string
): Manifest['entry'] & { css: string[] } => {
  const appPath = path.relative(process.cwd(), config.appDirectory)
  const manifestKey = normalizePath(path.join(appPath, appRelativePath))
  const manifestEntry = manifest[manifestKey]
  return {
    module: `${config.publicPath}${manifestEntry.file}`,
    imports:
      manifestEntry.imports?.map((imported) => {
        return `${config.publicPath}${manifest[imported].file}`
      }) ?? [],
    css:
      manifestEntry.css?.map((href) => {
        return `${config.publicPath}${href}`
      }) ?? [],
  }
}

const writeFileSafe = async (file: string, contents: string): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, contents)
}

const createBuildManifest = async (): Promise<Manifest> => {
  const config = await readConfig()
  const viteManifest = JSON.parse(
    await fs.readFile(
      path.resolve(config.assetsBuildDirectory, 'manifest.json'),
      'utf-8'
    )
  ) as ViteManifest

  const entry: Manifest['entry'] = resolveBuildAssetPaths(
    config,
    viteManifest,
    config.entryClientFile
  )

  const routes: Manifest['routes'] = {}
  for (const [key, route] of Object.entries(config.routes)) {
    const sourceExports = await getRouteModuleExports(config, route.id)

    routes[key] = {
      id: route.id,
      parentId: route.parentId,
      path: route.path,
      index: route.index,
      caseSensitive: route.caseSensitive,
      hasAction: sourceExports.includes('action'),
      hasLoader: sourceExports.includes('loader'),
      hasErrorBoundary: sourceExports.includes('ErrorBoundary'),
      ...resolveBuildAssetPaths(config, viteManifest, route.file),
    }
  }

  const fingerprintedValues = { entry, routes }
  const version = getHash(JSON.stringify(fingerprintedValues), 8)
  const manifestFilename = `manifest-${version}.js`
  const url = `${config.publicPath}${manifestFilename}`
  const nonFingerprintedValues = { url, version }

  const manifest: Manifest = {
    ...fingerprintedValues,
    ...nonFingerprintedValues,
  }

  await writeFileSafe(
    path.join(config.assetsBuildDirectory, manifestFilename),
    `window.__remixManifest=${JSON.stringify(manifest)};`
  )

  return manifest
}

const getDevManifest = async (): Promise<Manifest> => {
  const config = await readConfig()
  const routes: Manifest['routes'] = {}

  for (const [key, route] of Object.entries(config.routes)) {
    const sourceExports = await getRouteModuleExports(config, route.id)

    routes[key] = {
      id: route.id,
      parentId: route.parentId,
      path: route.path,
      index: route.index,
      caseSensitive: route.caseSensitive,
      module: resolveFSPath(resolveRelativeRouteFilePath(route, config)),
      hasAction: sourceExports.includes('action'),
      hasLoader: sourceExports.includes('loader'),
      hasErrorBoundary: sourceExports.includes('ErrorBoundary'),
      imports: [],
    }
  }

  return {
    version: String(Math.random()),
    url: VirtualModule.url(browserManifestId),
    entry: {
      module: resolveFSPath(
        path.resolve(config.appDirectory, config.entryClientFile)
      ),
      imports: [],
    },
    routes,
  }
}

export let revive: () => Plugin[] = () => {
  let command: ResolvedViteConfig['command']
  let cssModulesManifest: Record<string, string> = {}
  let ssrBuildContext:
    | { isSsrBuild: false }
    | { isSsrBuild: true; manifest: Manifest }

  return [
    {
      name: 'revive',
      config: () => ({
        appType: 'custom',
        experimental: { hmrPartialAccept: true },
      }),
      async configResolved(viteConfig) {
        command = viteConfig.command

        ssrBuildContext =
          viteConfig.build.ssr && command === 'build'
            ? { isSsrBuild: true, manifest: await createBuildManifest() }
            : { isSsrBuild: false }
      },
      transform(code, id) {
        if (isCssModulesFile(id)) {
          cssModulesManifest[id] = code
        }
      },
      configureServer(vite) {
        return () => {
          vite.middlewares.use(async (req, res, next) => {
            try {
              // Invalidate all virtual modules
              vmods.forEach((vmod) => {
                const mod = vite.moduleGraph.getModuleById(
                  VirtualModule.resolve(vmod)
                )

                if (mod) {
                  vite.moduleGraph.invalidateModule(mod)
                }
              })

              const { url } = req
              const [config, build] = await Promise.all([
                readConfig(),
                vite.ssrLoadModule(serverEntryId) as Promise<ServerBuild>,
              ])

              // Allow critical CSS to be served to apps in another process
              if (url?.startsWith('/_critical.css?pathname=')) {
                const pathname = url.split('?pathname=')[1]
                res.setHeader('Content-Type', 'text/css')
                res.end(
                  await getStylesForUrl(
                    vite,
                    config,
                    cssModulesManifest,
                    build,
                    pathname
                  )
                )
                return
              }

              const handle = createRequestHandler(build, {
                mode: 'development',
                criticalStyles: await getStylesForUrl(
                  vite,
                  config,
                  cssModulesManifest,
                  build,
                  url
                ),
              })

              await handle(req, res)
            } catch (error) {
              next(error)
            }
          })
        }
      },
    },
    {
      name: 'revive-config',
      enforce: 'pre',
      config: () => ({
        define: {
          'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV),
        },
      }),
    },
    {
      name: 'revive-virtual-modules',
      enforce: 'pre',
      resolveId(id) {
        if (vmods.includes(id)) return VirtualModule.resolve(id)
      },
      async load(id) {
        switch (id) {
          case VirtualModule.resolve(serverEntryId): {
            const config = await readConfig()
            return getServerEntry(config)
          }
          case VirtualModule.resolve(serverManifestId): {
            const manifest = ssrBuildContext.isSsrBuild
              ? ssrBuildContext.manifest
              : await getDevManifest()

            return `export default ${jsesc(manifest, { es6: true })};`
          }
          case VirtualModule.resolve(browserManifestId): {
            if (command === 'build') {
              throw new Error('This module only exists in development')
            }

            const manifest = await getDevManifest()

            return `window.__remixManifest=${jsesc(manifest, { es6: true })};`
          }
        }
      },
    },
    {
      name: 'revive-browser-filter',
      enforce: 'pre',
      async transform(code, id, options) {
        if (options?.ssr) return

        // ignore server files
        if (/\.server(\.[jt]sx?)?$/.test(id)) return 'export default {}'

        let config = await readConfig()

        // get route from vite module id (TODO: make this more efficient)
        if (!id.startsWith(config.appDirectory)) return
        let routePath = path.relative(config.appDirectory, id)
        let route = Object.values(config.routes).find(
          (r) => r.file === routePath
        )
        if (!route) return

        const routeExports = await getRouteModuleExports(config, route.id)

        // ignore routes without component
        if (!routeExports.includes('default')) return

        let browserExports = routeExports.filter(
          (x) => !['loader', 'action'].includes(x)
        )

        // ignore routes without browser exports
        if (browserExports.length === 0) return

        const filtered = filterExports(id, code, browserExports)
        const result = filtered.code

        return {
          code: result,
          map: null,
        }
      },
    },
    {
      name: 'revive-remix-react-proxy',
      enforce: 'pre',
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
        if (
          !code.includes('@remix-run/react') &&
          !code.includes('LiveReload')
        ) {
          return
        }

        // Rewrite imports to use the proxy
        return replaceImportSpecifier({
          code,
          specifier: '@remix-run/react',
          replaceWith: remixReactProxyId,
        })
      },
      async load(id) {
        if (id === VirtualModule.resolve(remixReactProxyId)) {
          // TODO: probably need a Script component that manages the order of the dev scripts relative to prod scripts
          return [
            // LiveReload contents are coupled to the compiler in @remix-run/dev
            // so we replace it to prevent errors.
            'import { createElement } from "react";',
            'export * from "@remix-run/react";',
            'export const LiveReload = process.env.NODE_ENV !== "development" ? () => null : ',
            '() => createElement("script", {',
            ' type: "module",',
            ' suppressHydrationWarning: true,',
            ' dangerouslySetInnerHTML: { __html: `',
            `   import RefreshRuntime from "${VirtualModule.url(
              hmrRuntimeId
            )}"`,
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
        const _require = createRequire(import.meta.url)
        const reactRefreshDir = path.dirname(
          _require.resolve('react-refresh/package.json')
        )
        const runtimeFilePath = path.join(
          reactRefreshDir,
          'cjs/react-refresh-runtime.development.js'
        )
        if (id !== VirtualModule.resolve(hmrRuntimeId)) return
        return [
          'const exports = {}',
          await fs.readFile(runtimeFilePath, 'utf-8'),
          await fs.readFile(_require.resolve('./refresh-utils.cjs'), 'utf-8'),
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

        const plugins = []
        if (useFastRefresh) {
          plugins.push('react-refresh/babel')
        }

        const result = await babel.transformAsync(code, {
          filename: id,
          sourceFileName: filepath,
          parserOpts: {
            sourceType: 'module',
            allowAwaitOutsideFunction: true,
            plugins: ['jsx', 'typescript'],
          },
          plugins,
          sourceMaps: true,
        })

        if (result) {
          let code = result.code!
          if (useFastRefresh && /\$Refresh(?:Reg|Sig)\$\(/.test(code)) {
            code = addRefreshWrapper(code, id)
          }
          return { code, map: result.map }
        }
      },
    },
  ]
}

const header = `
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

const footer = `
if (import.meta.hot && !inWebWorker) {
  window.$RefreshReg$ = prevRefreshReg;
  window.$RefreshSig$ = prevRefreshSig;

  RefreshRuntime.__hmr_import(import.meta.url).then((currentExports) => {
    RefreshRuntime.registerExportsForReactRefresh(__SOURCE__, currentExports);
    // TODO: accept exports that are Remix exports that eventually make it into a component via Route
    // eg links -> <Links />
    // eg meta -> <Meta />
    import.meta.hot.acceptExports(["default", "meta"], () => {
      RefreshRuntime.enqueueUpdate();
    });
  });
}`

function addRefreshWrapper(code: string, id: string): string {
  return (
    header.replace('__SOURCE__', JSON.stringify(id)) +
    code +
    footer.replace('__SOURCE__', JSON.stringify(id))
  )
}

export let legacyRemixCssImportSemantics: () => Plugin[] = () => {
  return [
    {
      name: 'revive-legacy-remix-css-import-semantics',
      enforce: 'pre',
      transform(code) {
        if (code.includes('.css"') || code.includes(".css'")) {
          return transformLegacyCssImports(code)
        }
      },
    },
  ]
}
