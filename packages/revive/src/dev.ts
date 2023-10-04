import { spawn } from 'node:child_process'

interface DevOptions {
  config?: string
  port?: string
  strictPort?: boolean
  host?: true | string
  force?: boolean
}

export async function dev({
  config,
  port,
  strictPort,
  host,
  force,
}: DevOptions) {
  spawn(
    'vite',
    [
      'dev',
      ...(config ? ['--config', config] : []),
      ...(port ? ['--port', port] : []),
      ...(strictPort ? ['--strictPort'] : []),
      ...(force ? ['--force'] : []),
      ...(host ? ['--host', ...(typeof host === 'string' ? [host] : [])] : []),
    ],
    {
      shell: true,
      stdio: 'inherit',
      env: {
        ...process.env,
      },
    }
  )
}
