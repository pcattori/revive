type VirtualModule = {
  id: string
  code: string
}

export let create = (name: string, code: string): VirtualModule => {
  const id = `virtual:${name}`
  return { id, code }
}

export let resolve = (vmod: VirtualModule) => `\0${vmod.id}`
export let url = (vmod: VirtualModule) => `/@id/__x00__virtual:${vmod.id}`
