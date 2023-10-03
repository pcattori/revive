import { json } from '@remix-run/node'
import { useFetcher } from '@remix-run/react'

export const loader = () => {
  return json({ hello: 'Hello from FSC!' })
}

export function shouldRevalidate() {
  return false
}

export function Fullstack() {
  const fetcher = useFetcher<typeof loader>()
  const data = fetcher.data ?? { hello: 'no message yet' }
  console.log({ data })
  return (
    <div style={{ display: 'flex' }}>
      <button
        onClick={() => {
          fetcher.submit(
            {},
            {
              method: 'get',
              action: '/fullstack',
            }
          )
        }}
      >
        Say hello to fullstack components!
      </button>
      <div>{data.hello ? <p>{data.hello}</p> : null}</div>
    </div>
  )
}
