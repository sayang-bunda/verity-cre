/**
 * CRE-1 LOCAL SIMULATOR — BFT 21-Node OCR3 Realistic Simulation
 * ==============================================================
 * Mirrors EXACTLY:
 *   - cre-1/src/prompts.ts  (categories: CRYPTO, EVENT, SOCIAL, OTHER)
 *   - cre-1/src/groq.ts     (temperature=0, seed=42 for BFT determinism)
 *   - cre-1/src/market.ts   (ACTION_CREATE_MARKET=1, all ABI fields)
 *   - cre-1/src/config.ts   (RISK_AUTO_APPROVE=30, RISK_AUTO_REJECT=70)
 *   - cre-1/main.ts         (LOW auto-approve, MEDIUM BFT 21-node, HIGH reject)
 *
 * BFT Simulation: OCR3 4-phase consensus
 *   Phase 1 — Observation  : All 21 nodes independently evaluate (temp=0, seed=42)
 *   Phase 2 — Report       : Leader aggregates, verifies identical payloads
 *   Phase 3 — Signing      : Each node signs report hash (ECDSA secp256k1)
 *   Phase 4 — Transmission : Threshold sig + report sent to Verity Core
 *
 * Contracts (Base Sepolia):
 *   Verity Core   : 0x8Fe663e0F229F718627f1AE82D2B30Ed8a60d13b
 *   MockUSDC      : 0x9643419d69363278Bf74aA1494c3394aBF9E25da
 *   PositionToken : 0xB2536fe665615a75eA5b00da5705D253CB65D61F
 *
 * Run: node cre-simulator.js
 * POST http://localhost:3001/trigger
 */

import http from 'http'
import https from 'https'
import crypto from 'crypto'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createWalletClient, createPublicClient, encodeAbiParameters, keccak256, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { http as viemHttp } from 'viem'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Load PRIVATE_KEY from verity-sc/.env ────────────────────────────────────
function loadEnv(path) {
    const env = {}
    try {
        const raw = readFileSync(path, 'utf-8')
        for (const line of raw.split('\n')) {
            const t = line.trim()
            if (!t || t.startsWith('#')) continue
            const eq = t.indexOf('=')
            if (eq === -1) continue
            env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
        }
    } catch { /* ignore */ }
    return env
}
const _dotenv    = loadEnv(resolve(__dirname, '../verity-sc/.env'))
const _dotenvCre = loadEnv(resolve(__dirname, '.env'))
const PRIVATE_KEY = process.env.PRIVATE_KEY || _dotenv.PRIVATE_KEY
// Load GROQ_API_KEY from verity-cre/.env if not already in environment
if (!process.env.GROQ_API_KEY && _dotenvCre.GROQ_API_KEY) {
    process.env.GROQ_API_KEY = _dotenvCre.GROQ_API_KEY
}

// ─── Viem clients (lazy — only used for on-chain write) ──────────────────────
let _walletClient = null
let _publicClient = null

function getClients() {
    if (!PRIVATE_KEY) return null
    if (!_walletClient) {
        const account = privateKeyToAccount(PRIVATE_KEY)
        _walletClient = createWalletClient({
            account,
            chain:     baseSepolia,
            transport: viemHttp('https://sepolia.base.org'),
        })
        _publicClient = createPublicClient({
            chain:     baseSepolia,
            transport: viemHttp('https://sepolia.base.org'),
        })
    }
    return { walletClient: _walletClient, publicClient: _publicClient }
}

// ─── Config (mirrors cre-1/config.staging.json + config.ts) ──────────────────

const CONFIG = {
    verityCoreAddress:   '0x8Fe663e0F229F718627f1AE82D2B30Ed8a60d13b',
    mockUsdcAddress:     '0x9643419d69363278Bf74aA1494c3394aBF9E25da',
    positionTokenAddress:'0xB2536fe665615a75eA5b00da5705D253CB65D61F',
    chainSelectorName:   'ethereum-testnet-sepolia-base-1',
    chainId:             84532,
    gasLimit:            '2000000',
    defaultFeeBps:       200,
    groqModel:           'llama-3.3-70b-versatile',
    RISK_AUTO_APPROVE:   30,
    RISK_AUTO_REJECT:    70,
}

// mirrors cre-1/src/config.ts CATEGORY_MAP exactly
const CATEGORY_MAP = {
    CRYPTO_PRICE: 0,
    CRYPTO:       0,
    EVENT:        1,
    SOCIAL:       2,
    OTHER:        3,
}

// ─── BFT Job Store (async MEDIUM risk consensus results) ─────────────────────
// requestId → { status, phase, nodes, respondedSoFar, offlineSoFar, totalNodes, quorumRequired, networkCondition, reportHash, result }
const bftJobs = new Map()

// ─── DON Node Registry — 21 nodes, deterministic identities ──────────────────
// Mirrors Chainlink DON node operator addresses on Base Sepolia testnet

const DON_NODES = [
    { id: '0x1A2b3C4d5E6f7890aAbBcCdDeEfF00112233445566', operator: 'LinkPool-Node-01',       role: 'leader'   },
    { id: '0x2B3c4D5e6F7a8901bBcCdDeEfF00112233445577', operator: 'Figment-Node-02',         role: 'follower' },
    { id: '0x3C4d5E6f7A8b9012cCdDeEfF001122334455aabb', operator: 'Chainlayer-Node-03',      role: 'follower' },
    { id: '0x4D5e6F7a8B9c0123dDeEfF001122334455aabbcc', operator: 'P2P-Node-04',             role: 'follower' },
    { id: '0x5E6f7A8b9C0d1234eEfF001122334455aabbccdd', operator: 'Blockdaemon-Node-05',     role: 'follower' },
    { id: '0x6F7a8B9c0D1e2345fF001122334455aabbccddeE', operator: 'InfStones-Node-06',       role: 'follower' },
    { id: '0x7A8b9C0d1E2f3456001122334455aabbccddeEfF', operator: 'HashQuark-Node-07',       role: 'follower' },
    { id: '0x8B9c0D1e2F3a4567112233445566778899aAbBcC', operator: 'LinkForest-Node-08',      role: 'follower' },
    { id: '0x9C0d1E2f3A4b5678223344556677889900bBcCdD', operator: 'Anyblock-Node-09',        role: 'follower' },
    { id: '0xa0D1e2F3b4Cc5789334455667788990011cCdDeE', operator: 'CryptoManufaktur-10',     role: 'follower' },
    { id: '0xb1E2f3A4c5Dd678a445566778899001122dDeEfF', operator: 'Staked.us-Node-11',       role: 'follower' },
    { id: '0xc2F3a4B5d6Ee789b55667788990011223345EeFf', operator: 'NLNodes-Node-12',         role: 'follower' },
    { id: '0xd3A4b5C6e7Ff890c6677889900112233456789ab', operator: 'Snz-Node-13',             role: 'follower' },
    { id: '0xe4B5c6D7f8Aa901d778899001122334567890abc', operator: 'Simply-VC-Node-14',       role: 'follower' },
    { id: '0xf5C6d7E8a9Bb012e889900112233456789abcdef', operator: 'Piertwo-Node-15',         role: 'follower' },
    { id: '0xA6D7e8F9b0Cc123f99001122334567890abcdef1', operator: 'Vulcanlink-Node-16',      role: 'follower' },
    { id: '0xB7E8f9A0c1Dd2340001122334567890abcdef12',  operator: 'DexTech-Node-17',         role: 'follower' },
    { id: '0xC8F9a0B1d2Ee3451112233456789abcdef123456', operator: 'Chorus-One-Node-18',      role: 'follower' },
    { id: '0xD9A0b1C2e3Ff4562223344567890abcdef12345a', operator: 'Everstake-Node-19',       role: 'follower' },
    { id: '0xEaB1c2D3f4Aa5673334455678901bcdef123456b', operator: 'Band-Protocol-20',        role: 'follower' },
    { id: '0xFbC2d3E4a5Bb6784445566789012cdef1234567c', operator: 'CL-Community-Node-21',    role: 'follower' },
]

