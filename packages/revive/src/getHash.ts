import { type BinaryLike, createHash } from 'node:crypto'

export function getHash(source: BinaryLike, maxLength?: number): string {
  const hash = createHash('sha256').update(source).digest('hex')
  return typeof maxLength === 'number' ? hash.slice(0, maxLength) : hash
}
