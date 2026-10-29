import { Reference } from '@ethersphere/bee-js'
import { Cache, Dates, Strings } from 'cafe-utility'
import { isDatabaseConfigured } from './database/Database'
import { Rewrites, RewritesRow } from './database/Rewrites'
import { lookupSwarmReference } from './services/universal-resolver'

export interface EnsOptions {
  /** Ethereum mainnet JSON-RPC endpoint. When set, the gateway resolves `.eth` names itself. */
  rpcUrl?: string | undefined
}

export const SUBDOMAIN = /^[0-9a-z.-]+$/i

export class NotEnabledError extends Error {}

export async function isServableSubdomain(
  subdomain: string,
  beeApiUrl: string,
  ens: EnsOptions = {},
): Promise<boolean> {
  if (!SUBDOMAIN.test(subdomain)) {
    return false
  }
  try {
    return await Cache.get(`tls-check:${subdomain}`, Dates.minutes(10), async () => {
      if (await Rewrites.getOneOrNull({ subdomain }).catch(() => null)) {
        return true
      }
      try {
        new Reference(subdomain)
        return true
      } catch {
        const ensName = `${subdomain}.eth`
        return ens.rpcUrl
          ? (await lookupSwarmReference(ens.rpcUrl, ensName)) !== null
          : resolvesOnBee(ensName, beeApiUrl)
      }
    })
  } catch {
    return false
  }
}

async function resolvesOnBee(ensName: string, beeApiUrl: string): Promise<boolean> {
  const response = await fetch(Strings.joinUrl([beeApiUrl, 'bzz', ensName, '/']), {
    redirect: 'manual',
    signal: AbortSignal.timeout(Dates.seconds(10)),
  })
  await response.body?.cancel()
  if (response.status >= 500) {
    throw Error(`ens resolution responded with ${response.status} for ${ensName}`)
  }

  return response.status < 400
}

export async function subdomainToBzz(subdomain: string): Promise<string> {
  const rewrites = isDatabaseConfigured()
    ? await Cache.get<RewritesRow[]>('rewrites', Dates.minutes(1), () => Rewrites.getMany())
    : []
  const rewrite = rewrites.find(x => x.subdomain === subdomain)
  if (rewrite) {
    return rewrite.target
  }
  try {
    return new Reference(subdomain).toHex()
  } catch (e) {
    return `${subdomain}.eth`
  }
}