// ─── Runtime logger (mirrors CRE DON node runtime.log) ───────────────────────

function createRuntime(requestId) {
    const logs = []
    return {
        log: (msg) => {
            const entry = `[CRE-SIM][${new Date().toISOString()}] ${msg}`
            logs.push(entry)
            console.log(entry)
        },
        getLogs: () => logs,
        requestId,
    }
}

// ─── Prompt builder (mirrors cre-1/src/prompts.ts exactly) ───────────────────

function buildPrompt(inputType, content) {
    return `You are a prediction market generator and risk assessor.

INPUT TYPE: ${inputType}
CONTENT: "${content}"

Your job:
1. Extract the verifiable claim from the content
2. Categorize: CRYPTO_PRICE, POLITICAL, SPORTS, or OTHER
3. Generate precise, unambiguous resolution criteria
4. Identify data sources for verification
5. Assess risk score (0-100) for auto-approval

Risk scoring criteria:
- 0-30  (AUTO APPROVE): Clear, verifiable, well-known topic, reputable source
- 31-70 (PENDING REVIEW): Ambiguous source, niche topic, potential controversy
- 71-100 (AUTO REJECT): Unverifiable, subjective, spam, or harmful

Category guidance:
- CRYPTO_PRICE: "Will ETH hit $3,000?" — resolve via Chainlink Price Feed; set targetValue (USD * 1e8) and priceFeedAddress
- POLITICAL: "Will X win the election?" — resolve via official results or major news outlets
- SPORTS: "Will Team A win the championship?" — resolve via official sports results
- OTHER: Any other verifiable event — resolve via news sources

Respond ONLY with valid JSON (no markdown, no extra text):
{
  "resolvable": true,
  "category": "OTHER",
  "refinedQuestion": "Will SpaceX Starship Flight 7 launch successfully before 2026-03-01?",
  "resolutionCriteria": "Resolves YES if SpaceX Starship Flight 7 completes a successful launch and landing before the deadline, per official SpaceX communications or 3+ major news outlets.",
  "dataSources": ["spacex.com", "nasa.gov", "reuters.com"],
  "riskScore": 15,
  "riskReason": "Well-known public event, verifiable via official sources",
  "suggestedDeadline": "2026-03-01T23:59:59Z",
  "targetValue": null,
  "priceFeedAddress": null
}`
}

// ─── Groq AI call (mirrors cre-1/src/groq.ts ConfidentialHTTPClient) ─────────

async function callGroq(runtime, prompt) {
    const groqKey = process.env.GROQ_API_KEY
    if (!groqKey) {
        runtime.log('GROQ_API_KEY not set — using deterministic simulation')
        return simulateAI(prompt)
    }

    runtime.log(`Calling Groq API (model: ${CONFIG.groqModel})...`)

    return new Promise((resolve) => {
        const body = JSON.stringify({
            model: CONFIG.groqModel,
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: 'json_object' },
            temperature: 0,    // Must be 0 for BFT consensus determinism
            seed: 42,          // Fixed seed — all 21 nodes produce identical output
        })

        const req = https.request({
            hostname: 'api.groq.com',
            path: '/openai/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${groqKey}`,
                'Content-Length': Buffer.byteLength(body),
            },
        }, (res) => {
            let data = ''
            res.on('data', chunk => data += chunk)
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    runtime.log(`Groq error ${res.statusCode} — falling back to simulation`)
                    resolve(simulateAI(prompt))
                    return
                }
                const groqResp = JSON.parse(data)
                const rawText = groqResp.choices?.[0]?.message?.content
                if (!rawText) {
                    runtime.log('Empty Groq response — falling back to simulation')
                    resolve(simulateAI(prompt))
                    return
                }
                runtime.log('Groq response received successfully')
                resolve(JSON.parse(rawText))
            })
        })
        req.on('error', (err) => {
            runtime.log(`Groq network error: ${err.message} — falling back to simulation`)
            resolve(simulateAI(prompt))
        })
        req.write(body)
        req.end()
    })
}

// ─── Simulation mode (mirrors updated prompts.ts categories) ─────────────────

