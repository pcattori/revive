import * as path from 'node:path'
import { BinaryLike, createHash } from 'node:crypto'
import { RemixConfig, readConfig } from '@remix-run/dev/dist/config.js'
import { Manifest } from '@remix-run/dev/dist/manifest.js'
import { ServerBuild } from '@remix-run/server-runtime'
import { createRequestHandler } from '@remix-run/node'
import { getRouteModuleExports } from '@remix-run/dev/dist/compiler/utils/routeExports.js'
import {
  Plugin,
  Manifest as ViteManifest,
  ResolvedConfig as ResolvedViteConfig,
  normalizePath as viteNormalizePath,
} from 'vite'
import jsesc from 'jsesc'

import * as NodeAdapter from './node/adapter.js'
import * as VirtualModule from './vmod.js'
import { getBuildContext } from './buildContext.js'

export let serverEntryId = VirtualModule.id('server-entry')
let serverManifestId = VirtualModule.id('server-manifest')
let browserManifestId = VirtualModule.id('browser-manifest')

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

const getDevManifest = async (): Promise<Manifest> => {
  const config = await readConfig()
  const routes: Record<string, any> = {}

  for (const entry of Object.entries(config.routes)) {
    const [key, route] = entry
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
      hasCatchBoundary: sourceExports.includes('CatchBoundary'),
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

const getHash = (source: BinaryLike, maxLength?: number): string => {
  const hash = createHash('sha256').update(source).digest('hex')
  return typeof maxLength === 'number' ? hash.slice(0, maxLength) : hash
}

const resolveBuildAssetPath = (
  config: RemixConfig,
  manifest: ViteManifest,
  appRelativePath: string
) => {
  const appPath = path.relative(process.cwd(), config.appDirectory)
  const manifestKey = normalizePath(path.join(appPath, appRelativePath))
  return `${config.publicPath}${manifest[manifestKey]?.file}`
}

export const getBuildManifest = async (
  config: RemixConfig,
  viteManifest: ViteManifest
): Promise<Manifest> => {
  const entry: Manifest['entry'] = {
    module: resolveBuildAssetPath(config, viteManifest, config.entryClientFile),
    imports: [],
  }

  const routes: Manifest['routes'] = {}
  for (const entry of Object.entries(config.routes)) {
    const [key, route] = entry
    const sourceExports = await getRouteModuleExports(config, route.id)

    routes[key] = {
      id: route.id,
      parentId: route.parentId,
      path: route.path,
      index: route.index,
      caseSensitive: route.caseSensitive,
      module: resolveBuildAssetPath(config, viteManifest, route.file),
      hasAction: sourceExports.includes('action'),
      hasLoader: sourceExports.includes('loader'),
      hasCatchBoundary: sourceExports.includes('CatchBoundary'),
      hasErrorBoundary: sourceExports.includes('ErrorBoundary'),
      imports: [],
    }
  }

  let fingerprintedValues = {
    entry,
    routes,
  }

  let version = getHash(JSON.stringify(fingerprintedValues), 8)

  let nonFingerprintedValues = {
    version,
  }

  return {
    ...fingerprintedValues,
    ...nonFingerprintedValues,
  }
}

export let revive: () => Plugin[] = () => {
  let viteConfig: ResolvedViteConfig

  return [
    {
      name: 'revive',
      config: () => ({ appType: 'custom' }),
      configResolved(resolvedConfig) {
        viteConfig = resolvedConfig
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

              let build = (await vite.ssrLoadModule(
                serverEntryId
              )) as ServerBuild
              const handler = createRequestHandler(build, 'development')

              let request = NodeAdapter.createRequest(req)
              let response = await handler(request, {})
              NodeAdapter.handleNodeResponse(response, res)
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
            const remixManifest =
              viteConfig.command === 'build'
                ? getBuildContext().manifest
                : await getDevManifest()

            return `export default ${jsesc(remixManifest, { es6: true })};`
          }
          case VirtualModule.resolve(browserManifestId): {
            const remixManifest =
              viteConfig.command === 'build'
                ? getBuildContext().manifest
                : await getDevManifest()

            return `window.__remixManifest=${jsesc(remixManifest, {
              es6: true,
            })};`
          }
        }
      },
    },
  ]
}
