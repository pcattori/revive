import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { BinaryLike, createHash } from 'node:crypto'
import { RemixConfig, readConfig } from '@remix-run/dev/dist/config.js'
import { Manifest } from '@remix-run/dev/dist/manifest.js'
import { ServerBuild } from '@remix-run/server-runtime'
import {
  Plugin,
  Manifest as ViteManifest,
  ResolvedConfig as ResolvedViteConfig,
  normalizePath as viteNormalizePath,
  createServer as createViteDevServer,
  ViteDevServer,
  UserConfig as ViteUserConfig,
} from 'vite'
import jsesc from 'jsesc'

import { createRequestHandler } from './node/adapter.js'
import { getStylesForUrl, isCssModulesFile } from './styles.js'
import * as VirtualModule from './vmod.js'
import { removeExports } from './remove-exports.js'
import { transformLegacyCssImports } from './legacy-css-imports.js'
import { replaceImportSpecifier } from './replace-import-specifier.js'

export let serverEntryId = VirtualModule.id('server-entry')
let serverManifestId = VirtualModule.id('server-manifest')
let browserManifestId = VirtualModule.id('browser-manifest')
let remixReactProxyId = VirtualModule.id('remix-react-proxy')

const normalizePath = (p: string) => {
  let unixPath = p.replace(/[\\/]+/g, '/').replace(/^([a-zA-Z]+:|\.\/)/, '')
  return viteNormalizePath(unixPath)
}

const resolveFsUrl = (filePath: string) => `/@fs${normalizePath(filePath)}`

const isJsFile = (filePath: string) => /\.[cm]?[jt]sx?$/i.test(filePath)

type Route = RemixConfig['routes'][string]
const resolveRelativeRouteFilePath = (route: Route, config: RemixConfig) => {
  const file = route.file
  const fullPath = path.resolve(config.appDirectory, file)

  return normalizePath(fullPath)
}