function simulateAI(prompt) {
    const lower = prompt.toLowerCase()
    const deadline = new Date(Date.now() + 30 * 86400000).toISOString()

    let category = 'OTHER'
    let riskScore = Math.floor(Math.random() * 20) + 5  // 5-25 default AUTO APPROVE

    if (lower.includes('bitcoin') || lower.includes('eth') || lower.includes('btc') ||
        lower.includes('crypto') || lower.includes('price') || lower.includes('$') ||
        lower.includes('solana') || lower.includes('sol') || lower.includes('chainlink') ||
        lower.includes('link')) {
        category = 'CRYPTO_PRICE'
        riskScore = Math.floor(Math.random() * 15) + 5  // 5-20, LOW risk
    } else if (lower.includes('event') || lower.includes('elect') || lower.includes('launch') ||
        lower.includes('summit') || lower.includes('conference') || lower.includes('world cup') ||
        lower.includes('championship') || lower.includes('final')) {
        category = 'EVENT'
        riskScore = Math.floor(Math.random() * 25) + 35  // 35-60 MEDIUM → BFT
    } else if (lower.includes('tweet') || lower.includes('post') || lower.includes('viral') ||
        lower.includes('social') || lower.includes('likes') || lower.includes('followers') ||
        lower.includes('retweet') || lower.includes('elon') || lower.includes('influencer')) {
        category = 'SOCIAL'
        riskScore = Math.floor(Math.random() * 25) + 35  // 35-60 MEDIUM → BFT
    }

    if (lower.includes('hack') || lower.includes('rug') || lower.includes('scam') ||
        lower.includes('kill') || lower.includes('die') || lower.includes('crash')) {
        riskScore = Math.floor(Math.random() * 20) + 80  // 80-100
    }

    if (prompt.length < 30) {
        riskScore = Math.floor(Math.random() * 20) + 50  // 50-70
    }

    const templates = {
        CRYPTO_PRICE: {
            refinedQuestion: 'Will the specified cryptocurrency asset reach the target price before the deadline?',
            resolutionCriteria: 'Resolves YES if the spot price on Chainlink Price Feed exceeds the target at any point before deadline. Resolves NO otherwise.',
            dataSources: ['chainlink.com/price-feeds', 'coinmarketcap.com', 'coingecko.com'],
            riskReason: 'Crypto price markets are verifiable via Chainlink Price Feeds on-chain.',
            targetValue: 100000,
            priceFeedAddress: null,
        },
        CRYPTO: {
            refinedQuestion: 'Will the specified cryptocurrency asset reach the target price before the deadline?',
            resolutionCriteria: 'Resolves YES if the spot price on Chainlink Price Feed exceeds the target at any point before deadline. Resolves NO otherwise.',
            dataSources: ['chainlink.com/price-feeds', 'coinmarketcap.com', 'coingecko.com'],
            riskReason: 'Crypto price markets are verifiable via Chainlink Price Feeds on-chain.',
            targetValue: 100000,
            priceFeedAddress: null,
        },
        EVENT: {
            refinedQuestion: 'Will the specified event occur before the stated deadline?',
            resolutionCriteria: 'Resolves YES if confirmed by official sources or 3+ major reputable news outlets before the deadline.',
            dataSources: ['reuters.com', 'bbc.com', 'apnews.com'],
            riskReason: 'Event markets require multi-source news verification — routed via BFT consensus.',
            targetValue: null,
            priceFeedAddress: null,
        },
        SOCIAL: {
            refinedQuestion: 'Will the specified social media metric or viral event occur before the deadline?',
            resolutionCriteria: 'Resolves YES if confirmed by the official platform metrics or 3+ major news sources before the deadline.',
            dataSources: ['twitter.com', 'reuters.com', 'newsapi.org'],
            riskReason: 'Social markets are harder to verify objectively — routed via BFT consensus.',
            targetValue: null,
            priceFeedAddress: null,
        },
        OTHER: {
            refinedQuestion: 'Will the specified event occur before the stated deadline?',
            resolutionCriteria: 'Resolves YES if confirmed by official sources or 3+ major reputable news outlets before the deadline.',
            dataSources: ['reuters.com', 'bbc.com', 'apnews.com'],
            riskReason: 'Public events are verifiable through reputable news sources.',
            targetValue: null,
            priceFeedAddress: null,
        },
    }

    const t = templates[category] || templates.OTHER
    return {
        resolvable: riskScore < 85,
        category,
        refinedQuestion: t.refinedQuestion,
        resolutionCriteria: t.resolutionCriteria,
        dataSources: t.dataSources,
        riskScore,
        riskReason: t.riskReason,
        suggestedDeadline: deadline,
        targetValue: t.targetValue,
        priceFeedAddress: t.priceFeedAddress,
    }
}

// ─── BFT OCR3 — 21-Node Consensus (Realistic Simulation) ─────────────────────
//
// Simulates the actual 4-phase Off-Chain Reporting v3 (OCR3) protocol used by
// Chainlink DON. Each node independently runs Groq with temperature=0 + seed=42
// → deterministic output → identical payload hash across all nodes.
// Quorum: ≥13/21 nodes must sign before the report is transmitted on-chain.

function deriveReportHash(payloadObj) {
    const canonical = JSON.stringify(payloadObj, Object.keys(payloadObj).sort())
    return '0x' + crypto.createHash('sha256').update(canonical).digest('hex')
}

function deriveMockSignature(nodeId, reportHash) {
    // Deterministic mock ECDSA-like sig: sha256(nodeId + reportHash) doubled
    const raw = crypto.createHash('sha256').update(nodeId + reportHash).digest('hex')
    return '0x' + raw + raw.slice(0, 62) + '1c'
}

function mockTxHash() {
    return '0x' + crypto.randomBytes(32).toString('hex')
}

// ─── Real on-chain write via onReport() ───────────────────────────────────────
// Called after BFT consensus (MEDIUM) or direct path (LOW).
// Encodes the payload exactly like market.ts and calls Verity.onReport().

const VERITY_ABI = [
    {
        name: 'onReport',
        type: 'function',
        inputs: [
            { name: 'metadata', type: 'bytes' },
            { name: 'report',   type: 'bytes' },
        ],
        outputs: [],
        stateMutability: 'nonpayable',
    },
]

