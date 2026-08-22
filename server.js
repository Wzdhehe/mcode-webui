// mcode-webui HTTP/SSE server.
//
// POST /api/chat   {prompt, workspace?, model?, timeout?, maxSteps?}
//                  → spawn `mcode exec --output-format stream-json`
//                  → SSE events: start / stream / stdout / stderr / done
//
// GET  /api/health → {ok, port, defaultModel, defaultWorkspace}
// GET  /           → public/index.html
//
// Run from inside the .minimax-code root so it finds the local mcode.cmd.
//   cd C:\Users\mjc39\.minimax-code\webui
//   node server.js

import http from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.PORT) || 7890
const HOST = process.env.HOST || '127.0.0.1'

// The webui lives at <mcode-root>/webui/. mcode.cmd is at <mcode-root>/mcode.cmd.
const MCODE_ROOT = resolve(__dirname, '..')
const MCODE_CMD = join(MCODE_ROOT, 'mcode.cmd')

const DEFAULT_MODEL = process.env.MCODE_MODEL || 'minimax_api/MiniMax-M3'
const DEFAULT_WORKSPACE = process.env.MCODE_WORKSPACE || MCODE_ROOT
const DEFAULT_TIMEOUT = process.env.MCODE_TIMEOUT || '120s'
const DEFAULT_MAX_STEPS = Number(process.env.MCODE_MAX_STEPS) || 6
const MAX_CONCURRENT = Number(process.env.MCODE_MAX_CONCURRENT) || 3

if (!existsSync(MCODE_CMD)) {
  console.error(`[fatal] mcode.cmd not found at ${MCODE_CMD}`)
  console.error('        run this server from inside the .minimax-code/webui/ folder')
  process.exit(1)
}

const html = readFileSync(join(__dirname, 'public', 'index.html'), 'utf8')

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }

  // Static HTML
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(html)
  }

  // Health
  if (req.method === 'GET' && req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    return res.end(
      JSON.stringify({
        ok: true,
        port: PORT,
        defaultModel: DEFAULT_MODEL,
        defaultWorkspace: DEFAULT_WORKSPACE,
        mcodeCmd: MCODE_CMD,
        maxConcurrent: MAX_CONCURRENT,
      })
    )
  }

  // Chat (SSE)
  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = ''
    for await (const chunk of req) body += chunk
    let payload
    try {
      payload = JSON.parse(body || '{}')
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'invalid JSON body' }))
    }
    const prompt = (payload.prompt || '').trim()
    if (!prompt) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'prompt required' }))
    }
    const workspace = payload.workspace || DEFAULT_WORKSPACE
    const model = payload.model || DEFAULT_MODEL
    const timeout = payload.timeout || DEFAULT_TIMEOUT
    const maxSteps = Number(payload.maxSteps) || DEFAULT_MAX_STEPS

    const args = [
      '/c',
      MCODE_CMD,
      'exec',
      '--input', '-',
      '--input-format', 'text',
      '--cwd', workspace,
      '--permission', 'full',
      '--timeout', timeout,
      '--output-format', 'stream-json',
      '--max-steps', String(maxSteps),
      '--model', model,
    ]

    const child = spawn('cmd.exe', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    res.writeHead(200, SSE_HEADERS)
    res.write(': connected\n\n')
    sse(res, 'start', { model, workspace, timeout, maxSteps, pid: child.pid })

    child.stdin.write(prompt, 'utf8')
    child.stdin.end()

    let buf = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          sse(res, 'stream', msg)
        } catch {
          sse(res, 'stdout', { line })
        }
      }
    })

    let stderrBuf = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk
      sse(res, 'stderr', { chunk })
    })

    child.on('error', (err) => {
      sse(res, 'error', { message: err.message })
    })

    child.on('exit', (code, sig) => {
      if (buf.length) {
        const tail = buf.trim()
        if (tail) {
          try {
            sse(res, 'stream', JSON.parse(tail))
          } catch {
            sse(res, 'stdout', { line: tail })
          }
        }
        buf = ''
      }
      sse(res, 'done', { code, sig, stderr: stderrBuf })
      res.end()
    })

    req.on('close', () => {
      if (!child.killed) {
        try {
          child.kill()
        } catch {}
      }
    })

    return // keep connection open
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('not found')
})

server.listen(PORT, HOST, () => {
  console.log(`[webui] listening on http://${HOST}:${PORT}`)
  console.log(`[webui] mcode cmd: ${MCODE_CMD}`)
  console.log(`[webui] default model: ${DEFAULT_MODEL}`)
  console.log(`[webui] default workspace: ${DEFAULT_WORKSPACE}`)
})