import { Cache, Dates, Strings } from 'cafe-utility'
import { logger } from '../logger'
import { resolveFeed } from './feed'
import { lookupSwarmReference } from './universal-resolver'

/**
 * The references an ENS name stands for in moderation rules: the one it points to and, when that is
 * a feed manifest, the feed's current content. Read through the Universal Resolver when an
 * `ensRpcUrl` is given, otherwise through Bee.
 */
export async function resolveEnsReferences(beeApiUrl: string, name: string, ensRpcUrl = ''): Promise<string[]> {
  try {
    return await Cache.get(`ens:${name}`, Dates.minutes(1), async () => {
      const reference = ensRpcUrl ? await lookupSwarmReference(ensRpcUrl, name) : await resolveOnBee(beeApiUrl, name)
      if (!reference) {
        throw Error(`no swarm contenthash for ${name}`)
      }
      const feed = await resolveFeed(beeApiUrl, reference)
      return feed?.reference ? [reference, feed.reference] : [reference]
    })
  } catch (error) {
    logger.warn('ens resolution failed', { name, error })
    return []
  }
}

async function resolveOnBee(beeApiUrl: string, name: string): Promise<string> {
  const response = await fetch(Strings.joinUrl([beeApiUrl, 'bytes', name]), {
    headers: { Range: 'bytes=0-0' },
    redirect: 'manual',
    signal: AbortSignal.timeout(Dates.seconds(30)),
  })
  await response.body?.cancel()
  if (!response.ok) {
    throw Error(`ens resolution responded with ${response.status} for ${name}`)
  }
  const reference = Strings.searchHex(response.headers.get('etag') ?? '', 64)
  if (!reference) {
    throw Error(`no reference in ETag for ${name}`)
  }
  return reference
}
