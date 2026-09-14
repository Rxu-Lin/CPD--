import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const websiteUrl = 'http://127.0.0.1:5174/'
const noBrowser = process.argv.includes('--no-browser')
const commandShell = process.env.ComSpec || 'cmd.exe'

async function websiteReady() {
  try {
    const response = await fetch(websiteUrl, { signal: AbortSignal.timeout(2000) })
    const html = await response.text()
    return response.ok && html.includes('<title>AI 画布工作台</title>') && html.includes('/src/main.tsx')
  } catch {
    return false
  }
}

function portOccupied() {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: 5174 })
    const finish = (occupied) => { socket.destroy(); resolve(occupied) }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(1500, () => finish(false))
  })
}

function openWebsite() {
  console.log(`网站已就绪：${websiteUrl}`)
  console.log('服务器在后台运行，可以关闭此窗口。')
  if (!noBrowser) {
    const result = spawnSync(commandShell, ['/d', '/s', '/c', `start "" "${websiteUrl}"`], { windowsHide: true })
    if (result.error || result.status !== 0) {
      console.log(`浏览器未能自动打开，请访问：${websiteUrl}`)
    }
  }
}

async function main() {
  if (!existsSync(path.join(projectRoot, 'package.json'))) {
    throw new Error('找不到网站文件，请保留启动脚本与网站文件夹的原有位置。')
  }
  if (await websiteReady()) {
    console.log('检测到网站已经运行，直接打开。')
    openWebsite()
    return
  }
  if (await portOccupied()) {
    throw new Error('端口 5174 已被其他服务占用，或网站尚未就绪。请稍后重试，或关闭占用该端口的程序。')
  }

  const viteEntry = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js')
  if (!existsSync(viteEntry)) {
    console.log('首次启动，正在安装网站依赖，请稍候……')
    const install = spawnSync(commandShell, ['/d', '/s', '/c', 'npm.cmd ci --no-audit --no-fund'], {
      cwd: projectRoot, stdio: 'inherit', windowsHide: true,
    })
    if (install.error || install.status !== 0) {
      throw new Error('依赖安装失败，请检查 Node.js 安装和网络连接后重试。')
    }
  }

  const logDirectory = path.join(projectRoot, 'logs')
  mkdirSync(logDirectory, { recursive: true })
  const stderrLog = path.join(logDirectory, 'server.stderr.log')
  const stdoutFd = openSync(path.join(logDirectory, 'server.stdout.log'), 'w')
  const stderrFd = openSync(stderrLog, 'w')
  console.log('正在启动 AI 画布工作台……')
  let child
  let startupError
  try {
    child = spawn(process.execPath, [viteEntry, '--host', '127.0.0.1', '--port', '5174', '--strictPort'], {
      cwd: projectRoot, detached: true, windowsHide: true, stdio: ['ignore', stdoutFd, stderrFd],
    })
    child.once('error', (error) => { startupError = error })
    child.unref()
  } finally {
    closeSync(stdoutFd)
    closeSync(stderrFd)
  }

  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    if (await websiteReady()) {
      openWebsite()
      return
    }
    if (startupError || child.exitCode !== null || child.signalCode !== null) {
      const details = readFileSync(stderrLog, 'utf8').trim().split(/\r?\n/).slice(-15).join('\n')
      throw new Error(`服务器启动失败。${startupError?.message || ''}\n${details}\n日志：${logDirectory}`)
    }
    await delay(400)
  }
  throw new Error(`等待网站启动超时，请查看日志：${logDirectory}`)
}

main().catch((error) => {
  console.error(`启动失败：${error.message}`)
  process.exitCode = 1
})
