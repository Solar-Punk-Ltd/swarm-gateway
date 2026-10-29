process.env.LOG_LEVEL = 'critical'
delete process.env.DATABASE_CONFIG

import { Cache, Dates } from 'cafe-utility'
import assert from 'node:assert/strict'
import http, { Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test'
import { AppConfig, getAppConfig, getNamesWithoutEth, redactAppConfig } from '../src/config'
import * as Database from '../src/database/Database'
import { applyConnectionTimeouts, createApp } from '../src/server'
import * as Feed from '../src/services/feed'
import { PostageBatchDispenserService } from '../src/services/postage-batch-dispenser'
import { encodeResolveContenthash } from '../src/services/universal-resolver'
import { SharedAnswers } from '../src/shared-answers'
import { StampManager } from '../src/stamp'
import { encodeResolveAnswer } from './universal-resolver-fixtures'

const SWARM_PREFIX = 'e40101fa011b20'
const SITE = 'a1'.repeat(32)
const DENIED = 'a2'.repeat(32)
const HOMEPAGE = 'a3'.repeat(32)
const IPFS_CONTENTHASH = 'e301017012' + 'a4'.repeat(32)

const CONTENTHASHES: Record<string, string> = {
  'site.eth': SWARM_PREFIX + SITE,
  'denied.eth': SWARM_PREFIX + DENIED,
  'home.eth': SWARM_PREFIX + HOMEPAGE,
  'nocontent.eth': '',
  'ipfs.eth': IPFS_CONTENTHASH,
}

const beeRequests: string[] = []
const rpcNames: string[] = []
const servers: Server[] = []
let rpcFails = false
let beeFails = false
let databaseConfigured = true
let ruleQueries = 0
let feedLookups = 0

const bee = http.createServer((req, res) => {
  beeRequests.push(`${req.method} ${req.url}`)
  req.resume()
  if (beeFails) {
    res.writeHead(502)
    res.end()
  } else if (/^\/bzz\/(?:[0-9a-f]{64}|site\.eth)\/$/.test(req.url ?? '')) {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!DOCTYPE html><h1>site</h1>')
  } else {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 404, message: 'Not Found' }))
  }
})

const rpc = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    const call = JSON.parse(Buffer.concat(chunks).toString())
    const name = Object.keys(CONTENTHASHES).find(x => encodeResolveContenthash(x) === call.params[0].data)
    rpcNames.push(name ?? 'unknown')
    if (rpcFails) {
      res.writeHead(502)
      res.end()
      return
    }
    const answer =
      name === undefined
        ? { error: { code: 3, message: 'execution reverted' } }
        : { result: encodeResolveAnswer(CONTENTHASHES[name] ?? '') }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, ...answer }))
  })
})

