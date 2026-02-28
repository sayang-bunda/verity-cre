/**
 * CRE-2 LOCAL SIMULATOR
 * =====================
 * Mirrors EXACTLY cre-2/main.ts:
 *   Trigger : POST /bet-placed (simulates Log Trigger dari BetPlaced event)
 *   Step 2  : EVM Read (simulated — market data dari request body)
 *   Step 3  : News context (simulated) + Chainlink price (simulated)
 *   Step 4  : Groq AI manipulation analysis (real jika GROQ_API_KEY set)
 *   Step 5  : Decision: safe (0-30) / monitor (31-70) / flag+pause (71-100)
 *   Step 6  : Simulate reportManipulation ABI encode + writeReport
 *
 * Run: node cre-2-simulator.js
 * POST http://localhost:3002/bet-placed
 *
 * Thresholds (matches RiskEngine.sol MANIPULATION_THRESHOLD=70):
 *   0-30  → safe     → no action
 *   31-70 → monitor  → log warning on-chain
 *   71-100→ flag     → market PAUSED + reportManipulation
 */

import http from 'http'
import https from 'https'

// ─── Config (mirrors cre-2/config.staging.json) ──────────────────────────────

const CONFIG = {
    verityCoreAddress: '0x32623263b4dE10FA22B74235714820f057b105Ea',
    chainSelectorName: 'ethereum-testnet-sepolia-base-1',
    gasLimit: '2000000',
    groqModel: 'llama-3.3-70b-versatile',
    ethUsdPriceFeed: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1',
    btcUsdPriceFeed: '0x0FB99723Aee6f420beAD13e6bBB79b7E6F034298',
    SCORE_SAFE: 30,
    SCORE_FLAG: 70,
}

const CATEGORY_NAMES = ['CRYPTO_PRICE', 'POLITICAL', 'SPORTS', 'OTHER']

// ─── Runtime logger ────────────────────────────────────────────────────────────

function createRuntime(requestId) {
    const logs = []
    return {
        log: (msg) => {
            const entry = `[CRE2-SIM][${new Date().toISOString()}] ${msg}`
            logs.push(entry)
            console.log(entry)
        },
        getLogs: () => logs,
        requestId,
    }
}

// ─── Step 3a: Simulated news context ─────────────────────────────────────────

function simulateNewsContext(category, amount, volume) {
    const categoryName = CATEGORY_NAMES[category] ?? 'OTHER'
    const volumeRatio = volume > 0 ? amount / volume : 999

    if (volumeRatio > 5) {
        return `- Recent news:\n  • ALERT: Unusual trading volume spike detected in ${categoryName} markets\n  • Large whale transaction observed without supporting news catalysts`
    }
    return `- Recent news:\n  • Normal market activity in ${categoryName} category\n  • No major upcoming events detected`
}

// ─── Step 3b: Simulated Chainlink price ───────────────────────────────────────

function simulateChainlinkPrice(category) {
    if (category !== 0) return '' // Only for CRYPTO_PRICE
    // Simulated ETH/USD price
    const price = (2000 + Math.random() * 500).toFixed(2)
    return `$${price}`
}

// ─── Step 3c: Simulated scheduled events ──────────────────────────────────────

function simulateScheduledEvents(category) {
    const events = {
        0: '- Scheduled events (next 48h):\n  • Crypto market: Fed meeting in 24h (potential volatility)',
        1: '- Scheduled events (next 48h):\n  • No major political events in 48h',
        2: '- Scheduled events (next 48h):\n  • Sports: Major match scheduled in 36h',
        3: '- Scheduled events (next 48h):\n  • No major events in 48h',
    }
    return events[category] ?? events[3]
}

// ─── Step 4: Build AI prompt (mirrors cre-2/src/groq.ts buildAnalysisPrompt) ─

