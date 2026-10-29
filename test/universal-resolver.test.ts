process.env.LOG_LEVEL = 'critical'

import { Binary, Cache, Dates } from 'cafe-utility'
import assert from 'node:assert/strict'
import http, { Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test'
import {
  decodeResolveContenthash,
  dnsEncode,
  encodeResolveContenthash,
  namehash,
  resolveSwarmReference,
  swarmReferenceFromContenthash,
  UNIVERSAL_RESOLVER_ADDRESS,
} from '../src/services/universal-resolver'
import { SharedAnswers } from '../src/shared-answers'
import { encodeResolveAnswer, SOLARPUNKID } from './universal-resolver-fixtures'

const SWARM_PREFIX = 'e40101fa011b20'
const IPFS_CONTENTHASH = 'e3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f'

type RpcBody = { result?: string; error?: { code: number; message: string } } | 'http-error'

let rpcBody: RpcBody = { result: '0x' }
const rpcCalls: { to: string; data: string }[] = []
const servers: Server[] = []
let rpcUrl = ''

before(async () => {
  const rpc = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const call = JSON.parse(Buffer.concat(chunks).toString())
      rpcCalls.push(call.params[0])
      if (rpcBody === 'http-error') {
        res.writeHead(503)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, ...rpcBody }))
    })
  })
  servers.push(rpc)
  await new Promise<void>(resolve => rpc.listen(0, '127.0.0.1', resolve))
  rpcUrl = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`
})

after(() => {
  for (const server of servers) {
    server.close()
  }
})

beforeEach(() => {
  rpcCalls.length = 0
  Cache.clear()
  SharedAnswers.forgetAll()
})

describe('ens encoding', () => {
  it('dns-encodes a name per ENSIP-10', () => {
    assert.equal(Binary.uint8ArrayToHex(dnsEncode(SOLARPUNKID.name)), SOLARPUNKID.dnsEncoded)
  })

  it('refuses an empty label', () => {
    assert.throws(() => dnsEncode('a..eth'))
  })

  it('computes the EIP-137 namehash', () => {
    assert.equal('bc1c58d1' + Binary.uint8ArrayToHex(namehash(SOLARPUNKID.name)), SOLARPUNKID.contenthashCall)
    assert.ok(Binary.equals(namehash(''), new Uint8Array(32)))
  })

  it('encodes resolve(bytes,bytes) around contenthash(bytes32)', () => {
    assert.equal(encodeResolveContenthash(SOLARPUNKID.name), SOLARPUNKID.resolveCall)
  })

  it('decodes the answer and the resolver', () => {
    const decoded = decodeResolveContenthash(SOLARPUNKID.resolveAnswer)
    assert.equal(Binary.uint8ArrayToHex(decoded.contenthash), SOLARPUNKID.contenthash)
    assert.equal(decoded.resolver, SOLARPUNKID.resolver)
  })

  it('builds the same answer as the recorded one', () => {
    assert.equal(encodeResolveAnswer(SOLARPUNKID.contenthash), SOLARPUNKID.resolveAnswer)
  })

  it('reads the Swarm reference from a Swarm contenthash only', () => {
    const contenthash = Binary.hexToUint8Array(SOLARPUNKID.contenthash)
    assert.equal(swarmReferenceFromContenthash(contenthash), SOLARPUNKID.contenthash.slice(SWARM_PREFIX.length))
    assert.equal(swarmReferenceFromContenthash(Binary.hexToUint8Array(IPFS_CONTENTHASH)), null)
    assert.equal(swarmReferenceFromContenthash(contenthash.subarray(0, -1)), null)
    assert.equal(swarmReferenceFromContenthash(new Uint8Array(0)), null)
  })
})

describe('resolving a swarm reference', () => {
  const reference = SOLARPUNKID.contenthash.slice(SWARM_PREFIX.length)

  it('asks the universal resolver and returns the reference', async () => {
    rpcBody = { result: SOLARPUNKID.resolveAnswer }
    assert.equal(await resolveSwarmReference(rpcUrl, SOLARPUNKID.name), reference)
    assert.deepEqual(rpcCalls, [{ to: UNIVERSAL_RESOLVER_ADDRESS, data: SOLARPUNKID.resolveCall }])
  })

  it('lowercases the name and caches the answer', async () => {
    rpcBody = { result: SOLARPUNKID.resolveAnswer }
    assert.equal(await resolveSwarmReference(rpcUrl, 'SolarPunkID.eth'), reference)
    assert.equal(await resolveSwarmReference(rpcUrl, SOLARPUNKID.name), reference)
    assert.equal(rpcCalls.length, 1)
    assert.equal(rpcCalls[0]?.data, SOLARPUNKID.resolveCall)
  })

  it('answers null when there is no contenthash', async () => {
    rpcBody = { result: encodeResolveAnswer('') }
    assert.equal(await resolveSwarmReference(rpcUrl, SOLARPUNKID.name), null)
  })

  it('answers null for a contenthash of another codec', async () => {
    rpcBody = { result: encodeResolveAnswer(IPFS_CONTENTHASH) }
    assert.equal(await resolveSwarmReference(rpcUrl, SOLARPUNKID.name), null)
  })

  it('answers null for an empty result', async () => {
    rpcBody = { result: '0x' }
    assert.equal(await resolveSwarmReference(rpcUrl, SOLARPUNKID.name), null)
  })

  it('answers null when the call reverts', async () => {
    rpcBody = { error: { code: 3, message: 'execution reverted' } }
    assert.equal(await resolveSwarmReference(rpcUrl, SOLARPUNKID.name), null)
  })

  it('answers null on an rpc error and does not cache it', async () => {
    rpcBody = { error: { code: -32005, message: 'rate limited' } }
    assert.equal(await resolveSwarmReference(rpcUrl, SOLARPUNKID.name), null)
    rpcBody = { result: SOLARPUNKID.resolveAnswer }
    assert.equal(await resolveSwarmReference(rpcUrl, SOLARPUNKID.name), reference)
  })

  it('answers null when the rpc endpoint fails', async () => {
    rpcBody = 'http-error'
    assert.equal(await resolveSwarmReference(rpcUrl, SOLARPUNKID.name), null)
  })

  it('answers null for a malformed result', async () => {
    rpcBody = { result: '0x1234' }
    assert.equal(await resolveSwarmReference(rpcUrl, SOLARPUNKID.name), null)
  })

  it('answers null when the endpoint is unreachable', async () => {
    assert.equal(await resolveSwarmReference('http://127.0.0.1:1', SOLARPUNKID.name), null)
  })

  it('answers null for a name that cannot be encoded, without calling the rpc', async () => {
    assert.equal(await resolveSwarmReference(rpcUrl, 'a..eth'), null)
    assert.equal(rpcCalls.length, 0)
  })
})

describe('sharing and keeping swarm references', () => {
  const reference = SOLARPUNKID.contenthash.slice(SWARM_PREFIX.length)

  afterEach(() => {
    mock.timers.reset()
  })

  it('makes one rpc call for concurrent lookups of a name', async () => {
    rpcBody = { result: SOLARPUNKID.resolveAnswer }
    const answers = await Promise.all(Array.from({ length: 5 }, () => resolveSwarmReference(rpcUrl, SOLARPUNKID.name)))
    assert.deepEqual(answers, Array(5).fill(reference))
    assert.equal(rpcCalls.length, 1)
  })

  it('serves the last good reference when a refresh fails', async () => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() })
    rpcBody = { result: SOLARPUNKID.resolveAnswer }
    assert.equal(await resolveSwarmReference(rpcUrl, SOLARPUNKID.name), reference)
    mock.timers.tick(Dates.minutes(2))
    rpcBody = 'http-error'
    assert.equal(await resolveSwarmReference(rpcUrl, SOLARPUNKID.name), reference)
    assert.equal(rpcCalls.length, 2)
  })

  it('stops serving the last good reference a day after it was read', async () => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() })
    rpcBody = { result: SOLARPUNKID.resolveAnswer }
    assert.equal(await resolveSwarmReference(rpcUrl, SOLARPUNKID.name), reference)
    mock.timers.tick(Dates.hours(25))
    rpcBody = 'http-error'
    assert.equal(await resolveSwarmReference(rpcUrl, SOLARPUNKID.name), null)
  })

  it('serves a new reference once a refresh succeeds', async () => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() })
    rpcBody = { result: SOLARPUNKID.resolveAnswer }
    assert.equal(await resolveSwarmReference(rpcUrl, SOLARPUNKID.name), reference)
    mock.timers.tick(Dates.minutes(2))
    rpcBody = { result: encodeResolveAnswer(SWARM_PREFIX + 'b1'.repeat(32)) }
    assert.equal(await resolveSwarmReference(rpcUrl, SOLARPUNKID.name), 'b1'.repeat(32))
  })

  it('does not bring back a contenthash that was cleared, when the rpc fails after the clear', async () => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() })
    rpcBody = { result: SOLARPUNKID.resolveAnswer }
    assert.equal(await resolveSwarmReference(rpcUrl, SOLARPUNKID.name), reference)
    mock.timers.tick(Dates.minutes(2))
    rpcBody = { result: encodeResolveAnswer('') }
    assert.equal(await resolveSwarmReference(rpcUrl, SOLARPUNKID.name), null)
    mock.timers.tick(Dates.minutes(2))
    rpcBody = 'http-error'
    assert.equal(await resolveSwarmReference(rpcUrl, SOLARPUNKID.name), null)
  })

  it('answers null for a name never resolved while the rpc fails', async () => {
    rpcBody = 'http-error'
    assert.equal(await resolveSwarmReference(rpcUrl, SOLARPUNKID.name), null)
  })
})