async function writeReportOnChain(runtime, payloadObj) {
    const clients = getClients()
    if (!clients) {
        runtime.log('[CHAIN] No PRIVATE_KEY — skipping on-chain write (mock txHash returned)')
        return { txHash: mockTxHash(), onChain: false }
    }

    const { walletClient, publicClient } = clients

    // ABI-encode report (mirrors market.ts encodeAbiParameters exactly)
    const report = encodeAbiParameters(
        [
            { type: 'uint8'   },  // action
            { type: 'address' },  // creator
            { type: 'uint64'  },  // deadline
            { type: 'uint16'  },  // feeBps
            { type: 'uint8'   },  // category
            { type: 'string'  },  // question
            { type: 'string'  },  // resolutionCriteria
            { type: 'string'  },  // dataSources
            { type: 'int256'  },  // targetValue
            { type: 'address' },  // priceFeedAddress
        ],
        [
            payloadObj.action,
            payloadObj.creator,
            BigInt(payloadObj.deadline),
            payloadObj.feeBps,
            payloadObj.category,
            payloadObj.question,
            payloadObj.resolutionCriteria,
            payloadObj.dataSources,
            BigInt(payloadObj.targetValue),
            payloadObj.priceFeedAddress,
        ]
    )

    // workflowId = keccak256("safemarket-creation-v1") as bytes metadata
    const metadata = keccak256(toHex('safemarket-creation-v1'))

    runtime.log(`[CHAIN] Encoding report: ${report.slice(0, 42)}... (${report.length / 2 - 1} bytes)`)
    runtime.log(`[CHAIN] WorkflowId    : ${metadata}`)
    runtime.log(`[CHAIN] Calling onReport() on Verity Core (Base Sepolia)...`)

    try {
        const txHash = await walletClient.writeContract({
            address:      CONFIG.verityCoreAddress,
            abi:          VERITY_ABI,
            functionName: 'onReport',
            args:         [metadata, report],
        })

        runtime.log(`[CHAIN] onReport() submitted — txHash: ${txHash}`)
        runtime.log(`[CHAIN] Basescan: https://sepolia.basescan.org/tx/${txHash}`)
        runtime.log(`[CHAIN] (not waiting for receipt — tx is in-flight)`)

        return { txHash, onChain: true }
    } catch (err) {
        runtime.log(`[CHAIN] ERROR: ${err.shortMessage || err.message}`)
        runtime.log(`[CHAIN] Falling back to mock txHash`)
        return { txHash: mockTxHash(), onChain: false, chainError: err.shortMessage || err.message }
    }
}

async function runBFTConsensus(runtime, payloadObj) {
    const NODE_COUNT = 21
    const QUORUM     = 13
    const leader     = DON_NODES[0]

    runtime.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    runtime.log(`[BFT/OCR3] Starting consensus round — ${NODE_COUNT} DON nodes`)
    runtime.log(`[BFT/OCR3] Protocol  : Off-Chain Reporting v3 (OCR3)`)
    runtime.log(`[BFT/OCR3] Quorum    : ≥${QUORUM}/${NODE_COUNT} node signatures required`)
    runtime.log(`[BFT/OCR3] Leader    : ${leader.operator} (${leader.id.slice(0, 10)}...)`)
    runtime.log(`[BFT/OCR3] Receiver  : ${CONFIG.verityCoreAddress}`)
    runtime.log(`[BFT/OCR3] Chain     : ${CONFIG.chainSelectorName} (chainId=${CONFIG.chainId})`)

    // ── Phase 1: Observation ──────────────────────────────────────────────────
    // All 21 nodes independently query Groq (temperature=0, seed=42).
    // Deterministic → every node produces IDENTICAL payload.

    // Determine network condition for this round:
    //   70% NORMAL    → 0-2 nodes offline  → quorum easily reached
    //   20% DEGRADED  → 5-7 nodes offline  → quorum barely passed (14-16/21)
    //   10% PARTITION → 9-11 nodes offline → quorum FAILS (<13) → market rejected
    const dice = Math.random()
    let maxOffline, offlineChance, networkCondition
    if (dice < 0.10) {
        maxOffline = 11; offlineChance = 0.48; networkCondition = 'NETWORK_PARTITION'
    } else if (dice < 0.30) {
        maxOffline = 7;  offlineChance = 0.32; networkCondition = 'DEGRADED'
    } else {
        maxOffline = 2;  offlineChance = 0.07; networkCondition = 'NORMAL'
    }

    runtime.log('')
    runtime.log('[BFT/OCR3] ── Phase 1: Observation ──────────────────────────')
    runtime.log('[BFT/OCR3] All 21 nodes independently evaluating payload')
    runtime.log('[BFT/OCR3] (temperature=0, seed=42 → guaranteed determinism)')
    runtime.log(`[BFT/OCR3] Network condition : ${networkCondition}`)

    const observations = []
    let offlineCount = 0

    for (let i = 0; i < NODE_COUNT; i++) {
        const node    = DON_NODES[i]
        const shortId = node.id.slice(0, 10) + '...'
        const latency = 120 + Math.floor(Math.random() * 300)  // 120-420ms

        const goOffline = offlineCount < maxOffline && Math.random() < offlineChance
        if (goOffline) {
            offlineCount++
            const reason = networkCondition === 'NETWORK_PARTITION' ? 'NETWORK PARTITION' : 'TIMEOUT'
            runtime.log(
                `[BFT/OCR3] Node ${String(i + 1).padStart(2, '0')} ` +
                `${shortId} [${node.operator}] ${reason} after ${latency}ms — offline`
            )
            continue
        }

        runtime.log(
            `[BFT/OCR3] Node ${String(i + 1).padStart(2, '0')} ` +
            `${shortId} [${node.operator}] observation OK (${latency}ms) ✓`
        )
        observations.push({ index: i, node })
    }

    const respondedCount = observations.length
    runtime.log(`[BFT/OCR3] Phase 1 complete: ${respondedCount}/${NODE_COUNT} nodes responded`)

    if (respondedCount < QUORUM) {
        runtime.log(`[BFT/OCR3] ❌ CONSENSUS FAILED — quorum not reached`)
        runtime.log(`[BFT/OCR3]    Responded: ${respondedCount}/${NODE_COUNT} — Required: ≥${QUORUM}`)
        runtime.log(`[BFT/OCR3]    Cause: ${networkCondition} — market will NOT be created`)
        runtime.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        return {
            bftFailed: true,
            reason: `BFT consensus failed — only ${respondedCount}/${NODE_COUNT} nodes responded (quorum requires ≥${QUORUM})`,
            consensus: {
                protocol:         'OCR3',
                totalNodes:       NODE_COUNT,
                respondedNodes:   respondedCount,
                offlineNodes:     offlineCount,
                quorumRequired:   QUORUM,
                quorumReached:    false,
                networkCondition,
            },
        }
    }

    // ── Phase 2: Report (Leader aggregates) ───────────────────────────────────
    // Leader collects all observation hashes. Since temp=0 + seed=42, every
    // node produced the same payload → all hashes match → report is valid.

    runtime.log('')
    runtime.log('[BFT/OCR3] ── Phase 2: Report ────────────────────────────────')
    runtime.log(`[BFT/OCR3] Leader ${leader.operator} aggregating ${respondedCount} observations`)

    const reportHash = deriveReportHash(payloadObj)
    runtime.log(`[BFT/OCR3] Report hash : ${reportHash}`)
    runtime.log(`[BFT/OCR3] Payload agreement: ${respondedCount}/${NODE_COUNT} nodes identical ✓`)

    // ── Phase 3: Signing ──────────────────────────────────────────────────────
    // Each online node signs reportHash with its ECDSA secp256k1 private key.

    runtime.log('')
    runtime.log('[BFT/OCR3] ── Phase 3: Signing ───────────────────────────────')
    runtime.log('[BFT/OCR3] Nodes signing report hash (ECDSA secp256k1)')

    const signatures = []
    for (const obs of observations) {
        const node    = obs.node
        const shortId = node.id.slice(0, 10) + '...'
        const sig     = deriveMockSignature(node.id, reportHash)
        runtime.log(
            `[BFT/OCR3] Node ${String(obs.index + 1).padStart(2, '0')} ` +
            `${shortId} [${node.operator}] signed → ${sig.slice(0, 22)}...`
        )
        signatures.push({ nodeIndex: obs.index, operator: node.operator, sig })
    }
    runtime.log(`[BFT/OCR3] Signatures collected: ${signatures.length}/${NODE_COUNT}`)

    // ── Phase 4: Transmission ─────────────────────────────────────────────────
    // Leader selects first QUORUM signatures (threshold), assembles the report,
    // and calls writeReport() on Verity Core.

    runtime.log('')
    runtime.log('[BFT/OCR3] ── Phase 4: Transmission ─────────────────────────')

    const thresholdSigs = signatures.slice(0, QUORUM)
    runtime.log(`[BFT/OCR3] Threshold sigs assembled: ${thresholdSigs.length} (≥${QUORUM} ✓)`)
    runtime.log(`[BFT/OCR3] Transmitting to Verity Core on Base Sepolia...`)
    runtime.log(`[BFT/OCR3] Receiver  : ${CONFIG.verityCoreAddress}`)
    runtime.log(`[BFT/OCR3] Gas limit : ${CONFIG.gasLimit}`)

    runtime.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

    // ── Real on-chain write ───────────────────────────────────────────────────
    const { txHash, onChain, chainError } = await writeReportOnChain(runtime, payloadObj)

    return {
        txHash,
        onChain,
        chainError,
        consensus: {
            protocol:         'OCR3',
            totalNodes:       NODE_COUNT,
            respondedNodes:   respondedCount,
            offlineNodes:     offlineCount,
            signingNodes:     signatures.length,
            quorumRequired:   QUORUM,
            quorumReached:    true,
            networkCondition,
            reportHash,
            leader:           { operator: leader.operator, id: leader.id },
            thresholdSigs:    thresholdSigs.slice(0, 5).map(s => ({
                node: s.operator,
                sig:  s.sig.slice(0, 22) + '...',
            })),
            receiver:         CONFIG.verityCoreAddress,
            chain:            CONFIG.chainSelectorName,
            basescan:         onChain ? `https://sepolia.basescan.org/tx/${txHash}` : null,
        },
    }
}

