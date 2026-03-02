/**
 * send-to-chain.js
 * ================
 * Kirim market creation LANGSUNG ke Verity Core contract di Base Sepolia.
 * Mimics exactly apa yang CRE DON lakukan setelah BFT OCR3 consensus.
 *
 * Calls: Verity.onReport(metadata, report)
 *   - metadata : bytes32 workflowId (CRE-1 identifier)
 *   - report   : ABI-encoded payload (ACTION_CREATE_MARKET + all fields)
 *
 * Run:
 *   node send-to-chain.js
 *   node send-to-chain.js --question "Will ETH hit $5k before 2027?" --category CRYPTO_PRICE
 *
 * Env (reads from verity-sc/.env):
 *   PRIVATE_KEY  — deployer/CRE wallet private key
 */

import { createWalletClient, createPublicClient, http, encodeAbiParameters, parseAbi, keccak256, toHex, toBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Load .env from verity-sc ─────────────────────────────────────────────────

function loadEnv(path) {
    const env = {}
    try {
        const raw = readFileSync(path, 'utf-8')
        for (const line of raw.split('\n')) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith('#')) continue
            const eq = trimmed.indexOf('=')
            if (eq === -1) continue
            const key = trimmed.slice(0, eq).trim()
            const val = trimmed.slice(eq + 1).trim()
            env[key] = val
        }
    } catch {
        // falls through — use process.env
    }
    return env
}

const envFile = resolve(__dirname, '../verity-sc/.env')
const dotenv  = loadEnv(envFile)
const env     = { ...dotenv, ...process.env }

// ─── Config ───────────────────────────────────────────────────────────────────

const PRIVATE_KEY        = env.PRIVATE_KEY
const VERITY_CORE        = '0xEF5Fb431494da36f0459Dc167Faf7D23ad50A869'
const ACTION_CREATE_MARKET = 1
const DEFAULT_FEE_BPS    = 200
const ZERO_ADDRESS       = '0x0000000000000000000000000000000000000000'

const CATEGORY_MAP = { CRYPTO_PRICE: 0, CRYPTO: 0, EVENT: 1, SOCIAL: 2, OTHER: 3 }

// ─── Parse CLI args ───────────────────────────────────────────────────────────

function getArg(flag, defaultVal) {
    const idx = process.argv.indexOf(flag)
    return idx !== -1 ? process.argv[idx + 1] : defaultVal
}

const question           = getArg('--question',    'Will ETH exceed $5,000 before Q4 2026?')
const categoryStr        = getArg('--category',    'CRYPTO_PRICE')
const resolutionCriteria = getArg('--criteria',    'Resolves YES if ETH/USD Chainlink Price Feed on Base exceeds 5000 * 1e8 before deadline.')
const dataSources        = getArg('--sources',     '["chainlink.com/price-feeds","coingecko.com"]')
const targetValueUsd     = parseFloat(getArg('--targetValue', '5000'))
const priceFeedAddr      = getArg('--priceFeed',   '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1')
const deadlineDays       = parseInt(getArg('--deadlineDays', '30'))

// ─── ABI (only the functions we need) ────────────────────────────────────────

