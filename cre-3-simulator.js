/**
 * CRE-3 LOCAL SIMULATOR
 * =====================
 * Mirrors EXACTLY cre-3/main.ts:
 *   Trigger : POST /settlement-requested (simulates Log Trigger dari SettlementRequested event)
 *   Step 1  : Decode — extract marketId (from request body)
 *   Step 2  : EVM Read — market info + resolution data (simulated dari request body)
 *   Step 3  : Branch by category:
 *             • CRYPTO_PRICE (0) — simulateChainlinkPrice() → deterministic, confidence=100
 *             • EVENT (1)        — simulateNewsContext() → Groq AI (real jika GROQ_API_KEY set)
 *             • SOCIAL (2)       — simulateSocialMetrics() → Groq AI (real jika GROQ_API_KEY set)
 *   Step 4  : Confidence gate: >= 90 → resolve, < 90 → escalate
 *   Step 5  : EVM Write — onReport(metadata, report) via viem (real jika PRIVATE_KEY set)
 *
 * Run: node cre-3-simulator.js
 * Endpoints:
 *   POST http://localhost:3003/settlement-requested
 *   GET  http://localhost:3003/health
 *   GET  http://localhost:3003/
 *
 * Actions (matches Verity contract):
 *   ACTION_RESOLVE_MARKET = 3   (CRE-1=1 create, CRE-2=2 manipulate, CRE-3=3 resolve)
 *
 * Contract : Verity Core — 0x8Fe663e0F229F718627f1AE82D2B30Ed8a60d13b (Base Sepolia)
 */

import http from 'http'
import https from 'https'
import fs from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createWalletClient, createPublicClient, http as viemHttp, encodeAbiParameters } from 'viem'
import { baseSepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Load .env files (matches cre-1 & cre-2 simulator pattern) ───────────────

function loadEnv(p) {
    const env = {}
    try {
        for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
            const t = line.trim()
            if (!t || t.startsWith('#')) continue
            const eq = t.indexOf('=')
            if (eq === -1) continue
            env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
        }
    } catch { /* ignore */ }
    return env
}

const _dotenv = loadEnv(resolve(__dirname, '../verity-sc/.env'))   // PRIVATE_KEY
const _dotenvCre = loadEnv(resolve(__dirname, '.env'))                // GROQ_API_KEY, NEWS_API_KEY
const PRIVATE_KEY = process.env.PRIVATE_KEY || _dotenv.PRIVATE_KEY

if (!process.env.GROQ_API_KEY && _dotenvCre.GROQ_API_KEY) {
    process.env.GROQ_API_KEY = _dotenvCre.GROQ_API_KEY
}
if (!process.env.NEWS_API_KEY && _dotenvCre.NEWS_API_KEY) {
    process.env.NEWS_API_KEY = _dotenvCre.NEWS_API_KEY
}

// ─── Viem clients ─────────────────────────────────────────────────────────────

let _walletClient = null
let _publicClient = null

function getClients() {
    if (!PRIVATE_KEY) return null
    if (!_walletClient) {
        const account = privateKeyToAccount(PRIVATE_KEY)
        _walletClient = createWalletClient({ account, chain: baseSepolia, transport: viemHttp('https://sepolia.base.org') })
        _publicClient = createPublicClient({ chain: baseSepolia, transport: viemHttp('https://sepolia.base.org') })
    }
    return { walletClient: _walletClient, publicClient: _publicClient }
}

// ─── Config (mirrors cre-3/config.staging.json) ───────────────────────────────

const CONFIG = {
    verityCoreAddress: '0x8Fe663e0F229F718627f1AE82D2B30Ed8a60d13b',
    chainSelectorName: 'ethereum-testnet-sepolia-base-1',
    gasLimit: '2000000',
    groqModel: 'llama-3.3-70b-versatile',
    ethUsdPriceFeed: '0x4aDC67d868Ec7b4e3Fb400c68F57fbb0760B53D1',
    confidenceThreshold: 90,
}