async function listen(server: Server): Promise<number> {
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

async function startGateway(config: Partial<AppConfig> = {}): Promise<number> {
  const beeApiUrl = `http://127.0.0.1:${(bee.address() as AddressInfo).port}`
  const ensRpcUrl = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`
  const stampManager = new StampManager(beeApiUrl, {
    hardcodedStamp: 'aa'.repeat(32),
    postageThresholdUsage: 0.85,
    postageThresholdSeconds: 3600,
    postageKeepAlive: false,
  })
  await stampManager.start()
  const app = createApp(
    { beeApiUrl, hostname: 'gw.local', removePinHeader: true, ensRpcUrl, ...config },
    stampManager,
    new PostageBatchDispenserService({ url: '', secret: '' }),
  )
  return listen(http.createServer(app))
}

function request(
  port: number,
  path: string,
  headers: http.OutgoingHttpHeaders = {},
  method = 'GET',
  body?: string,
): Promise<{ status: number; location: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

before(async () => {
  mock.method(Database, 'isDatabaseConfigured', () => databaseConfigured)
  mock.method(Database, 'getRows', async () => [])
  mock.method(Database, 'getOnlyRowOrNull', async (query: string, ...params: unknown[]) => {
    ruleQueries++
    return query.includes('FROM rules') && Array.isArray(params[0]) && params[0].includes(DENIED)
      ? { hash: DENIED, mode: 'deny' }
      : null
  })
  mock.method(Feed, 'resolveFeed', async () => {
    feedLookups++
    return null
  })
  await listen(bee)
  await listen(rpc)
})

after(() => {
  mock.restoreAll()
  for (const server of servers) {
    server.close()
  }
})

beforeEach(() => {
  beeRequests.length = 0
  rpcNames.length = 0
  rpcFails = false
  beeFails = false
  databaseConfigured = true
  ruleQueries = 0
  feedLookups = 0
  Cache.clear()
  SharedAnswers.forgetAll()
})

afterEach(() => {
  mock.timers.reset()
})

describe('ENS_RPC_URL setting', () => {
  it('is read from the environment', () => {
    assert.equal(getAppConfig({ ENS_RPC_URL: 'https://rpc.example.com' }).ensRpcUrl, 'https://rpc.example.com')
    assert.equal(getAppConfig({}).ensRpcUrl, '')
  })
})

describe('connection timeouts', () => {
  it('keep an idle connection for 65 seconds and wait a little longer for headers', () => {
    const server = http.createServer()
    applyConnectionTimeouts(server)
    assert.equal(server.keepAliveTimeout, 65_000)
    assert.equal(server.headersTimeout, 66_000)
  })
})

describe('the app config as it is logged', () => {
  it('hides the secrets and the urls that can carry a key, and keeps the rest', () => {
    const config = getAppConfig({
      AUTH_SECRET: 'auth-value',
      MODERATION_SECRET: 'moderation-value',
      MATTERMOST_WEBHOOK_URL: 'https://chat.example.com/hooks/value',
      ENS_RPC_URL: 'https://rpc.example.com/v3/value',
      HOSTNAME: 'gw.example.com',
    })
    const logged = redactAppConfig(config)
    assert.ok(!JSON.stringify(logged).includes('value'), JSON.stringify(logged))
    assert.equal(logged.hostname, 'gw.example.com')
    assert.equal(logged.authorization, '[redacted]')
    assert.equal(config.authorization, 'auth-value')
    assert.equal(redactAppConfig(getAppConfig({})).ensRpcUrl, '')
  })
})

describe('ens names resolved by the gateway', () => {
  let port: number

  before(async () => {
    port = await startGateway()
  })

  it('asks Bee by hash for an ens path', async () => {
    assert.equal((await request(port, '/bzz/site.eth/')).status, 200)
    assert.deepEqual(beeRequests, [`GET /bzz/${SITE}/`])
    assert.deepEqual(rpcNames, ['site.eth'])
  })

  it('asks Bee by hash for an ens subdomain and still applies the ens rule', async () => {
    assert.equal((await request(port, '/', { host: 'site.gw.local' })).status, 200)
    assert.deepEqual(beeRequests, [`GET /bzz/${SITE}/`])
  })

  it('answers HEAD on an ens subdomain from the site, asking Bee with GET', async () => {
    assert.equal((await request(port, '/', { host: 'site.gw.local' }, 'HEAD')).status, 200)
    assert.deepEqual(beeRequests, [`GET /bzz/${SITE}/`])
  })

  it('still treats the bare hash as a website', async () => {
    const response = await request(port, `/bzz/${SITE}/`)
    assert.equal(response.status, 302)
    assert.equal(response.location, `/forbidden?hash=${SITE}`)
  })

  it('matches rules against the resolved reference', async () => {
    const response = await request(port, '/', { host: 'denied.gw.local' })
    assert.equal(response.status, 302)
    assert.equal(response.location, `/forbidden?hash=${DENIED}`)
    assert.equal((await request(port, '/bzz/DENIED.ETH/')).status, 302)
  })

  for (const name of ['nocontent.eth', 'ipfs.eth', 'unknown.eth']) {
    it(`does not serve ${name}, which has no swarm contenthash`, async () => {
      assert.equal((await request(port, `/bzz/${name}/`)).status, 404)
      assert.deepEqual(beeRequests, [])
    })
  }

  it('does not serve a name when the rpc fails', async () => {
    rpcFails = true
    assert.equal((await request(port, '/', { host: 'site.gw.local' })).status, 404)
    assert.deepEqual(beeRequests, [])
  })

  it('passes the tls check for a name with a swarm contenthash only', async () => {
    assert.equal((await request(port, '/tls-check?domain=site.gw.local')).status, 200)
    assert.equal((await request(port, '/tls-check?domain=nocontent.gw.local')).status, 403)
    assert.equal((await request(port, '/tls-check?domain=ipfs.gw.local')).status, 403)
    assert.deepEqual(beeRequests, [])
  })

  it('does not cache a failed tls check lookup as not servable', async () => {
    rpcFails = true
    assert.equal((await request(port, '/tls-check?domain=site.gw.local')).status, 403)
    rpcFails = false
    assert.equal((await request(port, '/tls-check?domain=site.gw.local')).status, 200)
  })
})

describe('ens answers under load and while the rpc fails', () => {
  let port: number

  before(async () => {
    port = await startGateway()
  })

  it('makes one rpc call for concurrent requests to a name', async () => {
    const statuses = await Promise.all(
      Array.from({ length: 5 }, async () => (await request(port, '/', { host: 'site.gw.local' })).status),
    )
    assert.deepEqual(statuses, Array(5).fill(200))
    assert.deepEqual(rpcNames, ['site.eth'])
  })

  it('makes one rpc call for concurrent tls checks of a name', async () => {
    const statuses = await Promise.all(
      Array.from({ length: 5 }, async () => (await request(port, '/tls-check?domain=site.gw.local')).status),
    )
    assert.deepEqual(statuses, Array(5).fill(200))
    assert.deepEqual(rpcNames, ['site.eth'])
  })

  it('keeps serving a name the rpc resolved before when a refresh fails', async () => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() })
    assert.equal((await request(port, '/', { host: 'site.gw.local' })).status, 200)
    mock.timers.tick(Dates.minutes(11))
    rpcFails = true
    assert.equal((await request(port, '/', { host: 'site.gw.local' })).status, 200)
    assert.equal((await request(port, '/tls-check?domain=site.gw.local')).status, 200)
    assert.deepEqual(rpcNames, ['site.eth', 'site.eth'])
  })

  it('still answers 404 for a name never resolved while the rpc fails', async () => {
    rpcFails = true
    assert.equal((await request(port, '/', { host: 'home.gw.local' })).status, 404)
    assert.equal((await request(port, '/tls-check?domain=home.gw.local')).status, 403)
    assert.deepEqual(beeRequests, [])
  })
})

describe('tls checks through Bee while Bee fails', () => {
  it('keeps passing a name that passed before, and fails one never checked', async () => {
    const port = await startGateway({ ensRpcUrl: '' })
    mock.timers.enable({ apis: ['Date'], now: Date.now() })
    assert.equal((await request(port, '/tls-check?domain=site.gw.local')).status, 200)
    mock.timers.tick(Dates.minutes(11))
    beeFails = true
    assert.equal((await request(port, '/tls-check?domain=site.gw.local')).status, 200)
    assert.equal((await request(port, '/tls-check?domain=home.gw.local')).status, 403)
  })
})

describe('moderation rules without a database', () => {
  it('are not looked up, and the default rules still decide', async () => {
    databaseConfigured = false
    const port = await startGateway()
    assert.equal((await request(port, '/bzz/site.eth/')).status, 200)
    assert.equal((await request(port, '/', { host: 'denied.gw.local' })).status, 200)
    const response = await request(port, `/bzz/${SITE}/`)
    assert.equal(response.status, 302)
    assert.equal(response.location, `/forbidden?hash=${SITE}`)
    assert.equal(ruleQueries, 0)
    assert.equal(feedLookups, 0)
  })
})

describe('an ens homepage resolved by the gateway', () => {
  it('is fetched from Bee by hash', async () => {
    const port = await startGateway({ homepage: 'home.eth' })
    assert.equal((await request(port, '/')).status, 200)
    assert.deepEqual(beeRequests, [`GET /bzz/${HOMEPAGE}/`])
  })
})

describe('without ENS_RPC_URL', () => {
  it('hands the name to Bee as before', async () => {
    const port = await startGateway({ ensRpcUrl: '' })
    await request(port, '/', { host: 'site.gw.local' })
    assert.ok(beeRequests.includes('GET /bzz/site.eth/'), beeRequests.join(', '))
    assert.deepEqual(rpcNames, [])
  })
})

describe('ALLOWED_ENS_NAMES setting', () => {
  it('is read as a space- or comma-separated list', () => {
    assert.deepEqual(getAppConfig({ ALLOWED_ENS_NAMES: ' Site.eth, home.eth  other.eth,' }).allowedEnsNames, [
      'site.eth',
      'home.eth',
      'other.eth',
    ])
    assert.deepEqual(getAppConfig({}).allowedEnsNames, [])
  })

  it('names the entries that do not end in .eth, which match no subdomain', () => {
    assert.deepEqual(getNamesWithoutEth(['site.eth', 'site', 'site.com', 'Other.ETH']), ['site', 'site.com'])
    assert.deepEqual(getNamesWithoutEth([]), [])
  })
})

describe('serving only listed ens names', () => {
  let port: number

  before(async () => {
    port = await startGateway({ allowedEnsNames: ['site.eth', 'denied.eth'] })
  })

  it('serves a listed name by hash under the ens rule', async () => {
    assert.equal((await request(port, '/', { host: 'Site.gw.local' })).status, 200)
    assert.deepEqual(beeRequests, [`GET /bzz/${SITE}/`])
  })

  it('still applies moderation rules to a listed name', async () => {
    assert.equal((await request(port, '/', { host: 'denied.gw.local' })).status, 302)
  })

  it('answers 404 for a subdomain that is not listed, without asking Bee or the rpc', async () => {
    assert.equal((await request(port, '/', { host: 'home.gw.local' })).status, 404)
    assert.equal((await request(port, '/', { host: `${SITE}.gw.local` })).status, 404)
    assert.deepEqual(beeRequests, [])
    assert.deepEqual(rpcNames, [])
  })

  it('fails the tls check for a subdomain that is not listed', async () => {
    assert.equal((await request(port, '/tls-check?domain=site.gw.local')).status, 200)
    assert.equal((await request(port, '/tls-check?domain=home.gw.local')).status, 403)
    assert.equal((await request(port, `/tls-check?domain=${SITE}.gw.local`)).status, 403)
  })
})

describe('serving only listed ens names, away from their subdomains', () => {
  let port: number

  before(async () => {
    port = await startGateway({ allowedEnsNames: ['site.eth'] })
  })

  const refused: [string, string, string, http.OutgoingHttpHeaders][] = [
    ['an unlisted name on the main hostname', 'GET', '/bzz/home.eth/', { host: 'gw.local' }],
    ['a listed name on the main hostname', 'GET', '/bzz/site.eth/', { host: 'gw.local' }],
    ['a hash on the main hostname', 'GET', `/bzz/${SITE}/`, { host: 'gw.local' }],
    ['bytes on the main hostname', 'GET', `/bytes/${SITE}`, { host: 'gw.local' }],
    ['chunks on the main hostname', 'GET', `/chunks/${SITE}`, { host: 'gw.local' }],
    ['feeds on the main hostname', 'GET', `/feeds/${'a5'.repeat(20)}/${'a6'.repeat(32)}`, { host: 'gw.local' }],
    ['stamps on the main hostname', 'GET', '/batches', { host: 'gw.local' }],
    ['an unlisted name on an IP host', 'GET', '/bzz/home.eth/', { host: '10.0.0.1' }],
    ['a hash on an IP host', 'GET', `/bzz/${SITE}/`, { host: '10.0.0.1' }],
    ['an upload on the main hostname', 'POST', '/bytes', { host: 'gw.local', 'content-type': 'text/plain' }],
    ['an upload on an IP host', 'POST', '/bzz', { host: '10.0.0.1', 'content-type': 'text/plain' }],
    ['an upload on a listed subdomain', 'POST', '/bytes', { host: 'site.gw.local', 'content-type': 'text/plain' }],
  ]

  for (const [label, method, path, headers] of refused) {
    it(`answers 404 for ${label}, without asking Bee or the rpc`, async () => {
      assert.equal((await request(port, path, headers, method, method === 'POST' ? 'hello' : undefined)).status, 404)
      assert.deepEqual(beeRequests, [])
      assert.deepEqual(rpcNames, [])
    })
  }

  it('reads /batches on a listed subdomain from the site, never from the stamps of Bee', async () => {
    await request(port, '/batches', { host: 'site.gw.local' })
    assert.ok(beeRequests.length > 0)
    assert.ok(
      beeRequests.every(x => x.startsWith(`GET /bzz/${SITE}/batches`)),
      beeRequests.join(', '),
    )
  })

  it('answers HEAD on a listed subdomain from the site', async () => {
    assert.equal((await request(port, '/', { host: 'site.gw.local' }, 'HEAD')).status, 200)
    assert.deepEqual(beeRequests, [`GET /bzz/${SITE}/`])
  })

  it('still serves a listed name on its subdomain', async () => {
    assert.equal((await request(port, '/', { host: 'site.gw.local' })).status, 200)
    assert.deepEqual(beeRequests, [`GET /bzz/${SITE}/`])
  })

  it('still answers health and metrics on the main hostname', async () => {
    assert.equal((await request(port, '/health', { host: 'gw.local' })).status, 200)
    assert.equal((await request(port, '/metrics', { host: 'gw.local' })).status, 200)
    assert.equal((await request(port, '/tls-check?domain=site.gw.local', { host: 'gw.local' })).status, 200)
    assert.equal((await request(port, '/tls-check?domain=home.gw.local', { host: 'gw.local' })).status, 403)
  })
})

describe('without ALLOWED_ENS_NAMES', () => {
  it('serves the main hostname as before', async () => {
    const port = await startGateway()
    assert.equal((await request(port, '/bzz/site.eth/', { host: 'gw.local' })).status, 200)
    assert.equal((await request(port, '/bzz/site.eth/', { host: '10.0.0.1' })).status, 200)
    assert.deepEqual(beeRequests, [`GET /bzz/${SITE}/`, `GET /bzz/${SITE}/`])
  })
})

describe('serving listed ens names without ENS_RPC_URL', () => {
  it('hands a listed name to Bee and refuses the rest', async () => {
    const port = await startGateway({ ensRpcUrl: '', allowedEnsNames: ['site.eth'] })
    await request(port, '/', { host: 'site.gw.local' })
    assert.ok(beeRequests.includes('GET /bzz/site.eth/'), beeRequests.join(', '))
    assert.equal((await request(port, '/', { host: 'home.gw.local' })).status, 404)
    assert.ok(!beeRequests.includes('GET /bzz/home.eth/'), beeRequests.join(', '))
  })
})