function buildAnalysisPrompt(bet, market, newsContext, priceContext, scheduledEvents) {
    const totalPool = (market.poolYes || 0) + (market.poolNo || 0)
    const yesPrice = totalPool > 0 ? ((market.poolNo / totalPool) * 100).toFixed(1) : '50.0'
    const volumeMultiple = market.totalVolume > 0
        ? (bet.amount / market.totalVolume).toFixed(1)
        : '999'
    const bettorContext = (market.bettorCount || 0) <= 1
        ? 'first time in this market'
        : `market has ${market.bettorCount} bettors`

    return `You are a prediction market manipulation detector for an on-chain prediction market protocol.

MARKET CONTEXT:
- Question: "${market.question}"
- Market ID: ${bet.marketId}
- Category: ${CATEGORY_NAMES[market.category] ?? 'OTHER'}
- Current YES price: ${yesPrice}%
- Pool sizes: YES=${market.poolYes} / NO=${market.poolNo}
- Total volume: ${market.totalVolume}
- Bettors: ${market.bettorCount}
- Deadline: ${market.deadline}
- Current manipulation score: ${market.manipulationScore || 0}/100

THIS BET:
- Amount: ${bet.amount} (${volumeMultiple}x total volume)
- Direction: ${bet.isYes ? 'YES' : 'NO'}
- Bettor: ${bettorContext}

EXTERNAL CONTEXT:
${newsContext}
${market.category === 0 ? `- Current price: ${priceContext}` : ''}
${scheduledEvents}

Analyse this bet for potential manipulation. Consider:
1. Volume spike: Is this bet disproportionately large vs total volume?
2. Price impact: Does this bet drastically move the price?
3. Timing: Is this suspiciously close to deadline with no supporting evidence?
4. Information asymmetry: Is there news that would justify this bet?
5. Wash trading patterns: Is the bettor acting suspiciously?

Score 0-100:
- 0-30: Normal trading activity, no concern
- 31-80: Suspicious but not conclusive, worth monitoring
- 81-100: Highly likely manipulation, market should be paused

Respond ONLY with valid JSON (no markdown, no extra text):
{
  "manipulationScore": 25,
  "reason": "Brief explanation of the assessment",
  "patterns_matched": ["volume_spike", "no_news_support"],
  "recommendation": "safe"
}`
}

// ─── Step 4: Groq AI call (mirrors cre-2/src/groq.ts callGroqAI) ─────────────

async function callGroqAI(runtime, prompt) {
    const groqKey = process.env.GROQ_API_KEY
    if (!groqKey) {
        runtime.log('GROQ_API_KEY not set — using deterministic simulation')
        return simulateAnalysis(prompt)
    }

    runtime.log(`Calling Groq AI for manipulation analysis (${CONFIG.groqModel})...`)

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
                    resolve(simulateAnalysis(prompt))
                    return
                }
                const resp = JSON.parse(data)
                const rawContent = resp.choices?.[0]?.message?.content
                if (!rawContent) {
                    runtime.log('Empty Groq response — falling back to simulation')
                    resolve(simulateAnalysis(prompt))
                    return
                }
                runtime.log('Groq AI response received')
                resolve(JSON.parse(rawContent))
            })
        })
        req.on('error', (err) => {
            runtime.log(`Groq network error: ${err.message} — falling back`)
            resolve(simulateAnalysis(prompt))
        })
        req.write(body)
        req.end()
    })
}

// ─── Simulation mode for AI analysis ─────────────────────────────────────────

function simulateAnalysis(prompt) {
    const lower = prompt.toLowerCase()

    // Extract volume multiple from prompt
    const volumeMatch = lower.match(/(\d+(?:\.\d+)?)x total volume/)
    const volumeMultiple = volumeMatch ? parseFloat(volumeMatch[1]) : 1

    let score = 10 // Default: safe
    const patterns = []

    // Volume spike detection
    if (volumeMultiple > 10) {
        score += 50
        patterns.push('extreme_volume_spike')
    } else if (volumeMultiple > 3) {
        score += 25
        patterns.push('volume_spike')
    }

    // First bettor is more suspicious in large bets
    if (lower.includes('first time in this market') && volumeMultiple > 2) {
        score += 15
        patterns.push('first_bettor_large_bet')
    }

    // No news context = suspicious
    if (lower.includes('unusual trading volume spike')) {
        score += 10
        patterns.push('no_news_support')
    }

    // Deadline proximity
    if (lower.includes('24h') || lower.includes('12h')) {
        score += 10
        patterns.push('deadline_proximity')
    }

    // Cap at 100
    score = Math.min(score, 100)

    let recommendation = 'safe'
    if (score > CONFIG.SCORE_FLAG) recommendation = 'flag'
    else if (score > CONFIG.SCORE_SAFE) recommendation = 'monitor'

    return {
        manipulationScore: score,
        reason: score > 70
            ? `High-risk bet detected: ${patterns.join(', ')}. Market flagged for review.`
            : score > 30
                ? `Suspicious activity: ${patterns.join(', ')}. Monitoring recommended.`
                : 'Normal trading activity. No manipulation patterns detected.',
        patterns_matched: patterns.length > 0 ? patterns : ['none'],
        recommendation,
    }
}

