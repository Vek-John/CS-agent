#!/usr/bin/env node
// Isolated real React Host + Vue Viewer, synthetic data, real in-memory Graph. Never loads .env.
import { createRequire } from 'node:module'
import { dirname, resolve, extname, sep } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdir, writeFile, readFile, realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const app = resolve(root, '.local-data/upstream/cs2d/apps/app'), web = resolve(root, 'apps/web')
const dependency = createRequire(resolve(app, 'package.json')), webDependency = createRequire(resolve(web, 'package.json'))
const args = process.argv.slice(2), realDemo = args.includes('--real-demo'), output = resolve(root, realDemo ? '.local-data/real-demo-host-entry-preflight' : '.local-data/guided-react-host-smoke'), generated = resolve(output, 'src'), dist = resolve(output, 'dist')
const failFirstReflection = args.includes('--fail-first-reflection')
const diagnostics = args.includes('--diagnostics') || failFirstReflection || realDemo
const port = Number(args.find(arg => arg.startsWith('--port='))?.slice(7) ?? 4324)
if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('INVALID_LOOPBACK_PORT')
if (!args.includes('--serve-only')) {
  await mkdir(generated, { recursive: true })
  await writeFile(resolve(generated, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Real React Host synthetic smoke</title><body><header style="padding:12px"><strong>合成场景 · 非真实 Demo</strong><p>实际 React Host、Session、默认 Graph 与 Vue Viewer；解析和模型未运行。先载入，再点地图上方明确标注的合成选人按钮，选人后真实 Host 自动准备并开始带看。该按钮替代 DemoAnalyzer 选人；Viewer 名单点击仅切换跟随对象。</p><button id="load" disabled>载入合成比赛</button><details><summary>有界验收摘要</summary><pre id="summary"></pre></details></header><div id="host"></div><script type="module" src="/parent.tsx"></script></body></html>`)
  if (realDemo) await writeFile(resolve(generated, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Real Demo Host isolated entry</title><body><header style="padding:12px"><strong>真实本机文件入口 · 隔离验收</strong><p>使用原始文件/选人界面。Parser 与本地 WASM INT8 胜率模型真实运行；教练使用受限本地规则。仅支持不超过128MiB的.dem；解析与缓存、选人后分析分别限120秒。新origin自产浏览器缓存保留。</p><button id="load" hidden disabled></button><details open><summary>有界验收摘要</summary><pre id="summary"></pre></details></header><div id="host"></div><script type="module" src="/parent.tsx"></script></body></html>`)
  await writeFile(resolve(generated, 'child.html'), '<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script type="module" src="/child.ts"></script></html>')
  await writeFile(resolve(generated, 'parent.tsx'), `import ${JSON.stringify(resolve(root, 'tools/cs2d-host/react-host-smoke-parent.tsx'))};`)
  await writeFile(resolve(generated, 'child.ts'), `import './smoke.css';\nimport ${JSON.stringify(resolve(root, realDemo ? 'tools/cs2d-host/react-host-smoke-real-child.ts' : 'tools/cs2d-host/react-host-smoke-child.ts'))};`)
  await writeFile(resolve(generated, 'smoke.css'), `@import ${JSON.stringify(resolve(app, 'src/style.css'))};\n@source ${JSON.stringify(resolve(app, 'src'))};\nhtml,body,#app{height:100%;width:100%;margin:0;overflow:hidden}\n`)
  const { build } = await import(pathToFileURL(dependency.resolve('vite')).href)
  const { default: vue } = await import(pathToFileURL(dependency.resolve('@vitejs/plugin-vue')).href)
  const { default: tailwind } = await import(pathToFileURL(dependency.resolve('@tailwindcss/vite')).href)
  await build({ configFile: false, root: generated, publicDir: resolve(app, 'public'), plugins: [vue(), tailwind()],
    esbuild: { jsx: 'automatic', jsxImportSource: 'react' }, define: { 'process.env': '{}' },
    resolve: { alias: { '@': resolve(app, 'src'), vue: resolve(dirname(dependency.resolve('vue/package.json')), 'dist/vue.runtime.esm-bundler.js'),
      'vue-router': dependency.resolve('vue-router'), react: dirname(webDependency.resolve('react/package.json')), 'react-dom': dirname(webDependency.resolve('react-dom/package.json')) }, dedupe: ['vue', 'react', 'react-dom'] },
    build: { outDir: dist, emptyOutDir: true, copyPublicDir: false, target: 'es2022', rollupOptions: { input: { parent: resolve(generated, 'index.html'), child: resolve(generated, 'child.html') } } },
  })
  const esbuild = createRequire(resolve(root, 'libs/coach-agent/package.json'))('esbuild')
  await esbuild.build({ entryPoints: [resolve(root, 'tools/cs2d-host/react-host-smoke-runtime.ts')], outfile: resolve(output, 'runtime.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22' })
  console.log(JSON.stringify({ built: true, dist, runtime: 'MEMORY', synthetic: !realDemo, parserEnabled: realDemo, modelConfigured: realDemo ? 'local-wasm-int8' : false }))
}
if (args.includes('--serve') || args.includes('--serve-only')) {
  const runtime = createRequire(import.meta.url)(resolve(output, 'runtime.cjs'))
  const transport = runtime.createSmokeTransport({ failFirstReflection })
  const mime = { '.wasm': 'application/wasm', '.mjs': 'text/javascript; charset=utf-8', '.onnx': 'application/octet-stream', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json' }
  const roots = { maps: resolve(app, 'public/maps'), weapons: resolve(app, 'public/weapons'), teams: resolve(app, 'public/teams'), ...(realDemo ? { 'generated-assets': resolve(web, 'public/generated-assets') } : {}) }
  const realFiles = new Set(['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm', 'zstd.wasm', 'models/cs-net/manifest.json', 'models/cs-net/win-rate.fp16.manifest.json', 'models/cs-net/win-rate.int8.onnx', 'models/cs-net/win-rate.fp16.onnx'])
  const server = createServer(async (req, res) => {
    try {
      const origin = `http://127.0.0.1:${server.address().port}`
      if (req.headers.host !== new URL(origin).host) { res.writeHead(403); res.end(); return }
      if (realDemo) {
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'self'")
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
      }
      const pathname = decodeURIComponent(new URL(req.url ?? '/', origin).pathname)
      if (pathname === '/api/coaching/agent') {
        if (req.method !== 'POST' || req.headers.origin !== origin || !req.headers['content-type']?.startsWith('application/json')) { res.writeHead(403); res.end(); return }
        const chunks = []; let size = 0
        for await (const chunk of req) { size += chunk.length; if (size > 65536) { res.writeHead(413); res.end(); return } chunks.push(chunk) }
        const result = await transport(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        res.writeHead(result.status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(result.payload)); return
      }
      if (pathname === '/smoke-metrics.json') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(runtime.metrics)); return }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
      const parts = pathname.split('/').filter(Boolean), fixedRealFile = realDemo && realFiles.has(parts.join('/')), assetRoot = roots[parts[0]], base = fixedRealFile ? resolve(app, 'public') : assetRoot || dist
      const file = await realpath(resolve(base, ...(assetRoot ? parts.slice(1) : parts.length ? parts : ['index.html']))), safeBase = await realpath(base)
      if (!file.startsWith(safeBase + sep) || (await stat(file)).isDirectory()) throw Error('OUTSIDE_STATIC_ROOT')
      res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(req.method === 'HEAD' ? undefined : await readFile(file))
    } catch { if (!res.headersSent) res.writeHead(400); res.end('SMOKE_REQUEST_REJECTED') }
  })
  await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done) })
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/${realDemo ? '?realDemo=1' : diagnostics ? '' : '?teachingDiagnostics=off'}`, realDemo, diagnostics, failFirstReflection, stop: 'SIGINT or SIGTERM', rawReplay: 'child page only', runtime: 'MEMORY' }))
  const stop = () => { server.close(); server.closeAllConnections() }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
}
