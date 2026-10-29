#!/usr/bin/env node
// Resolves ENS names through the real Universal Resolver with the gateway's own code. Not part of
// npm test, because it needs the network. Run `npm run build` first.
//
//   ENS_RPC_URL=https://rpc.example.com node scripts/ens-live-check.mjs solarpunkid.eth
import { lookupSwarmReference } from '../dist/services/universal-resolver.js'

const rpcUrl = process.env.ENS_RPC_URL
const names = process.argv.slice(2)
if (!rpcUrl || !names.length) {
  console.error('usage: ENS_RPC_URL=<mainnet json-rpc url> node scripts/ens-live-check.mjs <name.eth> [...]')
  process.exit(2)
}

let failed = false
for (const name of names) {
  try {
    const reference = await lookupSwarmReference(rpcUrl, name)
    console.log(`${name}: ${reference ?? 'no swarm contenthash'}`)
    failed ||= reference === null
  } catch (error) {
    console.log(`${name}: lookup failed, ${error instanceof Error ? error.message : error}`)
    failed = true
  }
}
process.exit(failed ? 1 : 0)