// MarketCategory: matches DataTypes.sol and cre-3/src/config.ts
const CATEGORY_CRYPTO = 0
const CATEGORY_EVENT = 1
const CATEGORY_SOCIAL = 2

const CATEGORY_NAMES = ['CRYPTO_PRICE', 'EVENT', 'SOCIAL', 'OTHER']

// MarketOutcome
const OUTCOME_YES = 1
const OUTCOME_NO = 2

// ─── Runtime logger ────────────────────────────────────────────────────────────

function createRuntime(requestId) {
    const logs = []
    return {
        log: (msg) => {
            const entry = `[CRE3-SIM][${new Date().toISOString()}] ${msg}`
            logs.push(entry)
            console.log(entry)
        },
        getLogs: () => logs,
        requestId,
    }
}

// ─── Step 3a: CRYPTO_PRICE — Simulate Chainlink Price Feed ───────────────────
// Mirrors cre-3/src/evm.ts resolveCryptoPrice — deterministic, no AI

function simulateChainlinkPrice(runtime, resolution) {
    const feedAddress = resolution.priceFeedAddress || CONFIG.ethUsdPriceFeed
    const targetValue = resolution.targetValue || 0

    // Simulate a price: ETH/USD with 8 decimals (realistic range $2000-$5000)
    const simulatedPrice = Math.round((2000 + Math.random() * 3000) * 1e8)
    const isYes = simulatedPrice >= targetValue

    const priceUsd = (simulatedPrice / 1e8).toFixed(2)
    const targetUsd = (targetValue / 1e8).toFixed(2)

    runtime.log(`[CRYPTO_PRICE] Simulated Chainlink feed: ${feedAddress}`)
    runtime.log(`[CRYPTO_PRICE] currentPrice=$${priceUsd} targetValue=$${targetUsd} → ${isYes ? 'YES' : 'NO'}`)

    return {
        outcome: isYes ? OUTCOME_YES : OUTCOME_NO,
        confidence: 100, // Always 100 — deterministic
        reason: `Chainlink price feed (simulated): $${priceUsd} is ${isYes ? '>=' : '<'} target $${targetUsd}`,
        evidenceUrls: [], // Deterministic — no news URLs needed
    }
}

// ─── Step 3b: EVENT — Simulate news context ────────────────────────────────────
// Mirrors cre-3/src/external.ts fetchNewsContext — returns formatted evidence string

function simulateNewsContext(question) {
    const lower = question.toLowerCase()

    if (lower.includes('approve') || lower.includes('pass') || lower.includes('confirm')) {
        return `Recent news from 3 source(s):
  1. [Reuters] Regulatory body publishes guidelines on the matter (${new Date().toISOString().slice(0, 10)})
     Decision expected imminently as committee convenes final session.
  2. [BBC] Sources indicate positive outcome likely for the proposal (${new Date().toISOString().slice(0, 10)})
     Multiple insiders confirm the vote passed with majority approval.
  3. [AP News] Official confirmation pending formal announcement (${new Date().toISOString().slice(0, 10)})
     Regulatory framework now in final drafting stages.`
    }

    if (lower.includes('win') || lower.includes('champion') || lower.includes('elect')) {
        return `Recent news from 3 source(s):
  1. [ESPN] Competition results announced following final round (${new Date().toISOString().slice(0, 10)})
     Outcome confirmed by official governing body.
  2. [BBC Sport] Final standings published after event conclusion (${new Date().toISOString().slice(0, 10)})
     Official results match early projections from analysts.
  3. [Reuters] Event concluded with clear winner declared (${new Date().toISOString().slice(0, 10)})
     No disputes filed in official adjudication process.`
    }

    return `Recent news from 2 source(s):
  1. [Reuters] Developments related to the topic remain ongoing (${new Date().toISOString().slice(0, 10)})
     No definitive confirmation available as of press time.
  2. [AP News] Situation evolving — further updates expected (${new Date().toISOString().slice(0, 10)})
     Multiple sources monitoring for conclusive evidence.`
}