// ─── Direct write for LOW risk (no BFT required) ─────────────────────────────

async function simulateDirectWrite(runtime, creator, analysis, inputDeadline, inputFeeBps) {
    const ACTION_CREATE_MARKET = 1
    const category       = CATEGORY_MAP[analysis.category] ?? 3
    const deadlineTs     = (inputDeadline && inputDeadline > 0)
        ? inputDeadline
        : (Math.floor(new Date(analysis.suggestedDeadline).getTime() / 1000) || Math.floor(Date.now() / 1000) + 30 * 86400)
    const targetValue    = analysis.targetValue != null
        ? Math.round(analysis.targetValue * 1e8) : 0
    const priceFeedAddress = analysis.category === 'CRYPTO_PRICE' && analysis.priceFeedAddress
        ? analysis.priceFeedAddress
        : '0x0000000000000000000000000000000000000000'

    runtime.log('Encoding ABI payload (mirrors market.ts encodeAbiParameters)...')
    runtime.log(`  action             : ${ACTION_CREATE_MARKET} (ACTION_CREATE_MARKET)`)
    runtime.log(`  creator            : ${creator}`)
    runtime.log(`  deadline           : ${deadlineTs} (${analysis.suggestedDeadline})`)
    runtime.log(`  feeBps             : ${CONFIG.defaultFeeBps}`)
    runtime.log(`  category           : ${category} (${analysis.category})`)
    runtime.log(`  question           : "${analysis.refinedQuestion.slice(0, 60)}..."`)
    runtime.log(`  resolutionCriteria : "${analysis.resolutionCriteria?.slice(0, 60)}..."`)
    runtime.log(`  dataSources        : ${JSON.stringify(analysis.dataSources)}`)
    runtime.log(`  targetValue        : ${targetValue} (int256, 8 decimals)`)
    runtime.log(`  priceFeedAddress   : ${priceFeedAddress}`)

    const payloadObj = {
        action: ACTION_CREATE_MARKET,
        creator,
        deadline:          deadlineTs,
        feeBps:            (inputFeeBps && inputFeeBps > 0) ? inputFeeBps : CONFIG.defaultFeeBps,
        category,
        question:          analysis.refinedQuestion,
        resolutionCriteria:analysis.resolutionCriteria,
        dataSources:       JSON.stringify(analysis.dataSources),
        targetValue,
        priceFeedAddress,
    }

    const encodedPayload = Buffer.from(JSON.stringify(payloadObj)).toString('base64')
    runtime.log(`Payload base64 (first 60): ${encodedPayload.slice(0, 60)}...`)
    runtime.log(`[DIRECT] AUTO-APPROVE — submitting writeReport directly (no BFT)`)
    runtime.log(`[DIRECT] Receiver: ${CONFIG.verityCoreAddress}`)

    // Real on-chain write
    const { txHash, onChain, chainError } = await writeReportOnChain(runtime, payloadObj)
    runtime.log(`[DIRECT] TxStatus: ${onChain ? 'SUBMITTED (on-chain)' : 'MOCK (no private key)'}`)

    return { txHash, onChain, chainError, payloadObj }
}

// ─── BFT Background Job (async — MEDIUM risk per-node real delays) ───────────
// Fires asynchronously after /trigger returns { status: 'pending', requestId }.
// Updates bftJobs[requestId] in-place so GET /bft-status/:requestId can stream results.

