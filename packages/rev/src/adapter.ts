import { IncomingMessage, ServerResponse } from 'http'

import * as set_cookie_parser from 'set-cookie-parser'
import { BROWSER, DEV } from 'esm-env'
import { installGlobals } from '@remix-run/node'

installGlobals()

let HttpError = class HttpError {
  status: number
  body: any

  constructor(status: number, body: any) {
    this.status = status
    if (typeof body === 'string') {
      this.body = { message: body }
    } else if (body) {
      this.body = body
    } else {
      this.body = { message: `Error: ${status}` }
    }
  }

  toString() {
    return JSON.stringify(this.body)
  }
}

function error(status: number, message: any) {
  if ((!BROWSER || DEV) && (isNaN(status) || status < 400 || status > 599)) {
    throw new Error(
      `HTTP error status codes must be between 400 and 599 — ${status} is invalid`
    )
  }

  return new HttpError(status, message)
}

function get_raw_body(req: IncomingMessage, body_size_limit: number) {
  const h = req.headers

  if (!h['content-type']) {
    return null
  }

  const content_length = Number(h['content-length'])

  // check if no request body
  if (
    (req.httpVersionMajor === 1 &&
      isNaN(content_length) &&
      h['transfer-encoding'] == null) ||
    content_length === 0
  ) {
    return null
  }

  let length = content_length

  if (body_size_limit) {
    if (!length) {
      length = body_size_limit
    } else if (length > body_size_limit) {
      throw error(
        413,
        `Received content-length of ${length}, but only accept up to ${body_size_limit} bytes.`
      )
    }
  }

  if (req.destroyed) {
    const readable = new ReadableStream()
    readable.cancel()
    return readable
  }

  let size = 0
  let cancelled = false

  return new ReadableStream({
    start(controller) {
      req.on('error', (error) => {
        cancelled = true
        controller.error(error)
      })

      req.on('end', () => {
        if (cancelled) return
        controller.close()
      })

      req.on('data', (chunk) => {
        if (cancelled) return

        size += chunk.length
        if (size > length) {
          cancelled = true
          controller.error(
            error(
              413,
              `request body size exceeded ${
                content_length ? "'content-length'" : 'BODY_SIZE_LIMIT'
              } of ${length}`
            )
          )
          return
        }

        controller.enqueue(chunk)

        if (controller.desiredSize === null || controller.desiredSize <= 0) {
          req.pause()
        }
      })
    },

    pull() {
      req.resume()
    },

    cancel(reason) {
      cancelled = true
      req.destroy(reason)
    },
  })
}

export async function getRequest(args: {
  request: IncomingMessage
  base: string
  bodySizeLimit: number
}) {
  console.log({ base: args.base, url: args.request.url })
  return new Request(args.base + args.request.url, {
    // @ts-expect-error
    duplex: 'half',
    method: args.request.method,
    headers: args.request.headers as Record<string, string>,
    body: get_raw_body(args.request, args.bodySizeLimit),
  })
}

export async function setResponse(
  res: ServerResponse<IncomingMessage>,
  response: Response
) {
  const headers = Object.fromEntries(response.headers)

  if (response.headers.has('set-cookie')) {
    const header = response.headers.get('set-cookie')!
    const split = set_cookie_parser.splitCookiesString(header)

    // @ts-expect-error
    headers['set-cookie'] = split
  }

  res.writeHead(response.status, headers)

  if (!response.body) {
    res.end()
    return
  }

  if (response.body.locked) {
    res.write(
      'Fatal error: Response body is locked. ' +
        `This can happen when the response was already read (for example through 'response.json()' or 'response.text()').`
    )
    res.end()
    return
  }

  const reader = response.body.getReader()

  if (res.destroyed) {
    reader.cancel()
    return
  }

  const cancel = (error?: Error) => {
    res.off('close', cancel)
    res.off('error', cancel)

    // If the reader has already been interrupted with an error earlier,
    // then it will appear here, it is useless, but it needs to be catch.
    reader.cancel(error).catch(() => {})
    if (error) res.destroy(error)
  }

  res.on('close', cancel)
  res.on('error', cancel)

  next()
  async function next() {
    try {
      for (;;) {
        const { done, value } = await reader.read()

        if (done) break

        if (!res.write(value)) {
          res.once('drain', next)
          return
        }
      }
      res.end()
    } catch (error) {
      cancel(error instanceof Error ? error : new Error(String(error)))
    }
  }
}
