# Swarm Gateway

An HTTP gateway that sits in front of a [Bee](https://github.com/ethersphere/bee) node (Ethereum Swarm) and exposes its content-addressed storage to the web. It handles subdomain routing for ENS names and Swarm hashes, manages postage stamps for uploads, and optionally enforces content moderation rules.

**Proxied endpoints:** `GET /chunks/*`, `GET /bytes/*`, `GET /bzz/*`, `GET /feeds/*`, `POST /chunks`, `POST /bytes`, `POST /bzz`, `POST /soc/*`, `POST /feeds/*`

**Other endpoints:** `GET /health`, `GET /readiness`, `GET /metrics` (Prometheus), `GET /gateway`

## Installation

```sh
npm install
npm run build
```

## Example usage

```sh
HOSTNAME=bzz.limo POSTAGE_AMOUNT=800000000 POSTAGE_DEPTH=17 node dist
```

```
time="2025-04-08T11:52:52.687Z" level="info" msg="log level=info"
time="2025-04-08T11:52:52.911Z" level="info" msg="enabled stamp manager with autobuy"
time="2025-04-08T11:52:52.914Z" level="info" msg="resolving .eth names and CIDs at *.bzz.limo"
time="2025-04-08T11:52:52.921Z" level="info" msg="starting server at bzz.limo:3000"
```

## Docker

```sh
docker build -t swarm-gateway .
docker run -p 3000:3000 \
  -e HOSTNAME=bzz.limo \
  -e POSTAGE_AMOUNT=800000000 \
  -e POSTAGE_DEPTH=17 \
  swarm-gateway
```

## Subdomain routing

When `HOSTNAME` is set, the gateway resolves subdomains against the Bee node:

-   `<swarm-cid>.bzz.limo` — serves the content at that Swarm hash
-   `<ens-name>.bzz.limo` — resolves the ENS name and serves the content
-   Subdomain rewrites can be configured via the database

## ENS names migrated to ENSv2

ENS moved some names to ENSv2. In the old ENS registry such a name now has no resolver, and Bee
resolves names through that registry, so Bee can no longer serve it. ENS's Universal Resolver
still finds the name's records.

Set `ENS_RPC_URL` to an Ethereum mainnet JSON-RPC endpoint (for example `https://rpc.example.com`)
and the gateway resolves `.eth` names itself, through the Universal Resolver. It reads the name's
contenthash, accepts only a Swarm reference, caches the answer for a minute, and asks Bee for the
reference instead of the name. This applies to ENS paths (`/bzz/<name>.eth/`), ENS subdomains, the
TLS check, the moderation rules and an ENS `HOMEPAGE`. A request through a name still falls under
the default ENS rule, and a rule on the resolved reference still applies to it. A name with no
Swarm contenthash, or one the endpoint cannot resolve, answers 404. When `ENS_RPC_URL` is unset,
the gateway hands names to Bee as before.

To check names against the real resolver, run `npm run build`, then
`ENS_RPC_URL=<url> node scripts/ens-live-check.mjs <name>.eth`.

## Serving only listed ENS names

Set `ALLOWED_ENS_NAMES` to a space- or comma-separated list of `.eth` names, for example
`ALLOWED_ENS_NAMES="site.eth, other.eth"`, and only those names are served as subdomains. Any other
subdomain, a Swarm hash subdomain included, fails the TLS check and answers 404, so the server
serves its own names and is not an open gateway. Subdomain rewrites from the database stay
servable.

While it is set, the listed names on their subdomains are all the gateway serves. Every other
request answers 404 before it reaches Bee or the RPC endpoint: paths on the main hostname such as
`/bzz/<name>.eth/`, `/bzz/<hash>/`, `/bytes/<hash>`, `/chunks/<hash>` and `/feeds/...`, uploads, the
stamp listings under `/batches`, the moderation API, the homepage and the static pages, on any Host,
an IP address included, and every request to a listed subdomain other than GET. Four paths stay
reachable on any Host for the operator: `/health`, `/readiness`, `/metrics`, and `/tls-check`,
which a certificate for a listed subdomain is issued through. When it is unset, every subdomain and
every path is served as before.

## Environment variables

| Name                      | Default                   | Description                                                                             |
| ------------------------- | ------------------------- | --------------------------------------------------------------------------------------- |
| PORT                      | `3000`                    | Port to listen on                                                                       |
| HOSTNAME                  | `localhost`               | Public hostname of the gateway, used for subdomain routing                              |
| BEE_API_URL               | `http://localhost:1633`   | URL of the Bee node API                                                                 |
| AUTH_SECRET               | —                         | If set, require this value in the `Authorization` header for all requests               |
| SOFT_AUTH                 | `false`                   | When auth is enabled, only enforce it on POST requests                                  |
| MODERATION_SECRET         | —                         | If set, require this value in the `Authorization` header for moderation endpoints       |
| INSTANCE_NAME             | —                         | Instance name used to look up moderation settings from the database                     |
| REMOVE_PIN_HEADER         | `true`                    | Strip the `swarm-pin` header from proxied requests                                      |
| POSTAGE_STAMP             | —                         | Hardcoded postage batch ID to use for all uploads                                       |
| POSTAGE_STAMP_SOC         | —                         | Hardcoded postage batch ID to use for `POST /soc/*` uploads (falls back to `POSTAGE_STAMP` if unset) |
| POSTAGE_DEPTH             | —                         | Batch depth for autobuy (required for autobuy)                                          |
| POSTAGE_AMOUNT            | —                         | Batch amount for autobuy (required for autobuy)                                         |
| POSTAGE_THRESHOLD_USAGE   | `0.85`                    | Buy a new batch when usage of the current one exceeds this fraction                     |
| POSTAGE_THRESHOLD_SECONDS | `3600`                    | Buy a new batch when TTL of the current one drops below this many seconds               |
| POSTAGE_KEEP_ALIVE        | `false`                   | Top up batches instead of buying new ones when they near expiry                         |
| LOG_LEVEL                 | `info`                    | Log verbosity: `critical`, `error`, `warn`, `info`, `verbose`, or `debug`               |
| HOMEPAGE                  | —                         | Swarm hash of a site to serve at the root path                                          |
| POST_SIZE_LIMIT           | `1gb`                     | Maximum POST body size                                                                  |
| DATABASE_CONFIG           | —                         | MySQL connection as JSON: `{"user":"","password":"","host":"","port":3306,"database":"","ssl":{"ca":"..."}}`. If unset, all database-backed features are disabled. |
| DATABASE_PASSWORD         | —                         | MySQL password (overrides the `password` field in `DATABASE_CONFIG`)                    |
| MATTERMOST_WEBHOOK_URL    | —                         | URL of the Mattermost incoming webhook used for alerts                                  |
| MATTERMOST_STDOUT          | `false`                   | When `true`, log every Mattermost alert payload to stdout (whether or not a webhook is set). Useful for testing without a webhook |
| READINESS_MODE            | `normal`                  | `normal`: check only Bee readiness, `strict`: check Bee readiness and Bee depth         |
| ENS_RPC_URL               | unset                     | Ethereum mainnet JSON-RPC endpoint. When set, the gateway resolves `.eth` names itself through the ENS Universal Resolver |
| ALLOWED_ENS_NAMES         | unset                     | Space- or comma-separated `.eth` names. When set, only these names are served, on their subdomains, and everything else but health, readiness, metrics and the TLS check answers 404 |

## Maintainers

- [Cafe137](https://github.com/Cafe137)
- [slapec93](https://github.com/slapec93)
