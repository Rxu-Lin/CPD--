process.env.NODE_ENV ||= 'production'

const { preview } = await import('vite')
const parsedPort = Number.parseInt(process.env.PORT || '4173', 10)
const port = Number.isFinite(parsedPort) ? parsedPort : 4173

await preview({
  preview: {
    allowedHosts: true,
    host: '0.0.0.0',
    port,
    strictPort: true,
  },
})

console.log(`AI Canvas is listening on 0.0.0.0:${port}`)