// ─── Step 6: Simulate reportManipulation (mirrors main.ts submitManipulationReport) ─

function simulateManipulationReport(runtime, marketId, score, reason) {
    const ACTION_REPORT_MANIPULATION = 2

    runtime.log('Encoding ACTION_REPORT_MANIPULATION ABI payload...')
    runtime.log(`  action   : ${ACTION_REPORT_MANIPULATION} (ACTION_REPORT_MANIPULATION)`)
    runtime.log(`  marketId : ${marketId}`)
    runtime.log(`  score    : ${score}`)
    runtime.log(`  reason   : "${reason.slice(0, 80)}..."`)

    // Mirror: runtime.report({ encodedPayload, encoderName, signingAlgo, hashingAlgo })
    const payloadObj = { action: ACTION_REPORT_MANIPULATION, marketId, score, reason }
    const encodedPayload = Buffer.from(JSON.stringify(payloadObj)).toString('base64')
    runtime.log(`Payload base64 (first 60): ${encodedPayload.slice(0, 60)}...`)

    runtime.log('Simulating BFT consensus (12 DON nodes signing)...')
    runtime.log(`Submitting writeReport → receiver: ${CONFIG.verityCoreAddress}`)

    const txHash = '0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('')

    runtime.log(`[SIM] writeReport submitted: txHash=${txHash}`)
    runtime.log(`[SIM] TxStatus.SUCCESS (simulated — not real on-chain)`)
    runtime.log(`Manipulation reported — txHash: ${txHash}`)

    return txHash
}

// ─── Main handler (mirrors cre-2/main.ts onBetPlaced) ────────────────────────