// ─── Step 3c: SOCIAL — Simulate social/viral metrics ─────────────────────────
// Mirrors cre-3/src/external.ts fetchSocialMetrics — returns engagement evidence

function simulateSocialMetrics(question) {
    const lower = question.toLowerCase()

    if (lower.includes('million') || lower.includes('viral') || lower.includes('trend')) {
        return `Social/viral signals from 3 source(s):
  1. [TechCrunch] Topic trending on multiple social platforms simultaneously (${new Date().toISOString().slice(0, 10)})
     Engagement metrics showing significant above-average spikes.
  2. [The Verge] Viral spread confirmed across Twitter, Reddit, and TikTok (${new Date().toISOString().slice(0, 10)})
     Hashtag reached top trending position in several countries.
  3. [BuzzFeed News] Community engagement numbers well above baseline (${new Date().toISOString().slice(0, 10)})
     Independent analytics tools confirm broad organic reach.`
    }

    return `Social/viral signals from 2 source(s):
  1. [The Verge] Topic has moderate social presence, below viral threshold (${new Date().toISOString().slice(0, 10)})
     Metrics indicate regular activity without exceptional spikes.
  2. [Mashable] Social signals mixed — some engagement but not widespread (${new Date().toISOString().slice(0, 10)})
     Insufficient data to confirm metric threshold was reached.`
}

// ─── Step 3 (AI): Groq prompt builders ───────────────────────────────────────
// Mirrors cre-3/src/groq.ts buildEventPrompt and buildSocialPrompt

function buildEventPrompt(question, resolutionCriteria, dataSources, newsContext) {
    return `You are a prediction market resolution expert specializing in real-world events.
Determine whether the following prediction market resolved YES or NO.

MARKET QUESTION:
"${question}"

CATEGORY: EVENT

RESOLUTION CRITERIA:
${resolutionCriteria || '(no criteria specified — use your best judgment)'}

DATA SOURCES CONFIGURED:
${dataSources || '(none specified)'}

NEWS EVIDENCE (multi-source cross-check):
${newsContext}

INSTRUCTIONS:
1. Check if the event described in the question occurred based on the news evidence
2. Cross-check: do multiple sources agree? More agreement = higher confidence
3. Determine: did the event happen? (YES=1 / NO=2)
4. Assign confidence 0-100:
   - 95-100: Multiple reputable sources explicitly confirm/deny the event
   - 80-94 : Clear evidence from 1-2 sources, no contradictions
   - 60-79 : Evidence leans one way but has gaps or ambiguity
   - 0-59  : Insufficient, conflicting, or unclear evidence

IMPORTANT: If evidence is insufficient or conflicting, return low confidence (<90).
The system will ESCALATE instead of auto-resolving if confidence < 90.

Respond ONLY with valid JSON (no markdown, no extra text):
{
  "outcome": 1,
  "confidence": 95,
  "reason": "Clear explanation based on news evidence",
  "evidence": ["source 1 confirms X", "source 2 also reports X"]
}`
}

