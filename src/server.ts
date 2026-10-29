import { Bee } from '@ethersphere/bee-js'
import { Arrays, Dates, Numbers, Objects, Strings, Types } from 'cafe-utility'
import express, { Application, NextFunction, Request, Response } from 'express'
import { Server } from 'http'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { EnsOptions, isServableSubdomain } from './bzz-link'
import { checkChallenge, createChallenge } from './challenge'
import { AppConfig, ReadinessMode } from './config'
import { ApprovalRequests } from './database/ApprovalRequests'
import { runQuery } from './database/Database'
import { Reports } from './database/Reports'
import { Rules } from './database/Rules'
import { logger } from './logger'
import { METRICS_CONTENT_TYPE, renderMetrics } from './metrics'
import { getNotFoundPage } from './not-found'
import { createProxyEndpoints, createSubdomainHandler, hasDotSegment, isSubdomainRequest, ProxyOptions } from './proxy'
import { checkReadiness } from './readiness'
import { resolveFeed } from './services/feed'
import { sendMattermostAlert } from './services/mattermost'
import { PostageBatchDispenserService } from './services/postage-batch-dispenser'
import { resolveSwarmReference } from './services/universal-resolver'
import { StampManager } from './stamp'

function handleErrors(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    handler(req, res).catch(error => {
      logger.error('request failed', { path: req.path, error })
      if (res.headersSent) {
        res.destroy()
      } else {
        res.sendStatus(500)
      }
    })
  }
}

const ENS_NAME = /\.eth$/i

/**
 * What stays reachable on any Host while ALLOWED_ENS_NAMES is set: liveness, readiness, metrics, and
 * the TLS check, which a certificate for a listed name's subdomain is issued through.
 */
const OPERATOR_PATHS = new Set(['/health', '/readiness', '/metrics', '/tls-check'])

/** The homepage as Bee should be asked for it: an ENS name becomes its Swarm reference when the gateway resolves ENS. */
async function resolveHomepage(homepage: string, ens: EnsOptions): Promise<string | null> {
  return ens.rpcUrl && ENS_NAME.test(homepage) ? resolveSwarmReference(ens.rpcUrl, homepage) : homepage
}

/**
 * Reverse proxies commonly hold an idle upstream connection for 60 seconds, so the gateway keeps one
 * open longer than that and never closes it under a request the proxy is sending. Node requires the
 * headers timeout to exceed the keep-alive timeout.
 */
export const KEEP_ALIVE_TIMEOUT = Dates.seconds(65)
export const HEADERS_TIMEOUT = Dates.seconds(66)

export function applyConnectionTimeouts(server: Server) {
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT
  server.headersTimeout = HEADERS_TIMEOUT
}

