import { dirname } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

export async function writeFileSafe(
  file: string,
  contents: string
): Promise<string> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, contents)
  return file
}