function buildSocialPrompt(question, resolutionCriteria, dataSources, socialContext) {
    return `You are a prediction market resolution expert specializing in social media and viral events.
Determine whether the following prediction market resolved YES or NO.

MARKET QUESTION:
"${question}"

CATEGORY: SOCIAL

RESOLUTION CRITERIA:
${resolutionCriteria || '(no criteria specified — use your best judgment)'}

DATA SOURCES CONFIGURED:
${dataSources || '(none specified)'}

SOCIAL/VIRAL EVIDENCE:
${socialContext}

INSTRUCTIONS:
1. Check if the social/viral metric described in the question was achieved
2. Look for: mention counts, viral spread, influencer confirmation, platform metrics
3. Determine: did the social condition resolve? (YES=1 / NO=2)
4. Assign confidence 0-100:
   - 95-100: Unambiguous evidence the metric was clearly reached or clearly not reached
   - 80-94 : Strong signals pointing one direction, minor uncertainty
   - 60-79 : Mixed signals or social evidence is indirect
   - 0-59  : Insufficient or unverifiable social evidence

IMPORTANT: Social markets are harder to verify objectively.
If evidence is insufficient or conflicting, return low confidence (<90).
The system will ESCALATE instead of auto-resolving if confidence < 90.

Respond ONLY with valid JSON (no markdown, no extra text):
{
  "outcome": 1,
  "confidence": 85,
  "reason": "Clear explanation based on social signals",
  "evidence": ["trending signal 1", "viral metric 2"]
}`
}

// ─── Step 3 (AI): Groq call (mirrors cre-3/src/groq.ts callGroqForResolution) ─

async function callGroqForResolution(runtime, prompt) {
    const groqKey = process.env.GROQ_API_KEY
    if (!groqKey) {
        runtime.log('GROQ_API_KEY not set — using deterministic simulation')
        return simulateResolution(prompt)
    }

    runtime.log(`Calling Groq AI for resolution (${CONFIG.groqModel})...`)

    return new Promise((resolve) => {
        const body = JSON.stringify({
            model: CONFIG.groqModel,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
            response_format: { type: 'json_object' },
        })

        const req = https.request({
            hostname: 'api.groq.com',
            path: '/openai/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${groqKey}`,
                'Content-Length': Buffer.byteLength(body),
            },
        }, (res) => {
            let data = ''
            res.on('data', chunk => data += chunk)
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    runtime.log(`Groq error ${res.statusCode} — falling back to simulation`)
                    resolve(simulateResolution(prompt))
                    return
                }
                const resp = JSON.parse(data)
                const rawContent = resp.choices?.[0]?.message?.content
                if (!rawContent) {
                    runtime.log('Empty Groq response — falling back to simulation')
                    resolve(simulateResolution(prompt))
                    return
                }
                runtime.log('Groq AI response received')
                const parsed = JSON.parse(rawContent)
                parsed.confidence = Math.min(100, Math.max(0, Math.round(parsed.confidence)))
                resolve(parsed)
            })
        })
        req.on('error', (err) => {
            runtime.log(`Groq network error: ${err.message} — falling back`)
            resolve(simulateResolution(prompt))
        })
        req.write(body)
        req.end()
    })
}

// ─── Simulation mode for AI resolution ───────────────────────────────────────

function simulateResolution(prompt) {
    const lower = prompt.toLowerCase()

    // Evidence-based heuristics
    let confidence = 55 // default: low (will escalate)
    let outcome = OUTCOME_NO

    const positiveSignals = [
        'confirm', 'approved', 'reached', 'achieved', 'won', 'success',
        'trending', 'viral', 'passed', 'elected', 'launched', 'completed',
    ]
    const negativeSignals = [
        'rejected', 'failed', 'denied', 'not reached', 'below', 'cancel',
        'postponed', 'no official', 'unclear', 'conflicting',
    ]

    let posCount = positiveSignals.filter(s => lower.includes(s)).length
    let negCount = negativeSignals.filter(s => lower.includes(s)).length

    if (posCount > negCount + 1) {
        outcome = OUTCOME_YES
        confidence = 60 + Math.min(posCount * 8, 35) // 60-95
    } else if (negCount > posCount) {
        outcome = OUTCOME_NO
        confidence = 60 + Math.min(negCount * 8, 30) // 60-90
    } else {
        confidence = 40 + Math.floor(Math.random() * 30) // 40-70 → will escalate
    }

    const evidenceItems = []
    if (lower.includes('multiple sources')) evidenceItems.push('multiple news sources corroborate')
    if (lower.includes('confirmed')) evidenceItems.push('official confirmation detected in evidence')
    if (lower.includes('trending')) evidenceItems.push('viral/trending signal detected')
    if (evidenceItems.length === 0) evidenceItems.push('limited evidence available')

    return {
        outcome,
        confidence,
        reason: confidence >= 90
            ? `Strong evidence indicates ${outcome === OUTCOME_YES ? 'YES' : 'NO'}: ${evidenceItems.join('; ')}`
            : `Insufficient evidence for auto-resolution (confidence ${confidence}%). Escalating for manual review.`,
        evidence: evidenceItems,
        evidenceUrls: [], // sim mode — no real URLs
    }
}