export function createApp(
  config: AppConfig,
  stampManager: StampManager,
  postageBatchDispenser: PostageBatchDispenserService,
): Application {
  const bee = new Bee(config.beeApiUrl)
  const app = express()
  const ens: EnsOptions = { rpcUrl: config.ensRpcUrl, allowedNames: config.allowedEnsNames }

  const postSizeLimit = Numbers.makeStorage(
    Arrays.getArgument(process.argv, 'post-size-limit', process.env, 'POST_SIZE_LIMIT') || '1gb',
  )
  const parseBody = express.raw({ type: () => true })

  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*')
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.set(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, Content-Disposition, swarm-postage-batch-id, swarm-postage-stamp, x-swarm-postage-token, swarm-deferred-upload, swarm-encrypt, swarm-collection, swarm-redundancy-level',
    )
    // Let browser clients read the allow-list (not a safelisted response header) so they
    // can drop headers this gateway refuses, and read Swarm-Feed-Index off feed responses.
    res.set('Access-Control-Expose-Headers', 'Access-Control-Allow-Headers, Swarm-Feed-Index')

    if (req.method === 'OPTIONS') {
      res.sendStatus(200)
      return
    }
    next()
  })

  app.use((req, res, next) => {
    if (hasDotSegment(req.path)) {
      res.status(400)
      res.send({ error: 'bad path' })
      return
    }
    next()
  })

  const subdomainOffset = config.hostname.split('.').length
  app.set('subdomain offset', subdomainOffset)

  if (config.authorization) {
    app.use('', (req, res, next) => {
      if (req.headers.authorization === config.authorization) {
        next()
      } else if (
        req.method !== 'POST' &&
        Arrays.getBooleanArgument(process.argv, 'soft-auth', process.env, 'SOFT_AUTH')
      ) {
        next()
      } else {
        res.sendStatus(403)
      }
    })
  }

  const proxyOptions: ProxyOptions = {
    beeApiUrl: config.beeApiUrl,
    removePinHeader: config.removePinHeader ?? true,
    stampManager,
    postageBatchDispenser,
    hostname: config.hostname,
    instanceName: config.instanceName,
    postSizeLimit,
    ens,
  }

  if (ens.allowedNames?.length) {
    const serveSubdomain = createSubdomainHandler(proxyOptions)
    app.use((req, res, next) => {
      if (OPERATOR_PATHS.has(req.path)) {
        next()
      } else if (isSubdomainRequest(req, config.hostname)) {
        serveSubdomain(req, res, next)
      } else {
        res.status(404).contentType('text/html').send(getNotFoundPage())
      }
    })
    logger.info(`serving only ${ens.allowedNames.join(', ')} at their subdomains of ${config.hostname}`)
  } else {
    logger.info(`resolving .eth names and CIDs at *.${config.hostname}`)
  }

  app.get('/metrics', (_req, res) => {
    res.set('Content-Type', METRICS_CONTENT_TYPE)
    res.end(renderMetrics())
  })

  app.get('/gateway', (_req, res) => res.send({ gateway: true }))

  app.get('/health', (_req, res) => res.sendStatus(200))

  if (config.hostname) {
    app.get('/tls-check', async (req, res) => {
      const domain = String(req.query.domain ?? '')

      if (domain === config.hostname) {
        res.sendStatus(200)
        return
      }
      const suffix = `.${config.hostname}`
      const valid =
        domain.endsWith(suffix) && (await isServableSubdomain(domain.slice(0, -suffix.length), config.beeApiUrl, ens))
      res.sendStatus(valid ? 200 : 403)
    })
  }

  app.get('/readiness', async (_req, res) => {
    const ready = await checkReadiness(bee, config.readinessMode === ReadinessMode.Strict)

    if (ready) {
      res.sendStatus(200)
    } else {
      res.sendStatus(503)
    }
  })

  app.get('/batches', async (_req, res) => {
    try {
      const batches = await bee.stamp.getAllGlobal()
      res.send(batches.map(x => ({ ...x, owner: x.owner.toString(), batchID: x.batchID.toString() })))
    } catch (error) {
      logger.error('failed to fetch batches', error)
      res.sendStatus(500)
    }
  })

  app.get('/batches/owner/:owner', async (req, res) => {
    try {
      const batches = await bee.stamp.getAllGlobal()
      const owner = req.params.owner.toLowerCase().replace(/^0x/, '')
      res.send(
        batches
          .filter(x => x.owner.toString().toLowerCase().replace(/^0x/, '') === owner)
          .map(x => ({ ...x, owner: x.owner.toString(), batchID: x.batchID.toString() })),
      )
    } catch (error) {
      logger.error('failed to fetch batches by owner', error)
      res.sendStatus(500)
    }
  })

  app.post(
    '/challenge',
    handleErrors(async (_req, res) => {
      res.send(await createChallenge())
    }),
  )

  app.post(
    '/moderation/approval',
    parseBody,
    handleErrors(async (req, res) => {
      const json = JSON.parse(req.body.toString())
      const { hash, ens, challengeId, challengeSolution } = json
      if (!(await checkChallenge(challengeId, challengeSolution))) {
        res.sendStatus(400)
        return
      }

      const existingRequest = await ApprovalRequests.getMany({ hash: Types.asString(hash) }, { limit: 1 })
      if (existingRequest.length) {
        res.sendStatus(200)
        return
      }
      const feed = await resolveFeed(config.beeApiUrl, Types.asString(hash)).catch(() => null)
      await ApprovalRequests.insert({
        hash: Types.asString(hash),
        ens: Types.asNullable(Types.asString, ens),
        feedIndex: feed?.index ?? null,
        feedOwner: feed?.owner ?? null,
        feedTopic: feed?.topic ?? null,
        feedReference: feed?.reference ?? null,
      })
      await sendMattermostAlert(
        `### New moderation approval request\n**Hash**: ${hash}\n**ENS**: ${ens || 'N/A'}` +
          (feed ? `\n**Feed**: yes (index ${feed.index}) — content is mutable and will be monitored` : ''),
      )
      res.sendStatus(200)
    }),
  )

  app.post(
    '/moderation/report',
    parseBody,
    handleErrors(async (req, res) => {
      const json = JSON.parse(req.body.toString())
      const { hash, reason, challengeId, challengeSolution } = json
      if (!(await checkChallenge(challengeId, challengeSolution))) {
        res.sendStatus(400)
        return
      }
      await Reports.insert({ hash: Types.asString(hash), reason })
      res.sendStatus(200)
    }),
  )

  function moderationGuard(req: Request, res: Response, next: NextFunction) {
    if (!config.moderationSecret) {
      res.sendStatus(401)
      return
    }

    if (req.headers.authorization !== config.moderationSecret) {
      res.sendStatus(401)
      return
    }

    next()
  }

  app.get(
    '/moderation',
    moderationGuard,
    handleErrors(async (_req, res) => {
      const reports = await Reports.getMany()
      const rules = await Rules.getMany()

      res.send({ reports, rules })
    }),
  )

  app.post(
    '/moderation/allow',
    moderationGuard,
    parseBody,
    handleErrors(async (req, res) => {
      const json = JSON.parse(req.body.toString())
      const { hash } = json
      const feed = await resolveFeed(config.beeApiUrl, Types.asString(hash)).catch(() => null)
      await Rules.insert({
        hash: Types.asString(hash),
        mode: 'allow',
        feedIndex: feed?.index ?? null,
        feedOwner: feed?.owner ?? null,
        feedTopic: feed?.topic ?? null,
        feedReference: feed?.reference ?? null,
      })
      res.sendStatus(200)
    }),
  )

  app.post(
    '/moderation/deny',
    moderationGuard,
    parseBody,
    handleErrors(async (req, res) => {
      const json = JSON.parse(req.body.toString())
      const { hash } = json
      await Rules.insert({ hash: Types.asString(hash), mode: 'deny' })
      res.sendStatus(200)
    }),
  )

  app.delete(
    '/moderation/rule/:hash',
    moderationGuard,
    handleErrors(async (req, res) => {
      await runQuery(`DELETE FROM rules WHERE hash = ?`, Types.asString(req.params.hash))
      res.sendStatus(200)
    }),
  )

  createProxyEndpoints(app, proxyOptions)

  if (config.homepage) {
    app.use(async (req, res, next) => {
      try {
        const homepage = await resolveHomepage(config.homepage ?? '', ens)
        if (!homepage) {
          next()
          return
        }
        const url =
          Strings.joinUrl([config.beeApiUrl, 'bzz', homepage, req.path]) + Objects.toQueryString(req.query, true)
        logger.debug('attempting to fetch homepage', { url })

        const response = await fetch(url)

        if (!response.ok || !response.body) {
          await response.body?.cancel()
          next()
          return
        }
        if (response.status !== 200) {
          await response.body.cancel()
          logger.error('failed to fetch homepage', { status: response.status })
          res.sendStatus(500)
          return
        }
        res.set('content-type', response.headers.get('content-type') ?? 'application/octet-stream')
        await pipeline(Readable.fromWeb(response.body), res)
      } catch {
        if (res.headersSent) {
          res.destroy()
        } else {
          next()
        }
      }
    })
  }

  app.use(express.static('public', { extensions: ['html'] }))

  app.use((_req, res) => res.sendStatus(404))

  return app
}
