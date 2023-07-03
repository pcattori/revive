import { LinksFunction, json } from '@remix-run/node'
import { useLoaderData } from '@remix-run/react'

import styles from './styles.css?url'

export const links: LinksFunction = () => {
  return [{ rel: 'stylesheet', href: styles }]
}

export const loader = () => {
  return json({ message: 'hello from loader!' })
}

export default () => {
  const { message } = useLoaderData<typeof loader>()
  return <h1 className="blah_heading">{message}</h1>
}