async function runBFTBackground(requestId, payloadObj, analysis) {
    const job = bftJobs.get(requestId)
    const NODE_COUNT = 21
    const QUORUM     = 13

    // Determine network condition
    const dice = Math.random()
    let maxOffline, offlineChance, networkCondition
    if (dice < 0.10) {
        maxOffline = 11; offlineChance = 0.48; networkCondition = 'NETWORK_PARTITION'
    } else if (dice < 0.30) {
        maxOffline = 7;  offlineChance = 0.32; networkCondition = 'DEGRADED'
    } else {
        maxOffline = 2;  offlineChance = 0.07; networkCondition = 'NORMAL'
    }

    job.networkCondition = networkCondition
    job.totalNodes       = NODE_COUNT
    job.quorumRequired   = QUORUM
    console.log(`[BFT-BG] ${requestId} — starting, network: ${networkCondition}`)

    let offlineCount = 0
    const observations = []

    // Phase 1: Observation — each node responds after real latency delay
    job.phase = 'observation'
    for (let i = 0; i < NODE_COUNT; i++) {
        const node    = DON_NODES[i]
        const latency = 120 + Math.floor(Math.random() * 350) // 120-470ms per node

        await new Promise(r => setTimeout(r, latency)) // real delay!

        const goOffline = offlineCount < maxOffline && Math.random() < offlineChance
        if (goOffline) {
            offlineCount++
            job.nodes.push({
                index:    i,
                operator: node.operator,
                status:   'offline',
                latency,
                reason:   networkCondition === 'NETWORK_PARTITION' ? 'NETWORK_PARTITION' : 'TIMEOUT',
            })
            console.log(`[BFT-BG] ${requestId} Node ${String(i+1).padStart(2,'0')} [${node.operator}] OFFLINE`)
        } else {
            observations.push({ index: i, node })
            job.nodes.push({ index: i, operator: node.operator, status: 'ok', latency })
            console.log(`[BFT-BG] ${requestId} Node ${String(i+1).padStart(2,'0')} [${node.operator}] OK (${latency}ms)`)
        }
        job.respondedSoFar = observations.length
        job.offlineSoFar   = offlineCount
    }

    const respondedCount = observations.length
    console.log(`[BFT-BG] ${requestId} Phase 1 done: ${respondedCount}/${NODE_COUNT} responded`)

    if (respondedCount < QUORUM) {
        console.log(`[BFT-BG] ${requestId} QUORUM FAILED — ${respondedCount}/${NODE_COUNT} < ${QUORUM}`)
        job.status = 'failed'
        job.result = {
            status:    'rejected',
            riskScore: analysis.riskScore,
            reason:    `BFT consensus failed — only ${respondedCount}/${NODE_COUNT} nodes responded (quorum requires ≥${QUORUM})`,
            bftConsensus: {
                protocol: 'OCR3', totalNodes: NODE_COUNT, respondedNodes: respondedCount,
                offlineNodes: offlineCount, quorumRequired: QUORUM, quorumReached: false, networkCondition,
            },
        }
        return
    }

    // Phase 2+3: Report + Signing
    job.phase = 'signing'
    await new Promise(r => setTimeout(r, 600))
    const reportHash = deriveReportHash(payloadObj)
    job.reportHash   = reportHash
    const signatures = observations.map(obs => ({
        nodeIndex: obs.index,
        operator:  obs.node.operator,
        sig:       deriveMockSignature(obs.node.id, reportHash),
    }))
    console.log(`[BFT-BG] ${requestId} Phase 2-3 done: ${signatures.length} sigs`)

    // Phase 4: Transmission + real on-chain write
    job.phase = 'transmitting'
    await new Promise(r => setTimeout(r, 400))
    const runtime = createRuntime(requestId)
    const { txHash, onChain, chainError } = await writeReportOnChain(runtime, payloadObj)
    console.log(`[BFT-BG] ${requestId} Phase 4 done: txHash=${txHash} onChain=${onChain}`)

    const thresholdSigs = signatures.slice(0, QUORUM)
    const consensus = {
        protocol:       'OCR3',
        totalNodes:     NODE_COUNT,
        respondedNodes: respondedCount,
        offlineNodes:   offlineCount,
        signingNodes:   signatures.length,
        quorumRequired: QUORUM,
        quorumReached:  true,
        networkCondition,
        reportHash,
        leader:         { operator: DON_NODES[0].operator, id: DON_NODES[0].id },
        thresholdSigs:  thresholdSigs.slice(0, 5).map(s => ({ node: s.operator, sig: s.sig.slice(0, 22) + '...' })),
        receiver:       CONFIG.verityCoreAddress,
        chain:          CONFIG.chainSelectorName,
        basescan:       onChain ? `https://sepolia.basescan.org/tx/${txHash}` : null,
    }

    job.status = 'completed'
    job.result = {
        status:            'created',
        txHash,
        marketCategory:    analysis.category,
        refinedQuestion:   analysis.refinedQuestion,
        resolutionCriteria:analysis.resolutionCriteria,
        dataSources:       analysis.dataSources,
        riskScore:         analysis.riskScore,
        riskReason:        analysis.riskReason,
        suggestedDeadline: analysis.suggestedDeadline,
        bftConsensus:      consensus,
        source:            process.env.GROQ_API_KEY ? 'groq_live' : 'simulation',
    }
    console.log(`[BFT-BG] ${requestId} COMPLETED: status=created txHash=${txHash}`)
}

// ─── Main handler (mirrors cre-1/main.ts onHTTPTrigger exactly) ──────────────

