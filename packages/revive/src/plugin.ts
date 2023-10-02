import { BinaryLike, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { existsSync as fsExistsSync } from 'node:fs'
import { execSync } from 'node:child_process'

import babel from '@babel/core'
import PackageJson from '@npmcli/package-json'
import {
  AppConfig as RemixUserConfig,
  RemixConfig as ResolvedRemixConfig,
} from '@remix-run/dev/dist/config.js'
import {
  defineRoutes,
  RouteManifest,
} from '@remix-run/dev/dist/config/routes.js'
import { Manifest } from '@remix-run/dev/dist/manifest.js'
import { flatRoutes } from '@remix-run/dev/dist/config/flat-routes.js'
import { detectPackageManager } from '@remix-run/dev/dist/cli/detectPackageManager.js'
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
import {
  init as initEsModuleLexer,
  parse as esModuleLexer,
} from 'es-module-lexer'
import jsesc from 'jsesc'

import { createRequestHandler } from './node/adapter.js'
import { getStylesForUrl, isCssModulesFile } from './styles.js'
import * as VirtualModule from './vmod.js'
import { removeExports } from './remove-exports.js'
import { transformLegacyCssImports } from './legacy-css-imports.js'
import { replaceImportSpecifier } from './replace-import-specifier.js'

export type RevivePluginOptions = Pick<
  RemixUserConfig,
  | 'appDirectory'
  | 'assetsBuildDirectory'
  | 'ignoredRouteFiles'
  | 'publicPath'
  | 'routes'
  | 'serverBuildPath'
  | 'serverModuleFormat'
>

type ResolvedReviveConfig = Pick<
  ResolvedRemixConfig,
  | 'appDirectory'
  | 'assetsBuildDirectory'
  | 'entryClientFile'
  | 'entryServerFile'
  | 'future'
  | 'publicPath'
  | 'relativeAssetsBuildDirectory'
  | 'routes'
  | 'serverBuildPath'
  | 'serverModuleFormat'
>

let serverEntryId = VirtualModule.id('server-entry')
let serverManifestId = VirtualModule.id('server-manifest')
let browserManifestId = VirtualModule.id('browser-manifest')
let remixReactProxyId = VirtualModule.id('remix-react-proxy')
let hmrRuntimeId = VirtualModule.id('hmr-runtime')

const _require = createRequire(import.meta.url)

const normalizePath = (p: string) => {
  let unixPath = p.replace(/[\\/]+/g, '/').replace(/^([a-zA-Z]+:|\.\/)/, '')
  return viteNormalizePath(unixPath)
}

const resolveFsUrl = (filePath: string) => `/@fs${normalizePath(filePath)}`

const isJsFile = (filePath: string) => /\.[cm]?[jt]sx?$/i.test(filePath)

type Route = RouteManifest[string]
const resolveRelativeRouteFilePath = (
  route: Route,
  reviveConfig: ResolvedReviveConfig
) => {
  const file = route.file
  const fullPath = path.resolve(reviveConfig.appDirectory, file)

  return normalizePath(fullPath)
}

let vmods = [serverEntryId, serverManifestId, browserManifestId]

const getHash = (source: BinaryLike, maxLength?: number): string => {
  const hash = createHash('sha256').update(source).digest('hex')
  return typeof maxLength === 'number' ? hash.slice(0, maxLength) : hash
}

const resolveBuildAssetPaths = (
  reviveConfig: ResolvedReviveConfig,
  manifest: ViteManifest,
  appRelativePath: string
): Manifest['entry'] & { css: string[] } => {
  const appPath = path.relative(process.cwd(), reviveConfig.appDirectory)
  const manifestKey = normalizePath(path.join(appPath, appRelativePath))
  const manifestEntry = manifest[manifestKey]
  return {
    module: `${reviveConfig.publicPath}${manifestEntry.file}`,
    imports:
      manifestEntry.imports?.map((imported) => {
        return `${reviveConfig.publicPath}${manifest[imported].file}`
      }) ?? [],
    css:
      manifestEntry.css?.map((href) => {
        return `${reviveConfig.publicPath}${href}`
      }) ?? [],
  }
}

const writeFileSafe = async (file: string, contents: string): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, contents)
}