const getServerEntry = (config: RemixConfig) => {
  return `
  import * as entryServer from ${JSON.stringify(
    resolveFsUrl(path.resolve(config.appDirectory, config.entryServerFile))
  )};
  ${Object.keys(config.routes)
    .map((key, index) => {
      const route = config.routes[key]!
      return `import * as route${index} from ${JSON.stringify(
        resolveFsUrl(resolveRelativeRouteFilePath(route, config))
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

const getRouteModuleExports = async (
  viteChildCompiler: ViteDevServer | null,
  config: RemixConfig,
  routeFile: string
): Promise<string[]> => {
  if (!viteChildCompiler) {
    throw new Error('Vite child compiler not found')
  }

  const routePath = path.join(config.appDirectory, routeFile)

  // Get the compiled route module code from the Vite child compiler so that we
  // can parse the exports from non-JS files like MDX. This ensures that we can
  // understand the exports from anything that Vite can compile to JS, not just
  // the route file formats that the Remix compiler historically supported.
  const compiledRouteModuleCode = (
    await viteChildCompiler.transformRequest(resolveFsUrl(routePath), {
      ssr: true,
    })
  )?.code

  if (!compiledRouteModuleCode) {
    throw new Error(`No route module code found for ${routePath}`)
  }

  // Match `Object.defineProperty(__vite_ssr_exports__, "loader", ...)`
  const exportsDefinePropertyMatches =
    compiledRouteModuleCode.match(
      /(?<=Object\.defineProperty\(__vite_ssr_exports__,\s*['"])(\w+)(?=['"])/g
    ) ?? []

  // Match `__vite_ssr_exports__.default = ...`
  const exportsAssignmentMatches =
    compiledRouteModuleCode.match(
      /(?<=__vite_ssr_exports__\.)(\w+)(?=\s*=\s*[^=])/g
    ) ?? []

  const routeModuleExports = [
    ...exportsDefinePropertyMatches,
    ...exportsAssignmentMatches,
  ]

  return routeModuleExports
}

const createBuildManifest = async (
  viteChildCompiler: ViteDevServer | null
): Promise<Manifest> => {
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
    const sourceExports = await getRouteModuleExports(
      viteChildCompiler,
      config,
      route.file
    )

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

const getDevManifest = async (
  viteChildCompiler: ViteDevServer | null
): Promise<Manifest> => {
  const config = await readConfig()
  const routes: Manifest['routes'] = {}

  for (const [key, route] of Object.entries(config.routes)) {
    const sourceExports = await getRouteModuleExports(
      viteChildCompiler,
      config,
      route.file
    )

    routes[key] = {
      id: route.id,
      parentId: route.parentId,
      path: route.path,
      index: route.index,
      caseSensitive: route.caseSensitive,
      module: `${resolveFsUrl(resolveRelativeRouteFilePath(route, config))}${
        isJsFile(route.file) ? '' : '?import' // Ensure the Vite dev server responds with a JS module
      }`,
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
      module: resolveFsUrl(
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
    | { isSsrBuild: true; getManifest: () => Promise<Manifest> }

  let viteChildCompiler: ViteDevServer | null = null
  let userConfig: ViteUserConfig

  return [
    {
      name: 'revive',
      config: (config) => {
        userConfig = config
        return { appType: 'custom' }
      },
      async configResolved(viteConfig) {
        command = viteConfig.command

        viteChildCompiler = await createViteDevServer({
          ...userConfig,
          plugins: [
            ...(userConfig.plugins ?? [])
              .flat()
              // Exclude this plugin from the child compiler to prevent an
              // infinite loop (plugin creates a child compiler with the same
              // plugin that creates another child compiler, repeat ad
              // infinitum), and to prevent the manifest from being written to
              // disk from the child compiler. This is important in the
              // production build because the child compiler is a Vite dev
              // server and will generate incorrect manifests.
              .filter(
                (plugin) =>
                  typeof plugin === 'object' &&
                  plugin !== null &&
                  'name' in plugin &&
                  plugin.name !== 'revive'
              ),
          ],
          configFile: false,
        })
        await viteChildCompiler.pluginContainer.buildStart({})

        ssrBuildContext =
          viteConfig.build.ssr && command === 'build'
            ? {
                isSsrBuild: true,
                getManifest: async () =>
                  await createBuildManifest(viteChildCompiler),
              }
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
      async buildEnd() {
        await viteChildCompiler?.close()
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
              ? await ssrBuildContext.getManifest()
              : await getDevManifest(viteChildCompiler)

            return `export default ${jsesc(manifest, { es6: true })};`
          }
          case VirtualModule.resolve(browserManifestId): {
            if (command === 'build') {
              throw new Error('This module only exists in development')
            }

            const manifest = await getDevManifest(viteChildCompiler)

            return `window.__remixManifest=${jsesc(manifest, { es6: true })};`
          }
        }
      },
    },
    {
      name: 'revive-empty-server-modules',
      enforce: 'pre',
      async transform(_code, id, options) {
        if (!options?.ssr && /\.server(\.[cm]?[jt]sx?)?$/.test(id))
          return {
            code: 'export default {}',
            map: null,
          }
      },
    },
    {
      name: 'revive-remove-server-exports',
      enforce: 'post', // Ensure we're operating on the transformed code to support MDX etc.
      async transform(code, id, options) {
        if (options?.ssr) return

        let config = await readConfig()

        // get route from vite module id (TODO: make this more efficient)
        if (!id.startsWith(config.appDirectory)) return
        let routePath = path.relative(config.appDirectory, id)
        let route = Object.values(config.routes).find(
          (r) => r.file === routePath
        )
        if (!route) return

        const routeExports = await getRouteModuleExports(
          viteChildCompiler,
          config,
          route.file
        )

        // ignore routes without component
        if (!routeExports.includes('default')) return

        return {
          code: removeExports(code, ['loader', 'action', 'headers']),
          map: null,
        }
      },
    },
    {
      name: 'revive-remix-react-proxy',
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
      load(id) {
        if (id === VirtualModule.resolve(remixReactProxyId)) {
          return [
            // LiveReload contents are coupled to the compiler in @remix-run/dev
            // so we replace it with a no-op component to prevent errors.
            'export * from "@remix-run/react";',
            'export const LiveReload = () => null;',
          ].join('\n')
        }
      },
    },
  ]
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
