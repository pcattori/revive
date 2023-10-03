import { LinksFunction, json } from '@remix-run/node'
import {
  Form,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  LiveReload,
  useLoaderData,
} from '@remix-run/react'
import { cssBundleHref } from '@remix-run/css-bundle'

import { db } from '~/db.server'
import globalStyles from '~/global.css'

export const links: LinksFunction = () => {
  return [
    ...(cssBundleHref ? [{ rel: 'stylesheet', href: cssBundleHref }] : []),
    { rel: 'stylesheet', href: globalStyles },
  ]
}

export const loader = () => {
  return json(db)
}

export const action = () => {
  db.push('stuff')
  return null
}

export default function App() {
  const data = useLoaderData<typeof loader>()
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
        <pre>{JSON.stringify(data)}</pre>
        <Form method="post">
          <button>Add stuff</button>
        </Form>
        <ul>
          <li>
            <Link to="/">Home</Link>
          </li>
          <li>
            <Link to="/blah">Blah</Link>
          </li>
          <li>
            <Link to="/mdx-route">MDX Route</Link>
          </li>
          <li>
            <Link to="/mdx-component">MDX Component</Link>
          </li>
        </ul>

        <Outlet />
        <h1>outlet end</h1>
        <ScrollRestoration />
        <Scripts />
        <LiveReload />
      </body>
    </html>
  )
}
