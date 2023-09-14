import { LinksFunction } from '@remix-run/node'
import {
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from '@remix-run/react'
import { cssBundleHref } from '@remix-run/css-bundle'

import globalStyles from './global.css'

export const links: LinksFunction = () => {
  return [
    ...(cssBundleHref ? [{ rel: 'stylesheet', href: cssBundleHref }] : []),
    { rel: 'stylesheet', href: globalStyles },
  ]
}

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <h1>outlet begin</h1>
        <ul>
          <li>
            <Link to="/">Home</Link>
          </li>
          <li>
            <Link to="/blah">Blah</Link>
          </li>
        </ul>

        <Outlet />
        <h1>outlet end</h1>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  )
}