const VERITY_ABI = parseAbi([
    'function onReport(bytes calldata metadata, bytes calldata report) external',
    'function createMarketFromCre(address creator, uint64 deadline, uint16 feeBps, uint8 category, string calldata question, string calldata resolutionCriteria, string calldata dataSources, int256 targetValue, address priceFeedAddress) external returns (uint256 marketId)',
    'function marketCount() external view returns (uint256)',
    'event MarketCreated(uint256 indexed marketId, address indexed creator, uint8 category, string question)',
])

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    if (!PRIVATE_KEY) {
        console.error('ERROR: PRIVATE_KEY not set. Add to verity-sc/.env or export env var.')
        process.exit(1)
    }

    const account = privateKeyToAccount(PRIVATE_KEY)
    console.log('\n🔗 Verity Core — Send to Chain')
    console.log('================================')
    console.log(`📬 Sender (CRE wallet) : ${account.address}`)
    console.log(`📋 Verity Core         : ${VERITY_CORE}`)
    console.log(`⛓️  Chain               : Base Sepolia (chainId=84532)`)

    const publicClient = createPublicClient({
        chain:     baseSepolia,
        transport: http('https://sepolia.base.org'),
    })

    const walletClient = createWalletClient({
        account,
        chain:     baseSepolia,
        transport: http('https://sepolia.base.org'),
    })

    // ── Check current marketCount ─────────────────────────────────────────────
    const marketCountBefore = await publicClient.readContract({
        address: VERITY_CORE,
        abi:     VERITY_ABI,
        functionName: 'marketCount',
    })
    console.log(`\n📊 Current marketCount : ${marketCountBefore}`)

    // ── Build payload ─────────────────────────────────────────────────────────
    const category       = CATEGORY_MAP[categoryStr] ?? 3
    const deadlineTs     = BigInt(Math.floor(Date.now() / 1000) + deadlineDays * 86400)
    const targetValueInt = categoryStr === 'CRYPTO_PRICE'
        ? BigInt(Math.round(targetValueUsd * 1e8))
        : 0n
    const priceFeed      = categoryStr === 'CRYPTO_PRICE' ? priceFeedAddr : ZERO_ADDRESS
    const creatorAddr    = account.address

    console.log('\n📦 Payload:')
    console.log(`  action             : ${ACTION_CREATE_MARKET} (ACTION_CREATE_MARKET)`)
    console.log(`  creator            : ${creatorAddr}`)
    console.log(`  deadline           : ${deadlineTs} (+${deadlineDays} days)`)
    console.log(`  feeBps             : ${DEFAULT_FEE_BPS}`)
    console.log(`  category           : ${category} (${categoryStr})`)
    console.log(`  question           : "${question}"`)
    console.log(`  resolutionCriteria : "${resolutionCriteria.slice(0, 60)}..."`)
    console.log(`  dataSources        : ${dataSources}`)
    console.log(`  targetValue        : ${targetValueInt} (int256, 8 decimals)`)
    console.log(`  priceFeedAddress   : ${priceFeed}`)

    // ── ABI-encode report (mirrors market.ts encodeAbiParameters) ─────────────
    const report = encodeAbiParameters(
        [
            { type: 'uint8'    },  // action
            { type: 'address'  },  // creator
            { type: 'uint64'   },  // deadline
            { type: 'uint16'   },  // feeBps
            { type: 'uint8'    },  // category
            { type: 'string'   },  // question
            { type: 'string'   },  // resolutionCriteria
            { type: 'string'   },  // dataSources
            { type: 'int256'   },  // targetValue
            { type: 'address'  },  // priceFeedAddress
        ],
        [
            ACTION_CREATE_MARKET,
            creatorAddr,
            deadlineTs,
            DEFAULT_FEE_BPS,
            category,
            question,
            resolutionCriteria,
            dataSources,
            targetValueInt,
            priceFeed,
        ]
    )

    // ── metadata: bytes32 workflowId = keccak256("safemarket-creation-v1") ────
    const workflowId = keccak256(toHex('safemarket-creation-v1'))
    // Pad to 32 bytes as ABI-compatible `bytes` (not bytes32 — just 32 raw bytes)
    const metadata   = workflowId   // already 32-byte hex string

    console.log(`\n🔑 Report encoded: ${report.slice(0, 42)}... (${report.length / 2 - 1} bytes)`)
    console.log(`🔑 WorkflowId    : ${workflowId}`)

    // ── Simulate first ────────────────────────────────────────────────────────
    console.log('\n🔍 Simulating call...')
    try {
        await publicClient.simulateContract({
            address:      VERITY_CORE,
            abi:          VERITY_ABI,
            functionName: 'onReport',
            args:         [metadata, report],
            account,
        })
        console.log('✅ Simulation: OK')
    } catch (err) {
        console.error('❌ Simulation failed:', err.shortMessage || err.message)
        console.error('\nTip: Make sure your wallet has CRE_ROLE on the contract.')
        process.exit(1)
    }

    // ── Send transaction ──────────────────────────────────────────────────────
    console.log('\n🚀 Sending onReport() to Verity Core...')
    const txHash = await walletClient.writeContract({
        address:      VERITY_CORE,
        abi:          VERITY_ABI,
        functionName: 'onReport',
        args:         [metadata, report],
    })
    console.log(`📨 Tx submitted    : ${txHash}`)
    console.log(`🔗 Basescan        : https://sepolia.basescan.org/tx/${txHash}`)

    // ── Wait for receipt ──────────────────────────────────────────────────────
    console.log('⏳ Waiting for confirmation...')
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })

    if (receipt.status === 'success') {
        const marketCountAfter = await publicClient.readContract({
            address:      VERITY_CORE,
            abi:          VERITY_ABI,
            functionName: 'marketCount',
        })
        const newMarketId = Number(marketCountAfter) - 1

        console.log('\n✅ Transaction confirmed!')
        console.log(`📦 Block           : ${receipt.blockNumber}`)
        console.log(`⛽ Gas used         : ${receipt.gasUsed.toLocaleString()}`)
        console.log(`🎯 New marketId    : ${newMarketId}`)
        console.log(`📊 marketCount     : ${marketCountBefore} → ${marketCountAfter}`)
        console.log(`\n🔗 Basescan TX     : https://sepolia.basescan.org/tx/${txHash}`)
        console.log(`🔗 Contract        : https://sepolia.basescan.org/address/${VERITY_CORE}`)
    } else {
        console.error('❌ Transaction reverted!')
        console.error(`   TxHash: ${txHash}`)
    }
}

main().catch(err => {
    console.error('\n❌ Fatal error:', err.shortMessage || err.message)
    process.exit(1)
})
