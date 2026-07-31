export type GrsAiImageSize = '1K' | '2K' | '4K'
export type GrsAiModelFamily = 'gpt-image' | 'nano-banana'

export type GrsAiModelOption = {
  label: string
  value: string
  family: GrsAiModelFamily
  imageSize: GrsAiImageSize
  disabled?: boolean
}

export type GrsAiModelGroup = {
  label: string
  models: GrsAiModelOption[]
}

export const grsAiDefaultEndpoint = 'https://grsai.dakka.com.cn/v1/api/generate'

export const grsAiModelGroups: GrsAiModelGroup[] = [
  {
    label: 'GPT Image',
    models: [
      { label: 'GPT Image 2 · 1K', value: 'gpt-image-2', family: 'gpt-image', imageSize: '1K' },
      { label: 'GPT Image 2 VIP · 1K', value: 'gpt-image-2-vip', family: 'gpt-image', imageSize: '1K' },
    ],
  },
  {
    label: 'Nano Banana · 常规模型',
    models: [
      { label: 'Nano Banana 2 Lite · 1K', value: 'nano-banana-2-lite', family: 'nano-banana', imageSize: '1K' },
      { label: 'Nano Banana Fast · 1K', value: 'nano-banana-fast', family: 'nano-banana', imageSize: '1K' },
      { label: 'Nano Banana 2 · 1K', value: 'nano-banana-2', family: 'nano-banana', imageSize: '1K' },
      { label: 'Nano Banana Pro · 1K', value: 'nano-banana-pro', family: 'nano-banana', imageSize: '1K' },
      {
        label: 'Nano Banana Pro VT · 维护中',
        value: 'nano-banana-pro-vt',
        family: 'nano-banana',
        imageSize: '1K',
        disabled: true,
      },
    ],
  },
  {
    label: 'Nano Banana · 稳定渠道',
    models: [
      { label: 'Nano Banana Pro CL · 1K', value: 'nano-banana-pro-cl', family: 'nano-banana', imageSize: '1K' },
      { label: 'Nano Banana 2 CL · 1K', value: 'nano-banana-2-cl', family: 'nano-banana', imageSize: '1K' },
      { label: 'Nano Banana 2 CL · 2K', value: 'nano-banana-2-2k-cl', family: 'nano-banana', imageSize: '2K' },
      { label: 'Nano Banana 2 CL · 4K', value: 'nano-banana-2-4k-cl', family: 'nano-banana', imageSize: '4K' },
      { label: 'Nano Banana Pro VIP · 1K', value: 'nano-banana-pro-vip', family: 'nano-banana', imageSize: '1K' },
      { label: 'Nano Banana Pro VIP · 4K', value: 'nano-banana-pro-4k-vip', family: 'nano-banana', imageSize: '4K' },
    ],
  },
]

export const grsAiModelOptions = grsAiModelGroups.flatMap((group) => group.models)
export const defaultGrsAiModel = 'gpt-image-2'

export function findGrsAiModel(model: string) {
  const value = model.trim().toLowerCase()
  return grsAiModelOptions.find((item) => item.value === value || item.label.toLowerCase() === value)
}

export function normalizeGrsAiModel(model: string) {
  return findGrsAiModel(model)?.value ?? defaultGrsAiModel
}

export function normalizeGrsAiEndpoint(endpoint: string) {
  const value = endpoint.trim() || grsAiDefaultEndpoint

  try {
    const url = new URL(value)
    const pathname = url.pathname.replace(/\/$/, '')

    if (/\/v1\/draw\/[^/]+$/.test(pathname)) {
      url.pathname = pathname.replace(/\/v1\/draw\/[^/]+$/, '/v1/api/generate')
    } else if (pathname === '' || pathname === '/') {
      url.pathname = '/v1/api/generate'
    } else if (pathname === '/v1') {
      url.pathname = '/v1/api/generate'
    } else if (pathname !== '/v1/api/generate') {
      url.pathname = `${pathname}/v1/api/generate`
    }

    return url.toString()
  } catch {
    return grsAiDefaultEndpoint
  }
}
