// adapted from https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/src/refreshUtils.js

function debounce(fn, delay) {
  let handle
  return () => {
    clearTimeout(handle)
    handle = setTimeout(fn, delay)
  }
}

/* eslint-disable no-undef */
const enqueueUpdate = debounce(exports.performReactRefresh, 16)

// Taken from https://github.com/pmmmwh/react-refresh-webpack-plugin/blob/main/lib/runtime/RefreshUtils.js#L141
// This allows to resister components not detected by SWC like styled component
function registerExportsForReactRefresh(filename, moduleExports) {
  for (const key in moduleExports) {
    if (key === '__esModule') continue
    const exportValue = moduleExports[key]
    if (exports.isLikelyComponentType(exportValue)) {
      // 'export' is required to avoid key collision when renamed exports that
      // shadow a local component name: https://github.com/vitejs/vite-plugin-react/issues/116
      // The register function has an identity check to not register twice the same component,
      // so this is safe to not used the same key here.
      exports.register(exportValue, filename + ' export ' + key)
    }
  }
}

// Hides vite-ignored dynamic import so that Vite can skip analysis if no other
// dynamic import is present (https://github.com/vitejs/vite/pull/12732)
function __hmr_import(module) {
  return import(/* @vite-ignore */ module)
}

// HACK: does not account for changes to variables from outer scopes
// but this shouldn't be needed after we integrate HDR
function isSameFunction(a, b) {
  if (a === undefined && b === undefined) return true
  return (
    typeof a === 'function' &&
    typeof b === 'function' &&
    a.toString() === b.toString()
  )
}

import.meta.hot.on('revive:hmr', async ({ route }) => {
  let imported = await __hmr_import(route.module + `?t=${Date.now()}`)
  let routeModule = {
    ...imported,
    // react-refresh takes care of updating these in-place,
    // if we don't preserve existing values we'll loose state.
    default: imported.default
      ? window.__remixRouteModules[route.id]?.default ?? imported.default
      : imported.default,
    ErrorBoundary: imported.ErrorBoundary
      ? window.__remixRouteModules[route.id]?.ErrorBoundary ??
        imported.ErrorBoundary
      : imported.ErrorBoundary,
  }
  window.__remixRouteModules[route.id] = routeModule

  let manifest = JSON.parse(JSON.stringify(__remixManifest))
  manifest[route.id] = route

  let routes = __remixRouter.createRoutesForHMR(
    new Set([route.id]),
    manifest.routes,
    window.__remixRouteModules,
    window.__remixContext.future
  )
  __remixRouter._internalSetRoutes(routes)

  let unsub = __remixRouter.subscribe((state) => {
    if (state.revalidation === 'idle') {
      unsub()
      // Ensure RouterProvider setState has flushed before re-rendering
      setTimeout(() => {
        Object.assign(window.__remixManifest, manifest)
        console.log('REFRESH!')
        exports.performReactRefresh()
      }, 1)
    }
  })
  window.__remixRevalidation = (window.__remixRevalidation || 0) + 1
  __remixRouter.revalidate()
})

exports.__hmr_import = __hmr_import
exports.registerExportsForReactRefresh = registerExportsForReactRefresh
exports.enqueueUpdate = enqueueUpdate
exports.isSameFunction = isSameFunction