// ─── Step 5: On-chain write via onReport() ────────────────────────────────────
// Mirrors cre-3/src/evm.ts submitResolveMarket — ABI matches Verity contract

const CRE_ADAPTER_ABI = [
    {
        name: 'onReport',
        type: 'function',
        inputs: [
            { name: 'metadata', type: 'bytes' },
            { name: 'report', type: 'bytes' },
        ],
        outputs: [],
        stateMutability: 'nonpayable',
    },
]

// keccak256("cre-3-smartresolve-staging") — unique WORKFLOW_ID for CRE-3
const WORKFLOW_ID = '0xa3f17d9e2c4b8e1f6d5c0a9b3e7f2d8c1a4b6e9f0d3c7a2b5e8f1d4c6a9b2e5f'

function mockTxHash() {
    return '0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
}

async function writeResolveOnChain(runtime, marketId, outcome, confidence, reason, evidenceUrls) {
    const ACTION_RESOLVE_MARKET = 3

    runtime.log('Encoding ACTION_RESOLVE_MARKET ABI payload...')
    runtime.log(`  action      : ${ACTION_RESOLVE_MARKET} (ACTION_RESOLVE_MARKET)`)
    runtime.log(`  marketId    : ${marketId}`)
    runtime.log(`  outcome     : ${outcome} (${outcome === OUTCOME_YES ? 'YES' : 'NO'})`)
    runtime.log(`  confidence  : ${confidence}%`)
    runtime.log(`  reason      : "${reason.slice(0, 80)}..."`)
    runtime.log(`  evidenceUrls: [${evidenceUrls.slice(0, 2).join(', ')}]`)

    // ABI-encode report — mirrors cre-3/src/evm.ts submitResolveMarket encodeAbiParameters
    // resolveMarketFromCre(uint256 marketId, uint8 outcome, uint8 confidence, string[] evidenceUrls)
    const report = encodeAbiParameters(
        [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'uint8' }, { type: 'string' }, { type: 'string[]' }],
        [ACTION_RESOLVE_MARKET, BigInt(marketId), outcome, confidence, reason, evidenceUrls],
    )

    // Encode metadata: workflowId as bytes32
    const workflowIdBytes = WORKFLOW_ID.startsWith('0x')
        ? Buffer.from(WORKFLOW_ID.slice(2).padStart(64, '0'), 'hex')
        : Buffer.from(WORKFLOW_ID.padStart(64, '0'), 'hex')
    const metadata = '0x' + workflowIdBytes.toString('hex')

    runtime.log(`Submitting writeReport → receiver: ${CONFIG.verityCoreAddress}`)

    const clients = getClients()
    if (!clients) {
        const hash = mockTxHash()
        runtime.log(`[MOCK] No PRIVATE_KEY — mock txHash: ${hash}`)
        return { txHash: hash, onChain: false }
    }

    try {
        const txHash = await clients.walletClient.writeContract({
            address: CONFIG.verityCoreAddress,
            abi: CRE_ADAPTER_ABI,
            functionName: 'onReport',
            args: [metadata, report],
        })
        runtime.log(`[CHAIN] onReport() submitted: txHash=${txHash}`)
        runtime.log(`[CHAIN] Basescan: https://sepolia.basescan.org/tx/${txHash}`)
        return { txHash, onChain: true }
    } catch (err) {
        runtime.log(`[CHAIN] ERROR: ${err.shortMessage || err.message}`)
        const hash = mockTxHash()
        runtime.log(`[CHAIN] Falling back to mock txHash: ${hash}`)
        return { txHash: hash, onChain: false }
    }
}

