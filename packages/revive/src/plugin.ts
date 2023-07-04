import * as path from 'node:path'
import { type RemixConfig, readConfig } from '@remix-run/dev/dist/config.js'
import { type Manifest } from '@remix-run/dev/dist/manifest.js'
import { type ServerBuild } from '@remix-run/server-runtime'
import { createRequestHandler } from '@remix-run/node'
import { getRouteModuleExports } from '@remix-run/dev/dist/compiler/utils/routeExports.js'
import {
  type Plugin,
  type Manifest as ViteManifest,
  normalizePath as viteNormalizePath,
} from 'vite'
import jsesc from 'jsesc'

import * as NodeAdapter from './node/adapter.js'
import * as VirtualModule from './vmod.js'
import { getHash } from './getHash.js'
import { getViteManifest } from './getViteManifest.js'

export let serverEntryId = VirtualModule.id('server-entry')
let browserManifestId = VirtualModule.id('browser-remix-manifest')
let serverManifestId = VirtualModule.id('server-remix-manifest')

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

const getAssetManifestForDev = async (
  config: RemixConfig
): Promise<Manifest> => {
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

const resolveAssetPath = (
  config: RemixConfig,
  manifest: ViteManifest,
  appRelativePath: string
) => {
  const appPath = path.relative(process.cwd(), config.appDirectory)
  const manifestKey = normalizePath(path.join(appPath, appRelativePath))
  return `${config.publicPath}${manifest[manifestKey]?.file}`
}

export const getAssetManifestForBuild = async (
  config: RemixConfig,
  viteManifest: ViteManifest
): Promise<Manifest> => {
  const entry: Manifest['entry'] = {
    module: resolveAssetPath(config, viteManifest, config.entryClientFile),
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
      module: resolveAssetPath(config, viteManifest, route.file),
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

const getAssetManifest = async ({
  config,
  mode,
}: {
  config: RemixConfig
  mode: 'build' | 'dev'
}): Promise<Manifest> => {
  if (mode === 'build') {
    const viteManifest = await getViteManifest(config)
    return await getAssetManifestForBuild(config, viteManifest)
  }

  return await getAssetManifestForDev(config)
}

export let revive: () => Plugin[] = () => {
  let mode: 'build' | 'dev' = 'build'

  return [
    {
      name: 'revive',
      config: () => ({ appType: 'custom' }),
      configureServer(vite) {
        mode = 'dev'

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
            const manifest = process.env.__REMIX_BUILD_MANIFEST_JSON__
              ? JSON.parse(process.env.__REMIX_BUILD_MANIFEST_JSON__)
              : await getAssetManifest({
                  config: await readConfig(),
                  mode,
                })
            return `export default ${jsesc(manifest, { es6: true })};`
          }
          case VirtualModule.resolve(browserManifestId): {
            const manifest = process.env.__REMIX_BUILD_MANIFEST_JSON__
              ? JSON.parse(process.env.__REMIX_BUILD_MANIFEST_JSON__)
              : await getAssetManifest({
                  config: await readConfig(),
                  mode,
                })
            return `window.__remixManifest=${jsesc(manifest, { es6: true })};`
          }
        }
      },
    },
  ]
}