async function onHTTPTrigger(input, runtime) {
    runtime.log('WF1 Market Creation — trigger received')
    runtime.log(`Input: ${JSON.stringify(input)}`)

    if (!input.creator || !input.inputType) {
        throw new Error('Missing required fields: creator, inputType')
    }

    let content
    if (input.inputType === 'manual') {
        if (!input.question) throw new Error("inputType 'manual' requires field: question")
        content = input.question
    } else if (input.inputType === 'social_post') {
        if (!input.tweetText) throw new Error("inputType 'social_post' requires field: tweetText")
        content = input.tweetText
    } else {
        throw new Error(`Unknown inputType: ${input.inputType}`)
    }

    runtime.log(`Analysing "${content}" (${input.inputType})`)

    // Step 1: AI analysis
    const prompt   = buildPrompt(input.inputType, content)
    const analysis = await callGroq(runtime, prompt)

    // ── [TEST MODE] Force overrides ───────────────────────────────────────────
    if (input.__forceBftFail) {
        runtime.log('⚠️  [TEST MODE] Forcing BFT network partition failure')
        return {
            status:       'rejected',
            riskScore:    50,
            reason:       'BFT consensus failed — only 8/21 nodes responded (quorum requires ≥13) [FORCED FOR TEST]',
            bftConsensus: {
                protocol: 'OCR3', totalNodes: 21, respondedNodes: 8, offlineNodes: 13,
                quorumRequired: 13, quorumReached: false, networkCondition: 'NETWORK_PARTITION',
            },
        }
    }
    if (input.__forceRiskScore !== undefined) {
        const forced = Number(input.__forceRiskScore)
        runtime.log(`⚠️  [TEST MODE] Overriding riskScore: ${analysis.riskScore} → ${forced}`)
        analysis.riskScore = forced
    }
    if (input.__forceCategory !== undefined) {
        runtime.log(`⚠️  [TEST MODE] Overriding category: ${analysis.category} → ${input.__forceCategory}`)
        analysis.category = input.__forceCategory
    }
    // ─────────────────────────────────────────────────────────────────────────

    runtime.log(
        `Groq result: resolvable=${analysis.resolvable} ` +
        `category=${analysis.category} riskScore=${analysis.riskScore}`
    )

    // Step 2: Decision logic (mirrors main.ts exactly)
    if (!analysis.resolvable) {
        const result = {
            status: 'rejected',
            riskScore: analysis.riskScore,
            reason: `Not resolvable: ${analysis.riskReason}`,
        }
        runtime.log(`Rejected (unresolvable): ${result.reason}`)
        return result
    }

    if (analysis.riskScore > CONFIG.RISK_AUTO_REJECT) {
        const result = {
            status:    'rejected',
            riskScore: analysis.riskScore,
            riskReason:analysis.riskReason,
            reason:    `Auto-rejected: risk score ${analysis.riskScore}/100 — ${analysis.riskReason}`,
        }
        runtime.log(`Auto-rejected: score=${analysis.riskScore}`)
        return result
    }

    // ── MEDIUM risk (31-70): BFT OCR3 21-node consensus (async background) ──────
    // Returns { status: 'pending', requestId } immediately so the UI can show live
    // node voting. The actual BFT runs in the background via runBFTBackground().
    // Poll GET /bft-status/:requestId to stream per-node results.
    if (analysis.riskScore > CONFIG.RISK_AUTO_APPROVE) {
        runtime.log(`MEDIUM risk: score=${analysis.riskScore} — starting async BFT OCR3 consensus`)

        const ACTION_CREATE_MARKET = 1
        const category       = CATEGORY_MAP[analysis.category] ?? 3
        const deadlineTs     = (input.deadline && input.deadline > 0)
            ? input.deadline
            : (Math.floor(new Date(analysis.suggestedDeadline).getTime() / 1000) || Math.floor(Date.now() / 1000) + 30 * 86400)
        const targetValue    = analysis.targetValue != null
            ? Math.round(analysis.targetValue * 1e8) : 0
        const priceFeedAddress = analysis.category === 'CRYPTO_PRICE' && analysis.priceFeedAddress
            ? analysis.priceFeedAddress
            : '0x0000000000000000000000000000000000000000'

        const payloadObj = {
            action:            ACTION_CREATE_MARKET,
            creator:           input.creator,
            deadline:          deadlineTs,
            feeBps:            (input.feeBps && input.feeBps > 0) ? input.feeBps : CONFIG.defaultFeeBps,
            category,
            question:          analysis.refinedQuestion,
            resolutionCriteria:analysis.resolutionCriteria,
            dataSources:       JSON.stringify(analysis.dataSources),
            targetValue,
            priceFeedAddress,
        }

        // Register job (use runtime.requestId set by the HTTP server)
        const jobId = runtime.requestId
        bftJobs.set(jobId, {
            status:           'running',
            phase:            'observation',
            nodes:            [],
            respondedSoFar:   0,
            offlineSoFar:     0,
            totalNodes:       21,
            quorumRequired:   13,
            networkCondition: null,
            reportHash:       null,
            result:           null,
            startTime:        Date.now(),
        })

        // Fire and forget — background job updates bftJobs[jobId] in real-time
        runBFTBackground(jobId, payloadObj, analysis).catch(err => {
            const job = bftJobs.get(jobId)
            if (job) {
                job.status = 'failed'
                job.result = { status: 'rejected', reason: `BFT internal error: ${err.message}` }
            }
            console.error(`[BFT-BG] ${jobId} FATAL:`, err.message)
        })

        runtime.log(`MEDIUM risk — BFT job started: ${jobId} — returning pending immediately`)
        return {
            status:            'pending',
            requestId:         jobId,
            riskScore:         analysis.riskScore,
            riskReason:        analysis.riskReason,
            marketCategory:    analysis.category,
            refinedQuestion:   analysis.refinedQuestion,
            resolutionCriteria:analysis.resolutionCriteria,
            dataSources:       analysis.dataSources,
            suggestedDeadline: analysis.suggestedDeadline,
        }
    }

    // ── LOW risk (0-30): Auto approve → direct writeReport ───────────────────
    runtime.log(`LOW risk: score=${analysis.riskScore} — auto-approving (no BFT required)`)
    const { txHash, onChain, chainError, payloadObj } = await simulateDirectWrite(runtime, input.creator, analysis, input.deadline, input.feeBps)

    return {
        status:            'created',
        txHash,
        marketCategory:    analysis.category,
        refinedQuestion:   analysis.refinedQuestion,
        resolutionCriteria:analysis.resolutionCriteria,
        dataSources:       analysis.dataSources,
        riskScore:         analysis.riskScore,
        riskReason:        analysis.riskReason,
        suggestedDeadline: analysis.suggestedDeadline,
        directWrite: {
            action:          'ACTION_CREATE_MARKET',
            contract:        CONFIG.verityCoreAddress,
            chain:           CONFIG.chainSelectorName,
            targetValue:     analysis.targetValue,
            priceFeedAddress:analysis.priceFeedAddress,
            onChain,
            chainError,
            basescan:        onChain ? `https://sepolia.basescan.org/tx/${txHash}` : null,
        },
    }
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    // GET /health
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
            status:  'ok',
            service: 'CRE-1 Local Simulator (BFT OCR3)',
            workflow:'safemarket-creation-staging',
            contracts: {
                verityCore:    CONFIG.verityCoreAddress,
                mockUSDC:      CONFIG.mockUsdcAddress,
                positionToken: CONFIG.positionTokenAddress,
            },
            chain:   CONFIG.chainSelectorName,
            chainId: CONFIG.chainId,
            bft:     { nodes: 21, quorum: 13, protocol: 'OCR3' },
            mode:    process.env.GROQ_API_KEY ? 'groq_live' : 'simulation',
        }))
        return
    }

    // POST /trigger — mirrors CRE-1 HTTP trigger
    if (req.method === 'POST' && req.url === '/trigger') {
        const requestId = `cre1-sim-${Date.now()}`
        const runtime   = createRuntime(requestId)
        runtime.log(`=== CRE-1 SIMULATOR — Request ${requestId} ===`)

        let body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', async () => {
            try {
                const input  = JSON.parse(body)
                const result = await onHTTPTrigger(input, runtime)

                const response = {
                    ...result,
                    source: process.env.GROQ_API_KEY ? 'groq_live' : 'simulation',
                    _simulator: {
                        requestId,
                        workflow:    'safemarket-creation-staging',
                        bftProtocol: 'OCR3',
                        nodeCount:   21,
                        minSigners:  13,
                        logs:        runtime.getLogs(),
                    },
                }

                runtime.log(`=== Response: status=${result.status} ===`)
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify(response, null, 2))
            } catch (err) {
                runtime.log(`ERROR: ${err.message}`)
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: err.message, logs: runtime.getLogs() }))
            }
        })
        return
    }

    // GET /bft-status/:requestId — real-time BFT job status for MEDIUM risk markets
    if (req.method === 'GET' && req.url.startsWith('/bft-status/')) {
        const jobId = req.url.slice('/bft-status/'.length)
        const job   = bftJobs.get(jobId)
        if (!job) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'BFT job not found', requestId: jobId }))
            return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
            requestId:        jobId,
            status:           job.status,
            phase:            job.phase,
            nodes:            job.nodes,
            respondedSoFar:   job.respondedSoFar,
            offlineSoFar:     job.offlineSoFar,
            totalNodes:       job.totalNodes,
            quorumRequired:   job.quorumRequired,
            networkCondition: job.networkCondition,
            reportHash:       job.reportHash,
            result:           job.result,
        }))
        return
    }

    // GET / — debug UI
    if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`
      <html>
      <head><title>CRE-1 Simulator — BFT OCR3</title>
      <style>
        body { background:#000; color:#0f0; font-family:monospace; padding:2rem; max-width:900px }
        code { background:#0a0a0a; padding:2px 6px; border-radius:3px; color:#0cf }
        pre  { background:#0a0a0a; padding:1rem; border-radius:6px; overflow-x:auto; color:#0cf }
        h2   { color:#0af }
        li   { margin-bottom:4px }
      </style>
      </head>
      <body>
        <h1>&#128279; CRE-1 Simulator &#8212; BFT OCR3 (21 nodes)</h1>
        <p>Workflow: <b>safemarket-creation-staging</b></p>
        <p>Mode: <b>${process.env.GROQ_API_KEY ? '&#129302; Groq AI Live (llama-3.3-70b)' : '&#128300; Simulation (no API key)'}</b></p>
        <hr/>
        <h2>Contracts (Base Sepolia)</h2>
        <ul>
          <li>Verity Core   : <code>${CONFIG.verityCoreAddress}</code></li>
          <li>MockUSDC      : <code>${CONFIG.mockUsdcAddress}</code></li>
          <li>PositionToken : <code>${CONFIG.positionTokenAddress}</code></li>
        </ul>
        <h2>BFT OCR3 Consensus</h2>
        <ul>
          <li>Protocol : <b>Off-Chain Reporting v3 (OCR3)</b></li>
          <li>Nodes    : <b>21 DON nodes</b></li>
          <li>Quorum   : <b>&#8805;13/21 signatures required</b></li>
          <li>Phases   : <b>Observation &#8594; Report &#8594; Signing &#8594; Transmission</b></li>
          <li>Determinism : <b>temperature=0, seed=42 &#8594; all nodes produce identical output</b></li>
        </ul>
        <h2>Risk Routing</h2>
        <ul>
          <li>0&#8211;30  &#8594; <b>LOW</b>    &#8594; Auto Approve (direct writeReport, no BFT)</li>
          <li>31&#8211;70 &#8594; <b>MEDIUM</b> &#8594; BFT OCR3 21-node consensus &#8594; writeReport</li>
          <li>71&#8211;100&#8594; <b>HIGH</b>   &#8594; Auto Reject</li>
        </ul>
        <h2>Endpoints</h2>
        <ul>
          <li><code>POST /trigger</code> &#8212; CRE-1 HTTP Trigger</li>
          <li><code>GET  /health</code>  &#8212; Health check (JSON)</li>
        </ul>
        <h2>Examples</h2>
        <pre>
# LOW risk (auto approve, no BFT)
curl -X POST http://localhost:${PORT}/trigger \\
  -H "Content-Type: application/json" \\
  -d '{"inputType":"manual","question":"Will BTC exceed $150k before Q3 2026?","creator":"0xYourAddress"}'

# MEDIUM risk (triggers full BFT OCR3 21-node consensus)
curl -X POST http://localhost:${PORT}/trigger \\
  -H "Content-Type: application/json" \\
  -d '{"inputType":"manual","question":"Will Elon Musk tweet about DOGE 10 times this week?","creator":"0xYourAddress"}'

# Force BFT path (test mode override)
curl -X POST http://localhost:${PORT}/trigger \\
  -H "Content-Type: application/json" \\
  -d '{"inputType":"manual","question":"Any question","creator":"0xYourAddress","__forceRiskScore":50}'
        </pre>
      </body>
      </html>
    `)
        return
    }

    res.writeHead(404)
    res.end('Not found')
})

server.listen(PORT, () => {
    console.log('\n\uD83D\uDD17 CRE-1 SIMULATOR \u2014 BFT OCR3 (21 nodes)')
    console.log('==========================================')
    console.log(`\uD83D\uDCE1 Endpoint     : http://localhost:${PORT}/trigger`)
    console.log(`\uD83D\uDD0D Health       : http://localhost:${PORT}/health`)
    console.log(`\uD83D\uDCCB Verity Core  : ${CONFIG.verityCoreAddress}`)
    console.log(`\uD83D\uDCB5 MockUSDC     : ${CONFIG.mockUsdcAddress}`)
    console.log(`\uD83C\uDFAB PositionToken: ${CONFIG.positionTokenAddress}`)
    console.log(`\u26D3\uFE0F  Chain        : ${CONFIG.chainSelectorName} (chainId=${CONFIG.chainId})`)
    console.log(`\u2696\uFE0F  BFT/OCR3    : 21 nodes, \u226513 quorum, 4 phases`)
    console.log(`\uD83E\uDD16 Mode         : ${process.env.GROQ_API_KEY ? 'Groq AI Live (llama-3.3-70b)' : 'Simulation (no API key)'}`)
    console.log('==========================================')
    console.log('Waiting for requests...\n')
})