async function onBetPlaced(bet, market, runtime) {
    runtime.log('WF2 Trading Anomaly Detection — BetPlaced event received')
    runtime.log(`Bet: marketId=${bet.marketId} bettor=${bet.bettor} isYes=${bet.isYes} amount=${bet.amount}`)

    // Skip if market not active (status 0 = Active)
    if (market.status !== undefined && market.status !== 0) {
        runtime.log(`Market ${bet.marketId} is not active (status=${market.status}), skipping`)
        return { action: 'skipped', reason: 'market_not_active' }
    }

    const categoryName = CATEGORY_NAMES[market.category] ?? 'OTHER'
    runtime.log(`Market: question="${market.question}" category=${categoryName} poolYes=${market.poolYes} poolNo=${market.poolNo} bettors=${market.bettorCount}`)

    // Step 3: External context (simulated)
    const newsContext = simulateNewsContext(market.category, bet.amount, market.totalVolume)
    const priceContext = simulateChainlinkPrice(market.category)
    const scheduledEvents = simulateScheduledEvents(market.category)
    runtime.log('External context simulated (News + Price + Events)')
    if (priceContext) runtime.log(`Chainlink price: ${priceContext}`)

    // Step 4: AI analysis
    const prompt = buildAnalysisPrompt(bet, market, newsContext, priceContext, scheduledEvents)
    const analysis = await callGroqAI(runtime, prompt)
    runtime.log(`AI result: score=${analysis.manipulationScore} recommendation=${analysis.recommendation} patterns=[${analysis.patterns_matched.join(',')}]`)

    // Step 5: Decision
    if (analysis.manipulationScore <= CONFIG.SCORE_SAFE) {
        runtime.log(`SAFE: score=${analysis.manipulationScore} — no action taken`)
        return {
            action: 'safe',
            manipulationScore: analysis.manipulationScore,
            reason: analysis.reason,
            patterns_matched: analysis.patterns_matched,
        }
    }

    const action = analysis.manipulationScore > CONFIG.SCORE_FLAG ? 'flag' : 'monitor'
    runtime.log(`${action.toUpperCase()}: score=${analysis.manipulationScore} — writing to chain`)

    // Step 6: EVM Write — reportManipulation
    const txHash = simulateManipulationReport(
        runtime,
        bet.marketId,
        analysis.manipulationScore,
        `[${action}] ${analysis.reason} | patterns: ${analysis.patterns_matched.join(', ')}`,
    )

    return {
        action,
        manipulationScore: analysis.manipulationScore,
        reason: analysis.reason,
        patterns_matched: analysis.patterns_matched,
        recommendation: analysis.recommendation,
        txHash,
        marketPaused: action === 'flag',
    }
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const PORT = process.env.CRE2_PORT || 3002

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
            service: 'CRE-2 Anomaly Detection Simulator',
            contract: CONFIG.verityCoreAddress,
            chain: CONFIG.chainSelectorName,
            mode: process.env.GROQ_API_KEY ? 'groq_live' : 'simulation',
            thresholds: { safe: CONFIG.SCORE_SAFE, flag: CONFIG.SCORE_FLAG },
        }))
        return
    }

    // POST /bet-placed  — mirrors CRE-2 Log Trigger
    if (req.method === 'POST' && req.url === '/bet-placed') {
        const requestId = `cre2-sim-${Date.now()}`
        const runtime = createRuntime(requestId)
        runtime.log(`=== CRE-2 SIMULATOR — Request ${requestId} ===`)

        let body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', async () => {
            try {
                const payload = JSON.parse(body)

                // Expect: { bet: BetInfo, market: MarketData }
                const { bet, market } = payload
                if (!bet || !market) throw new Error('Request must have { bet, market }')

                const result = await onBetPlaced(bet, market, runtime)

                const response = {
                    ...result,
                    source: process.env.GROQ_API_KEY ? 'groq_live' : 'simulation',
                    _simulator: {
                        requestId,
                        workflow: 'safemarket-anomaly-detection-staging',
                        nodeCount: 12,
                        consensusType: 'BFT',
                        donId: 'DON-SIMULATED',
                        logs: runtime.getLogs(),
                    },
                }

                runtime.log(`=== Response: action=${result.action} ===`)
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

    // GET /  — debug UI
    if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`
      <html>
      <head><title>CRE-2 Simulator</title>
      <style>body{background:#000;color:#0f0;font-family:monospace;padding:2rem;max-width:800px}</style>
      </head>
      <body>
        <h1>🛡️ CRE-2 Anomaly Detection Simulator</h1>
        <p>Contract: <code>${CONFIG.verityCoreAddress}</code></p>
        <p>Mode: <b>${process.env.GROQ_API_KEY ? '🤖 Groq AI Live' : '🔬 Simulation'}</b></p>
        <p>Thresholds: SAFE ≤${CONFIG.SCORE_SAFE} | MONITOR ${CONFIG.SCORE_SAFE + 1}-${CONFIG.SCORE_FLAG} | FLAG >${CONFIG.SCORE_FLAG}</p>
        <hr/>
        <h2>Endpoint</h2>
        <code>POST /bet-placed</code> — triggers anomaly detection
        <h2>Example</h2>
        <pre>curl -X POST http://localhost:${PORT}/bet-placed \\
  -H "Content-Type: application/json" \\
  -d '{
    "bet": {
      "marketId": 1,
      "bettor": "0xSomeAddress",
      "isYes": true,
      "amount": 50000,
      "shares": 45000,
      "feeAmount": 500
    },
    "market": {
      "question": "Will BTC exceed $100k?",
      "category": 0,
      "poolYes": 10000,
      "poolNo": 10000,
      "totalVolume": 20000,
      "bettorCount": 5,
      "manipulationScore": 0,
      "status": 0,
      "deadline": "2026-12-31T00:00:00Z"
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
    console.log('\n🛡️ CRE-2 ANOMALY DETECTION SIMULATOR STARTED')
    console.log('=============================================')
    console.log(`📡 Endpoint  : http://localhost:${PORT}/bet-placed`)
    console.log(`🔍 Health    : http://localhost:${PORT}/health`)
    console.log(`📋 Contract  : ${CONFIG.verityCoreAddress}`)
    console.log(`⛓️  Chain     : ${CONFIG.chainSelectorName}`)
    console.log(`🎯 Thresholds: SAFE ≤${CONFIG.SCORE_SAFE} | MONITOR ${CONFIG.SCORE_SAFE + 1}-${CONFIG.SCORE_FLAG} | FLAG >${CONFIG.SCORE_FLAG}`)
    console.log(`🤖 Mode      : ${process.env.GROQ_API_KEY ? 'Groq AI Live (llama-3.3-70b)' : 'Simulation (no API key)'}`)
    console.log('=============================================')
    console.log('Waiting for BetPlaced events...\n')
})
