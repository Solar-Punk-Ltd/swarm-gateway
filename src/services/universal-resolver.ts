import { Binary, Dates } from 'cafe-utility'
import { logger } from '../logger'
import { SharedAnswers } from '../shared-answers'

/**
 * ENS Universal Resolver on Ethereum mainnet. It follows names that ENS migrated to ENSv2,
 * which the old registry that Bee reads no longer resolves.
 */
export const UNIVERSAL_RESOLVER_ADDRESS = '0xeeeeeeee14d718c2b47d9923deab1335e144eeee'

const RESOLVE_SELECTOR = '9061b923'
const CONTENTHASH_SELECTOR = 'bc1c58d1'
const SWARM_CONTENTHASH_PREFIX = 'e40101fa011b20'
const SWARM_REFERENCE_LENGTH = 32
const WORD = 32
const MAX_LABEL_LENGTH = 255
const ADDRESS_WORD_PADDING = 12
const RPC_TIMEOUT = Dates.seconds(10)
const CACHE_TTL = Dates.minutes(1)
const STALE_LIMIT = Dates.hours(24)
const EXECUTION_REVERTED = 3

export interface ResolvedContenthash {
  contenthash: Uint8Array
  resolver: string
}

interface JsonRpcAnswer {
  result?: unknown
  error?: { code?: number; message?: string }
}

class RpcRevertError extends Error {}

const swarmReferences = new SharedAnswers<string | null>({
  label: 'ens contenthash',
  freshFor: CACHE_TTL,
  staleFor: STALE_LIMIT,
  isGood: reference => reference !== null,
})

/** DNS wire format of a name as ENSIP-10 asks for it: length-prefixed labels, then a zero byte. */
export function dnsEncode(name: string): Uint8Array {
  const labels = name.split('.').map(label => new TextEncoder().encode(label))
  const parts: Uint8Array[] = []
  for (const label of labels) {
    if (label.length === 0 || label.length > MAX_LABEL_LENGTH) {
      throw Error(`label of length ${label.length} in ${name}`)
    }
    parts.push(new Uint8Array([label.length]), label)
  }
  parts.push(new Uint8Array([0]))
  return Binary.concatBytes(...parts)
}

/** EIP-137 namehash. */
export function namehash(name: string): Uint8Array {
  let node: Uint8Array = new Uint8Array(WORD)
  if (!name) {
    return node
  }
  for (const label of name.split('.').reverse()) {
    node = Binary.keccak256(Binary.concatBytes(node, Binary.keccak256(new TextEncoder().encode(label))))
  }
  return node
}

/** Calldata of `resolve(bytes name, bytes data)` whose inner call is `contenthash(namehash(name))`. */
export function encodeResolveContenthash(name: string): string {
  const innerCall = Binary.concatBytes(Binary.hexToUint8Array(CONTENTHASH_SELECTOR), namehash(name))
  const encodedName = encodeBytes(dnsEncode(name))
  const nameOffset = 2 * WORD
  const dataOffset = nameOffset + encodedName.length
  const head = Binary.concatBytes(encodeUint(nameOffset), encodeUint(dataOffset))
  return '0x' + RESOLVE_SELECTOR + Binary.uint8ArrayToHex(Binary.concatBytes(head, encodedName, encodeBytes(innerCall)))
}

/** Decodes the `(bytes answer, address resolver)` that `resolve` returns, and the `(bytes)` inside the answer. */
export function decodeResolveContenthash(resultHex: string): ResolvedContenthash {
  const result = Binary.hexToUint8Array(stripHexPrefix(resultHex))
  const answer = decodeBytesAt(result, 0)
  const resolver = '0x' + Binary.uint8ArrayToHex(readWord(result, 1).subarray(ADDRESS_WORD_PADDING))
  const contenthash = answer.length ? decodeBytesAt(answer, 0) : new Uint8Array(0)
  return { contenthash, resolver }
}

