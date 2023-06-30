import * as path from 'node:path'
import {
  type RemixConfig,
  readConfig as getRemixConfig,
} from '@remix-run/dev/dist/config.js'
import { createRequestHandler } from '@remix-run/express'
import { type ServerBuild } from '@remix-run/server-runtime'
import { getRouteModuleExports } from '@remix-run/dev/dist/compiler/utils/routeExports.js'
import { type Plugin, normalizePath as viteNormalizePath } from 'vite'
import jsesc from 'jsesc'

const SERVER_ENTRY_ID = 'server-entry'
const SERVER_ASSETS_MANIFEST_ID = 'server-assets-manifest'
const BROWSER_ASSETS_MANIFEST_ID = 'browser-assets-manifest'

const createVirtualModule = (name: string, code: string) => {
  const virtualModuleId = `virtual:${name}`
  const resolvedVirtualModuleId = `\0${virtualModuleId}`

  return {
    virtualModuleId,
    resolvedVirtualModuleId,
    code,
  }
}

const getRemixPlugin = async (): Promise<Plugin> => {
  const config = await getRemixConfig()
  const manifest = await getAssetManifest(config)
  const serverEntryJs = getServerEntry(config)

  const serverEntryVirtualModule = createVirtualModule(
    SERVER_ENTRY_ID,
    serverEntryJs
  )
  const serverManifestVirtualModule = createVirtualModule(
    SERVER_ASSETS_MANIFEST_ID,
    `export default ${jsesc(manifest, { es6: true })};`
  )
  const browserManifestVirtualModule = createVirtualModule(
    BROWSER_ASSETS_MANIFEST_ID,
    `window.__remixManifest=${jsesc(manifest, { es6: true })};`
  )

  const virtualModules = [
    serverEntryVirtualModule,
    serverManifestVirtualModule,
    browserManifestVirtualModule,
  ]

  return {
    name: 'vite-plugin-remix',
    enforce: 'pre',
    resolveId(id) {
      for (const virtualModule of virtualModules) {
        if (id === virtualModule.virtualModuleId) {
          return virtualModule.resolvedVirtualModuleId
        }
      }
    },
    load(id) {
      for (const virtualModule of virtualModules) {
        if (id === virtualModule.resolvedVirtualModuleId) {
          return virtualModule.code
        }
      }
    },
  }
}

const toUnixPath = (p: string) =>
  // eslint-disable-next-line prefer-named-capture-group
  p.replace(/[\\/]+/g, '/').replace(/^([a-zA-Z]+:|\.\/)/, '')

const normalizePath = (p: string) => {
  return viteNormalizePath(toUnixPath(p))
}

const resolveFSPath = (filePath: string) => {
  return `/@fs${normalizePath(filePath)}`
}

const getAppDirName = (config: RemixConfig) => {
  return path.resolve(config.appDirectory)
}

const resolveAppRelativeFilePath = (file: string, config: RemixConfig) => {
  const appDir = getAppDirName(config)
  return path.resolve(process.cwd(), appDir, file)
}

type Route = RemixConfig['routes'][string]
const resolveRelativeRouteFilePath = (route: Route, config: RemixConfig) => {
  const file = route.file
  const fullPath = resolveAppRelativeFilePath(file, config)

  return normalizePath(fullPath)
}

const getServerEntry = (config: RemixConfig) => {
  return `
  import * as entryServer from ${JSON.stringify(
    resolveFSPath(resolveAppRelativeFilePath(config.entryServerFile, config))
  )};
  ${Object.keys(config.routes)
    .map((key, index) => {
      const route = config.routes[key]!
      return `import * as route${index} from ${JSON.stringify(
        resolveFSPath(resolveRelativeRouteFilePath(route, config))
      )};`
    })
    .join('\n')}
    export { default as assets } from ${JSON.stringify(
      'virtual:server-assets-manifest'
    )};
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

const getRemixRouteModuleExports = async (routeId: string) => {
  const config = await getRemixConfig()
  return getRouteModuleExports(config, routeId)
}

const getVirtualModuleUrl = (id: string) => `/@id/__x00__virtual:${id}`

const getAssetManifest = async (config: RemixConfig) => {
  const routes: Record<string, any> = {}

  for (const entry of Object.entries(config.routes)) {
    const [key, route] = entry
    const sourceExports = await getRemixRouteModuleExports(route.id)

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
    url: getVirtualModuleUrl(BROWSER_ASSETS_MANIFEST_ID),
    version: Math.random(),
    entry: {
      module: resolveFSPath(
        resolveAppRelativeFilePath(config.entryClientFile, config)
      ),
      imports: [],
    },
    routes,
  }
}

export let revive: () => Promise<Plugin[]> = async () => {
  const config = await getRemixConfig()
  const manifest = await getAssetManifest(config)
  const serverEntryJs = getServerEntry(config)

  const serverEntryVirtualModule = createVirtualModule(
    SERVER_ENTRY_ID,
    serverEntryJs
  )
  const serverManifestVirtualModule = createVirtualModule(
    SERVER_ASSETS_MANIFEST_ID,
    `export default ${jsesc(manifest, { es6: true })};`
  )
  const browserManifestVirtualModule = createVirtualModule(
    BROWSER_ASSETS_MANIFEST_ID,
    `window.__remixManifest=${jsesc(manifest, { es6: true })};`
  )

  const virtualModules = [
    serverEntryVirtualModule,
    serverManifestVirtualModule,
    browserManifestVirtualModule,
  ]

  return [
    {
      name: 'revive',
      configureServer(vite) {
        return () => {
          vite.middlewares.use(async (req, res, next) => {
            let build = (await vite.ssrLoadModule(
              `virtual:${SERVER_ENTRY_ID}`
            )) as ServerBuild

            const handler = createRequestHandler({
              build,
              mode: 'development',
            })

            console.log({ handler })

            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ hello: 'world' }))
          })
        }
      },
    },
    {
      name: 'revive-virtual-modules',
      enforce: 'pre',
      resolveId(id) {
        for (const virtualModule of virtualModules) {
          if (id === virtualModule.virtualModuleId) {
            return virtualModule.resolvedVirtualModuleId
          }
        }
      },
      load(id) {
        for (const virtualModule of virtualModules) {
          if (id === virtualModule.resolvedVirtualModuleId) {
            return virtualModule.code
          }
        }
      },
    },
  ]
}