const getRouteModuleExports = async (
  viteChildCompiler: ViteDevServer | null,
  reviveConfig: ResolvedReviveConfig,
  routeFile: string
): Promise<string[]> => {
  if (!viteChildCompiler) {
    throw new Error('Vite child compiler not found')
  }

  // We transform the route module code with the Vite child compiler so that we
  // can parse the exports from non-JS files like MDX. This ensures that we can
  // understand the exports from anything that Vite can compile to JS, not just
  // the route file formats that the Remix compiler historically supported.

  const ssr = true
  const { pluginContainer, moduleGraph } = viteChildCompiler
  const routePath = path.join(reviveConfig.appDirectory, routeFile)
  const url = resolveFsUrl(routePath)

  const resolveId = async () => {
    const result = await pluginContainer.resolveId(url, undefined, { ssr })
    if (!result) throw new Error(`Could not resolve module ID for ${url}`)
    return result.id
  }

  const [id, code] = await Promise.all([
    resolveId(),
    fs.readFile(routePath, 'utf-8'),
    // pluginContainer.transform(...) fails if we don't do this first:
    moduleGraph.ensureEntryFromUrl(url, ssr),
  ])

  const transformed = await pluginContainer.transform(code, id, { ssr })
  const [_imports, exports] = esModuleLexer(transformed.code)
  const exportNames = exports.map((e) => e.n)

  return exportNames
}

const entryExts = ['.js', '.jsx', '.ts', '.tsx']
const findEntry = (dir: string, basename: string): string | undefined => {
  for (let ext of entryExts) {
    let file = path.resolve(dir, basename + ext)
    if (fsExistsSync(file)) return path.relative(dir, file)
  }

  return undefined
}

const addTrailingSlash = (path: string): string =>
  path.endsWith('/') ? path : path + '/'