// ─── Main handler (mirrors cre-3/main.ts onSettlementRequested) ──────────────

async function onSettlementRequested(marketId, market, resolution, runtime) {
    runtime.log('WF3 Smart Resolution — SettlementRequested event received')
    runtime.log(`Settlement requested for marketId=${marketId}`)

    // ── Step 2: Market info ────────────────────────────────────────────────────
    runtime.log(
        `Market: question="${market.question}" category=${CATEGORY_NAMES[market.category] ?? 'OTHER'} status=${market.status ?? 0}`,
    )
    runtime.log(
        `Resolution: criteria="${resolution.resolutionCriteria?.slice(0, 80) ?? ''}" targetValue=${resolution.targetValue ?? 0} priceFeed=${resolution.priceFeedAddress ?? '(none)'}`,
    )

    // Skip already resolved/escalated markets (status 2=Resolved, 3=Escalated)
    if (market.status === 2 || market.status === 3) {
        runtime.log(`Market ${marketId} already resolved/escalated (status=${market.status}), skipping`)
        return { action: 'skipped', reason: 'already_finalized', marketId }
    }

    // ── Step 3: Branch by category ─────────────────────────────────────────────
    let result

    if (market.category === CATEGORY_CRYPTO) {
        runtime.log('Branch: CRYPTO_PRICE — reading Chainlink Price Feed (deterministic)')
        result = simulateChainlinkPrice(runtime, resolution)
    } else if (market.category === CATEGORY_SOCIAL) {
        // SOCIAL: social/viral metrics → AI analysis
        runtime.log(`Branch: SOCIAL — fetching social/viral metrics`)
        const socialContext = simulateSocialMetrics(market.question)
        runtime.log(`Social context fetched`)

        const prompt = buildSocialPrompt(
            market.question,
            resolution.resolutionCriteria ?? '',
            resolution.dataSources ?? '',
            socialContext,
        )
        result = await callGroqForResolution(runtime, prompt)
    } else {
        // EVENT / OTHER: news context → AI analysis
        const label = CATEGORY_NAMES[market.category] ?? 'OTHER'
        runtime.log(`Branch: ${label} — fetching news context`)
        const newsContext = simulateNewsContext(market.question)
        runtime.log(`News context fetched`)

        const prompt = buildEventPrompt(
            market.question,
            resolution.resolutionCriteria ?? '',
            resolution.dataSources ?? '',
            newsContext,
        )
        result = await callGroqForResolution(runtime, prompt)
    }

    runtime.log(
        `Resolution result: outcome=${result.outcome} confidence=${result.confidence}% reason="${result.reason}"`,
    )

    // ── Step 4: Confidence gate ────────────────────────────────────────────────
    const threshold = CONFIG.confidenceThreshold
    const outcomeLabel = result.outcome === OUTCOME_YES ? 'YES' : 'NO'

    // Both resolved and escalated write to chain.
    const { txHash, onChain } = await writeResolveOnChain(
        runtime,
        marketId,
        result.outcome,
        result.confidence,
        result.reason,
        result.evidenceUrls ?? [],
    )

    runtime.log(`[CRE-3] TxStatus: ${onChain ? 'ON-CHAIN' : 'MOCK'} — txHash: ${txHash}`)

    if (result.confidence < threshold) {
        runtime.log(
            `LOW CONFIDENCE: ${result.confidence}% < ${threshold}% — escalated (contract handles Escalated state)`,
        )
        return {
            action: 'escalated',
            marketId,
            outcome: result.outcome,
            outcomeLabel,
            confidence: result.confidence,
            reason: result.reason,
            evidenceUrls: result.evidenceUrls ?? [],
            threshold,
            txHash,
            onChain,
        }
    }

    runtime.log(`RESOLVE: confidence ${result.confidence}% >= ${threshold}% — market resolved`)
    runtime.log(`WF3 complete: marketId=${marketId} outcome=${outcomeLabel} txHash=${txHash}`)

    return {
        action: 'resolved',
        marketId,
        outcome: result.outcome,
        outcomeLabel,
        confidence: result.confidence,
        reason: result.reason,
        evidenceUrls: result.evidenceUrls ?? [],
        txHash,
        onChain,
    }
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const PORT = process.env.CRE3_PORT || 3003

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    // GET /health
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
            status: 'ok',
            service: 'CRE-3 Smart Resolution Simulator',
            contract: CONFIG.verityCoreAddress,
            chain: CONFIG.chainSelectorName,
            mode: process.env.GROQ_API_KEY ? 'groq_live' : 'simulation',
            onChain: !!PRIVATE_KEY,
            threshold: CONFIG.confidenceThreshold,
            categories: { 0: 'CRYPTO_PRICE (deterministic)', 1: 'EVENT (AI)', 2: 'SOCIAL (AI)' },
        }))
        return
    }

    // POST /settlement-requested  — mirrors CRE-3 Log Trigger
    if (req.method === 'POST' && req.url === '/settlement-requested') {
        const requestId = `cre3-sim-${Date.now()}`
        const runtime = createRuntime(requestId)
        runtime.log(`=== CRE-3 SIMULATOR — Request ${requestId} ===`)

        let body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', async () => {
            try {
                const payload = JSON.parse(body)

                // Expect: { marketId, market: MarketInfo, resolution: ResolutionData }
                const { marketId, market, resolution } = payload
                if (marketId === undefined || !market) {
                    throw new Error('Request must have { marketId, market, resolution }')
                }

                const result = await onSettlementRequested(
                    marketId,
                    market,
                    resolution ?? {},
                    runtime,
                )

                const response = {
                    ...result,
                    source: process.env.GROQ_API_KEY ? 'groq_live' : 'simulation',
                    _simulator: {
                        requestId,
                        workflow: 'cre-3-smartresolve-staging',
                        nodeCount: 21,
                        consensusType: 'BFT',
                        donId: 'DON-SIMULATED',
                        logs: runtime.getLogs(),
                    },
                }

                runtime.log(`=== Response: action=${result.action} confidence=${result.confidence}% ===`)
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

    // GET / — browser debug UI
    if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`
      <html>
      <head><title>CRE-3 Smart Resolution Simulator</title>
      <style>body{background:#0a0a1a;color:#7fff7f;font-family:monospace;padding:2rem;max-width:900px}
      h1{color:#00ffcc}code,pre{background:#111;padding:.2rem .5rem;border-radius:4px;border:1px solid #1a3}
      pre{padding:1rem;overflow-x:auto}h2{color:#7fccff;margin-top:2rem}
      .badge{display:inline-block;padding:.2rem .6rem;border-radius:4px;font-size:.85em}
      .green{background:#003300;color:#00ff00}.yellow{background:#332200;color:#ffaa00}.blue{background:#001133;color:#00aaff}
      </style>
      </head>
      <body>
        <h1>⚖️ CRE-3 Smart Resolution Simulator</h1>
        <p>Contract: <code>${CONFIG.verityCoreAddress}</code></p>
        <p>
          Mode: <span class="badge ${process.env.GROQ_API_KEY ? 'green' : 'yellow'}">${process.env.GROQ_API_KEY ? '🤖 Groq AI Live' : '🔬 Simulation'}</span>
          &nbsp;
          Write: <span class="badge ${PRIVATE_KEY ? 'green' : 'yellow'}">${PRIVATE_KEY ? '⛓️ On-Chain' : '🎭 Mock TxHash'}</span>
        </p>
        <p>Confidence threshold: <b>${CONFIG.confidenceThreshold}%</b> — below = ESCALATE, above = RESOLVE</p>
        <hr style="border-color:#1a3"/>
        <h2>Categories</h2>
        <p>
          <span class="badge blue">0 CRYPTO_PRICE</span> Deterministic via Chainlink, confidence=100 always<br>
          <span class="badge blue">1 EVENT</span> AI-powered via Groq + News evidence cross-check<br>
          <span class="badge blue">2 SOCIAL</span> AI-powered via Groq + Social/viral metrics
        </p>
        <h2>Endpoint</h2>
        <code>POST /settlement-requested</code> — triggers Smart Resolution
        <h2>Examples</h2>
        <pre># CRYPTO_PRICE (deterministic, confidence=100)
curl -X POST http://localhost:${PORT}/settlement-requested \\
  -H "Content-Type: application/json" \\
  -d '{
    "marketId": 1,
    "market": { "question": "Will ETH exceed $4000?", "category": 0, "status": 0 },
    "resolution": {
      "resolutionCriteria": "ETH/USD price >= $4000",
      "targetValue": 400000000000,
      "priceFeedAddress": "${CONFIG.ethUsdPriceFeed}",
      "dataSources": "chainlink"
    }
  }'

# EVENT (AI-powered via Groq)
curl -X POST http://localhost:${PORT}/settlement-requested \\
  -H "Content-Type: application/json" \\
  -d '{
    "marketId": 2,
    "market": { "question": "Will Ethereum spot ETF be approved in 2025?", "category": 1, "status": 0 },
    "resolution": {
      "resolutionCriteria": "SEC approves a spot Ethereum ETF before Dec 31 2025",
      "targetValue": 0,
      "priceFeedAddress": "0x0000000000000000000000000000000000000000",
      "dataSources": "reuters.com,bbc.com,sec.gov"
    }
  }'

# SOCIAL (AI-powered via Groq)
curl -X POST http://localhost:${PORT}/settlement-requested \\
  -H "Content-Type: application/json" \\
  -d '{
    "marketId": 3,
    "market": { "question": "Will #Bitcoin reach 1M Twitter mentions in 24h?", "category": 2, "status": 0 },
    "resolution": {
      "resolutionCriteria": "Bitcoin Twitter mentions exceed 1,000,000 in any 24h window",
      "targetValue": 1000000,
      "priceFeedAddress": "0x0000000000000000000000000000000000000000",
      "dataSources": "twitter.com,newsapi.org"
    }
  }'</pre>
      </body>
      </html>
    `)
        return
    }

    res.writeHead(404)
    res.end('Not found')
})

server.listen(PORT, () => {
    console.log('\n⚖️  CRE-3 SMART RESOLUTION SIMULATOR STARTED')
    console.log('=============================================')
    console.log(`📡 Endpoint  : http://localhost:${PORT}/settlement-requested`)
    console.log(`🔍 Health    : http://localhost:${PORT}/health`)
    console.log(`📋 Contract  : ${CONFIG.verityCoreAddress}`)
    console.log(`⛓️  Chain     : ${CONFIG.chainSelectorName}`)
    console.log(`🎯 Threshold : confidence >= ${CONFIG.confidenceThreshold}% → RESOLVE | < ${CONFIG.confidenceThreshold}% → ESCALATE`)
    console.log(`🤖 Mode      : ${process.env.GROQ_API_KEY ? 'Groq AI Live (llama-3.3-70b)' : 'Simulation (no API key)'}`)
    console.log(`🔑 On-chain  : ${PRIVATE_KEY ? 'YES — real onReport() writes' : 'NO — mock txHash'}`)
    console.log('=============================================')
    console.log('Categories: 0=CRYPTO_PRICE (deterministic) | 1=EVENT (AI) | 2=SOCIAL (AI)')
    console.log('Waiting for SettlementRequested events...\n')
})