/** The Swarm reference in a contenthash, or null when the contenthash is not the Swarm codec. */
export function swarmReferenceFromContenthash(contenthash: Uint8Array): string | null {
  const hex = Binary.uint8ArrayToHex(contenthash)
  if (!hex.startsWith(SWARM_CONTENTHASH_PREFIX)) {
    return null
  }
  const reference = hex.slice(SWARM_CONTENTHASH_PREFIX.length)
  return reference.length === SWARM_REFERENCE_LENGTH * 2 ? reference : null
}

/**
 * The Swarm reference an ENS name points to, read through the Universal Resolver.
 * Null when the name has no Swarm contenthash or the lookup fails. Never throws.
 */
export async function resolveSwarmReference(rpcUrl: string, name: string): Promise<string | null> {
  try {
    return await lookupSwarmReference(rpcUrl, name)
  } catch (error) {
    logger.warn('ens contenthash lookup failed', { name, error })
    return null
  }
}

/**
 * Like resolveSwarmReference, but a failed lookup (the endpoint down, an RPC error, a malformed
 * answer) throws instead of answering null, so a caller can avoid caching it as "not found".
 * Concurrent lookups of a name share one RPC call, and while lookups fail, the last reference the
 * name resolved to is served for up to a day after it was read.
 */
export async function lookupSwarmReference(rpcUrl: string, name: string): Promise<string | null> {
  const normalized = name.toLowerCase()
  return swarmReferences.get(normalized, async () => {
    const answer = await callUniversalResolver(rpcUrl, normalized)
    return answer ? swarmReferenceFromContenthash(decodeResolveContenthash(answer).contenthash) : null
  })
}

async function callUniversalResolver(rpcUrl: string, name: string): Promise<string | null> {
  let data: string
  try {
    data = encodeResolveContenthash(name)
  } catch {
    return null
  }
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: UNIVERSAL_RESOLVER_ADDRESS, data }, 'latest'],
    }),
    signal: AbortSignal.timeout(RPC_TIMEOUT),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw Error(`ens rpc responded with ${response.status}`)
  }
  const answer = (await response.json()) as JsonRpcAnswer
  try {
    return readRpcResult(answer)
  } catch (error) {
    if (error instanceof RpcRevertError) {
      return null
    }
    throw error
  }
}

function readRpcResult(answer: JsonRpcAnswer): string | null {
  if (answer.error) {
    const message = answer.error.message ?? ''
    if (answer.error.code === EXECUTION_REVERTED || message.toLowerCase().includes('revert')) {
      throw new RpcRevertError(message)
    }
    throw Error(`ens rpc error ${answer.error.code}: ${message}`)
  }
  if (typeof answer.result !== 'string') {
    throw Error('ens rpc answer has no result')
  }
  return stripHexPrefix(answer.result) ? answer.result : null
}

function encodeUint(value: number): Uint8Array {
  const word = new Uint8Array(WORD)
  new DataView(word.buffer).setUint32(WORD - 4, value)
  return word
}

function encodeBytes(bytes: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil(bytes.length / WORD) * WORD)
  padded.set(bytes)
  return Binary.concatBytes(encodeUint(bytes.length), padded)
}

function readWord(data: Uint8Array, index: number): Uint8Array {
  const start = index * WORD
  if (start + WORD > data.length) {
    throw Error('abi data too short')
  }
  return data.subarray(start, start + WORD)
}

function readUint(word: Uint8Array): number {
  for (let i = 0; i < WORD - 4; i++) {
    if (word[i] !== 0) {
      throw Error('abi integer out of range')
    }
  }
  return new DataView(word.buffer, word.byteOffset, WORD).getUint32(WORD - 4)
}

function decodeBytesAt(data: Uint8Array, wordIndex: number): Uint8Array {
  const offset = readUint(readWord(data, wordIndex))
  if (offset % WORD !== 0) {
    throw Error('abi offset not word aligned')
  }
  const length = readUint(readWord(data, offset / WORD))
  const start = offset + WORD
  if (start + length > data.length) {
    throw Error('abi bytes run past the data')
  }
  return data.subarray(start, start + length)
}

function stripHexPrefix(hex: string): string {
  return hex.startsWith('0x') ? hex.slice(2) : hex
}