export let revive: (options?: RevivePluginOptions) => Plugin[] = (
  options = {}
) => {
  let viteCommand: ResolvedViteConfig['command']
  let viteUserConfig: ViteUserConfig

  let cssModulesManifest: Record<string, string> = {}
  let ssrBuildContext:
    | { isSsrBuild: false }
    | { isSsrBuild: true; getManifest: () => Promise<Manifest> }

  let viteChildCompiler: ViteDevServer | null = null

  const resolveReviveConfig = async (): Promise<ResolvedReviveConfig> => {
    const rootDirectory = viteUserConfig.root ?? process.cwd()
    const appDirectory = path.resolve(
      rootDirectory,
      options.appDirectory ?? 'app'
    )
    const serverBuildPath = path.resolve(
      rootDirectory,
      options.serverBuildPath ?? 'build/index.js'
    )
    const serverModuleFormat = options.serverModuleFormat ?? 'esm'
    const relativeAssetsBuildDirectory =
      options.assetsBuildDirectory ?? path.join('public', 'build')
    const assetsBuildDirectory = path.resolve(
      rootDirectory,
      relativeAssetsBuildDirectory
    )

    const userEntryClientFile = findEntry(appDirectory, 'entry.client')
    const entryClientFile = userEntryClientFile ?? 'entry.client.tsx'

    const userEntryServerFile = findEntry(appDirectory, 'entry.server')
    let entryServerFile: string

    let pkgJson = await PackageJson.load(rootDirectory)
    let deps = pkgJson.content.dependencies ?? {}

    if (userEntryServerFile) {
      entryServerFile = userEntryServerFile
    } else {
      let serverRuntime = deps['@remix-run/deno']
        ? 'deno'
        : deps['@remix-run/cloudflare']
        ? 'cloudflare'
        : deps['@remix-run/node']
        ? 'node'
        : undefined

      if (!serverRuntime) {
        let serverRuntimes = [
          '@remix-run/deno',
          '@remix-run/cloudflare',
          '@remix-run/node',
        ]
        let disjunctionListFormat = new Intl.ListFormat('en', {
          style: 'long',
          type: 'disjunction',
        })
        let formattedList = disjunctionListFormat.format(serverRuntimes)
        throw new Error(
          `Could not determine server runtime. Please install one of the following: ${formattedList}`
        )
      }

      if (!deps['isbot']) {
        console.log(
          'adding `isbot` to your package.json, you should commit this change'
        )

        pkgJson.update({
          dependencies: {
            ...pkgJson.content.dependencies,
            isbot: 'latest',
          },
        })

        await pkgJson.save()

        let packageManager = detectPackageManager() ?? 'npm'

        execSync(`${packageManager} install`, {
          cwd: rootDirectory,
          stdio: 'inherit',
        })
      }

      entryServerFile = `entry.server.${serverRuntime}.tsx`
    }

    const publicPath = addTrailingSlash(options.publicPath ?? '/build/')

    const rootRouteFile = findEntry(appDirectory, 'root')
    if (!rootRouteFile) {
      throw new Error(`Missing "root" route file in ${appDirectory}`)
    }

    const routes: RouteManifest = {
      root: { path: '', id: 'root', file: rootRouteFile },
    }

    if (fsExistsSync(path.resolve(appDirectory, 'routes'))) {
      const fileRoutes = flatRoutes(appDirectory, options.ignoredRouteFiles)
      for (const route of Object.values(fileRoutes)) {
        routes[route.id] = { ...route, parentId: route.parentId || 'root' }
      }
    }
    if (options.routes) {
      const manualRoutes = await options.routes(defineRoutes)
      for (const route of Object.values(manualRoutes)) {
        routes[route.id] = { ...route, parentId: route.parentId || 'root' }
      }
    }

    return {
      appDirectory,
      assetsBuildDirectory,
      entryClientFile,
      publicPath,
      routes,
      entryServerFile,
      serverBuildPath,
      serverModuleFormat,
      relativeAssetsBuildDirectory,
      future: {},
    }
  }

  const getServerEntry = async () => {
    const reviveConfig = await resolveReviveConfig()

    return `
    import * as entryServer from ${JSON.stringify(
      resolveFsUrl(
        path.resolve(reviveConfig.appDirectory, reviveConfig.entryServerFile)
      )
    )};
    ${Object.keys(reviveConfig.routes)
      .map((key, index) => {
        const route = reviveConfig.routes[key]!
        return `import * as route${index} from ${JSON.stringify(
          resolveFsUrl(resolveRelativeRouteFilePath(route, reviveConfig))
        )};`
      })
      .join('\n')}
      export { default as assets } from ${JSON.stringify(serverManifestId)};
      export const assetsBuildDirectory = ${JSON.stringify(
        reviveConfig.relativeAssetsBuildDirectory
      )};
      ${
        reviveConfig.future
          ? `export const future = ${JSON.stringify(reviveConfig.future)}`
          : ''
      };
      export const publicPath = ${JSON.stringify(reviveConfig.publicPath)};
      export const entry = { module: entryServer };
      export const routes = {
        ${Object.keys(reviveConfig.routes)
          .map((key, index) => {
            const route = reviveConfig.routes[key]!
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

  const createBuildManifest = async (): Promise<Manifest> => {
    const reviveConfig = await resolveReviveConfig()
    const viteManifest = JSON.parse(
      await fs.readFile(
        path.resolve(reviveConfig.assetsBuildDirectory, 'manifest.json'),
        'utf-8'
      )
    ) as ViteManifest

    const entry: Manifest['entry'] = resolveBuildAssetPaths(
      reviveConfig,
      viteManifest,
      reviveConfig.entryClientFile
    )

    const routes: Manifest['routes'] = {}
    for (const [key, route] of Object.entries(reviveConfig.routes)) {
      const sourceExports = await getRouteModuleExports(
        viteChildCompiler,
        reviveConfig,
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
        ...resolveBuildAssetPaths(reviveConfig, viteManifest, route.file),
      }
    }

    const fingerprintedValues = { entry, routes }
    const version = getHash(JSON.stringify(fingerprintedValues), 8)
    const manifestFilename = `manifest-${version}.js`
    const url = `${reviveConfig.publicPath}${manifestFilename}`
    const nonFingerprintedValues = { url, version }

    const manifest: Manifest = {
      ...fingerprintedValues,
      ...nonFingerprintedValues,
    }

    await writeFileSafe(
      path.join(reviveConfig.assetsBuildDirectory, manifestFilename),
      `window.__remixManifest=${JSON.stringify(manifest)};`
    )

    return manifest
  }

  const getDevManifest = async (): Promise<Manifest> => {
    const reviveConfig = await resolveReviveConfig()
    const routes: Manifest['routes'] = {}

    for (const [key, route] of Object.entries(reviveConfig.routes)) {
      const sourceExports = await getRouteModuleExports(
        viteChildCompiler,
        reviveConfig,
        route.file
      )

      routes[key] = {
        id: route.id,
        parentId: route.parentId,
        path: route.path,
        index: route.index,
        caseSensitive: route.caseSensitive,
        module: `${resolveFsUrl(
          resolveRelativeRouteFilePath(route, reviveConfig)
        )}${
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
          path.resolve(reviveConfig.appDirectory, reviveConfig.entryClientFile)
        ),
        imports: [],
      },
      routes,
    }
  }

  return [
    {
      name: 'revive',
      config: async (_viteUserConfig, viteConfigEnv) => {
        viteUserConfig = _viteUserConfig
        viteCommand = viteConfigEnv.command

        const reviveConfig = await resolveReviveConfig()

        return {
          appType: 'custom',
          ...(viteCommand === 'build' && {
            base: reviveConfig.publicPath,
            build: {
              ...viteUserConfig.build,
              ...(!viteConfigEnv.ssrBuild
                ? {
                    manifest: true,
                    outDir: reviveConfig.assetsBuildDirectory,
                    rollupOptions: {
                      ...viteUserConfig.build?.rollupOptions,
                      preserveEntrySignatures: 'exports-only',
                      input: [
                        path.resolve(
                          reviveConfig.appDirectory,
                          reviveConfig.entryClientFile
                        ),
                        ...Object.values(reviveConfig.routes).map((route) =>
                          path.resolve(reviveConfig.appDirectory, route.file)
                        ),
                      ],
                    },
                  }
                : {
                    outDir: path.dirname(reviveConfig.serverBuildPath),
                    rollupOptions: {
                      ...viteUserConfig.build?.rollupOptions,
                      preserveEntrySignatures: 'exports-only',
                      input: serverEntryId,
                      output: {
                        entryFileNames: path.basename(
                          reviveConfig.serverBuildPath
                        ),
                        format: reviveConfig.serverModuleFormat,
                      },
                    },
                  }),
            },
          }),
        }
      },
      async configResolved(viteConfig) {
        await initEsModuleLexer

        viteChildCompiler = await createViteDevServer({
          ...viteUserConfig,
          plugins: [
            ...(viteUserConfig.plugins ?? [])
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
            {
              name: 'no-hmr',
              handleHotUpdate() {
                // parent vite server is already sending HMR updates
                // do not send duplicate HMR updates from child server
                // which log confusing "page reloaded" messages that aren't true
                return []
              },
            },
          ],
          configFile: false,
        })
        await viteChildCompiler.pluginContainer.buildStart({})

        ssrBuildContext =
          viteConfig.build.ssr && viteCommand === 'build'
            ? { isSsrBuild: true, getManifest: createBuildManifest }
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
              const [reviveConfig, build] = await Promise.all([
                resolveReviveConfig(),
                vite.ssrLoadModule(serverEntryId) as Promise<ServerBuild>,
              ])

              const handle = createRequestHandler(build, {
                mode: 'development',
                criticalStyles: await getStylesForUrl(
                  vite,
                  reviveConfig,
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
      name: 'revive-virtual-modules',
      enforce: 'pre',
      resolveId(id) {
        if (vmods.includes(id)) return VirtualModule.resolve(id)
      },
      async load(id) {
        switch (id) {
          case VirtualModule.resolve(serverEntryId): {
            return await getServerEntry()
          }
          case VirtualModule.resolve(serverManifestId): {
            const manifest = ssrBuildContext.isSsrBuild
              ? await ssrBuildContext.getManifest()
              : await getDevManifest()

            return `export default ${jsesc(manifest, { es6: true })};`
          }
          case VirtualModule.resolve(browserManifestId): {
            if (viteCommand === 'build') {
              throw new Error('This module only exists in development')
            }

            const manifest = await getDevManifest()

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

        const reviveConfig = await resolveReviveConfig()

        // get route from vite module id (TODO: make this more efficient)
        if (!id.startsWith(reviveConfig.appDirectory)) return
        const routePath = path.relative(reviveConfig.appDirectory, id)
        const route = Object.values(reviveConfig.routes).find(
          (r) => r.file === routePath
        )
        if (!route) return

        const routeExports = await getRouteModuleExports(
          viteChildCompiler,
          reviveConfig,
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
          // TODO: ensure react refresh is initialized before `<Scripts />`
          return [
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
        if (id !== VirtualModule.resolve(hmrRuntimeId)) return

        const reactRefreshDir = path.dirname(
          _require.resolve('react-refresh/package.json')
        )
        const reactRefreshRuntimePath = path.join(
          reactRefreshDir,
          'cjs/react-refresh-runtime.development.js'
        )

        return [
          'const exports = {}',
          await fs.readFile(reactRefreshRuntimePath, 'utf8'),
          await fs.readFile(_require.resolve('./refresh-utils.cjs'), 'utf8'),
          'export default exports',
        ].join('\n')
      },
    },
    {
      name: 'revive-react-refresh-babel',
      // TODO: should `enforce` be `post` so that things like MDX get react-refresh/babel applied?
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
}

function addRefreshWrapper(code: string, id: string): string {
  return (
    REACT_REFRESH_HEADER.replace('__SOURCE__', JSON.stringify(id)) +
    code +
    REACT_REFRESH_FOOTER.replace('__SOURCE__', JSON.stringify(id))
  )
}

const REACT_REFRESH_HEADER = `
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

const REACT_REFRESH_FOOTER = `
if (import.meta.hot && !inWebWorker) {
  window.$RefreshReg$ = prevRefreshReg;
  window.$RefreshSig$ = prevRefreshSig;
  RefreshRuntime.__hmr_import(import.meta.url).then((currentExports) => {
    RefreshRuntime.registerExportsForReactRefresh(__SOURCE__, currentExports);
    import.meta.hot.accept((nextExports) => {
      if (!nextExports) return;
      const invalidateMessage = RefreshRuntime.validateRefreshBoundaryAndEnqueueUpdate(currentExports, nextExports);
      if (invalidateMessage) import.meta.hot.invalidate(invalidateMessage);
    });
  });
}`

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
