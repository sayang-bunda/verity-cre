/**
 * CRE-1 LOCAL SIMULATOR (updated to mirror latest git pull)
 * ==========================================================
 * Mirrors EXACTLY:
 *   - cre-1/src/prompts.ts  (categories: CRYPTO_PRICE, POLITICAL, SPORTS, OTHER)
 *   - cre-1/src/groq.ts     (ConfidentialHTTPClient → direct HTTPS here)
 *   - cre-1/src/market.ts   (ACTION_CREATE_MARKET=1, all new ABI fields)
 *   - cre-1/src/config.ts   (RISK_AUTO_APPROVE=30, RISK_AUTO_REJECT=70)
 *   - cre-1/main.ts         (decision logic flow)
 *
 * Run: node cre-simulator.js
 * POST http://localhost:3001/trigger
 */

import http from 'http'
import https from 'https'

// ─── Config (mirrors cre-1/config.staging.json + config.ts) ──────────────────

const CONFIG = {
    verityCoreAddress: '0x32623263b4dE10FA22B74235714820f057b105Ea',
    chainSelectorName: 'ethereum-testnet-sepolia-base-1',
    gasLimit: '2000000',
    defaultFeeBps: 200,
    groqModel: 'llama-3.3-70b-versatile',
    RISK_AUTO_APPROVE: 30,
    RISK_AUTO_REJECT: 70,
}

// mirrors cre-1/src/config.ts CATEGORY_MAP exactly
const CATEGORY_MAP = {
    CRYPTO_PRICE: 0,
    POLITICAL: 1,
    SPORTS: 2,
    OTHER: 3,
    // Legacy aliases
    SOCIAL: 3,
    EVENT: 3,
}

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
            temperature: 0.1,
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

    // Detect category — matches updated prompts.ts (no SOCIAL/EVENT, use OTHER)
    let category = 'OTHER'
    let riskScore = Math.floor(Math.random() * 20) + 5  // 5-25 default AUTO APPROVE

    if (lower.includes('bitcoin') || lower.includes('eth') || lower.includes('btc') ||
        lower.includes('crypto') || lower.includes('price') || lower.includes('$') ||
        lower.includes('solana') || lower.includes('sol') || lower.includes('chainlink') ||
        lower.includes('link')) {
        category = 'CRYPTO_PRICE'
        riskScore = Math.floor(Math.random() * 15) + 5  // 5-20, LOW risk
    } else if (lower.includes('elect') || lower.includes('vote') || lower.includes('president') ||
        lower.includes('politi') || lower.includes('candidate') || lower.includes('congress')) {
        category = 'POLITICAL'
        riskScore = Math.floor(Math.random() * 25) + 35  // 35-60 PENDING
    } else if (lower.includes('championship') || lower.includes('league') || lower.includes('world cup') ||
        lower.includes('nba') || lower.includes('nfl') || lower.includes('premier') ||
        (lower.includes('win') && (lower.includes('team') || lower.includes('match')))) {
        category = 'SPORTS'
        riskScore = Math.floor(Math.random() * 20) + 10  // 10-30 AUTO APPROVE
    }

    // High-risk keywords → AUTO REJECT
    if (lower.includes('hack') || lower.includes('rug') || lower.includes('scam') ||
        lower.includes('kill') || lower.includes('die') || lower.includes('crash')) {
        riskScore = Math.floor(Math.random() * 20) + 80  // 80-100
    }

    // Very vague → PENDING
    if (prompt.length < 30) {
        riskScore = Math.floor(Math.random() * 20) + 50  // 50-70
    }

    // Templates by category
    const templates = {
        CRYPTO_PRICE: {
            refinedQuestion: 'Will the specified cryptocurrency asset reach the target price before the deadline?',
            resolutionCriteria: 'Resolves YES if the spot price on Chainlink Price Feed exceeds the target at any point before deadline. Resolves NO otherwise.',
            dataSources: ['chainlink.com/price-feeds', 'coinmarketcap.com', 'coingecko.com'],
            riskReason: 'Crypto price markets are verifiable via Chainlink Price Feeds on-chain.',
            targetValue: 100000,           // example: $100k
            priceFeedAddress: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb',  // BTC/USD Base Sepolia
        },
        POLITICAL: {
            refinedQuestion: 'Will the specified political outcome occur before the deadline?',
            resolutionCriteria: 'Resolves YES based on official government or electoral body announcements confirmed by 3+ major news sources.',
            dataSources: ['reuters.com', 'apnews.com', 'bbc.com'],
            riskReason: 'Political markets require careful multi-source verification.',
            targetValue: null,
            priceFeedAddress: null,
        },
        SPORTS: {
            refinedQuestion: 'Will the specified sports outcome occur before the deadline?',
            resolutionCriteria: 'Resolves YES if the specified team or player achieves the stated outcome per official league results.',
            dataSources: ['espn.com', 'bbc.com/sport', 'officialleague.com'],
            riskReason: 'Sports outcomes are verifiable via official league results.',
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

// ─── Simulate on-chain write (mirrors updated cre-1/src/market.ts exactly) ───
// New: ACTION_CREATE_MARKET=1, encodes resolutionCriteria, dataSources,
//      targetValue, priceFeedAddress — matches onReport decoder in CREAdapter

function simulateOnChainWrite(runtime, creator, analysis) {
    const ACTION_CREATE_MARKET = 1
    const category = CATEGORY_MAP[analysis.category] ?? 3
    const deadlineTs = Math.floor(new Date(analysis.suggestedDeadline).getTime() / 1000)
    const targetValue = analysis.targetValue != null
        ? Math.round(analysis.targetValue * 1e8)  // USD → int256 with 8 decimals (Chainlink format)
        : 0
    const priceFeedAddress = analysis.category === 'CRYPTO_PRICE' && analysis.priceFeedAddress
        ? analysis.priceFeedAddress
        : '0x0000000000000000000000000000000000000000'

    runtime.log('Encoding ABI payload (mirrors market.ts encodeAbiParameters)...')
    runtime.log(`  action         : ${ACTION_CREATE_MARKET} (ACTION_CREATE_MARKET)`)
    runtime.log(`  creator        : ${creator}`)
    runtime.log(`  deadline       : ${deadlineTs} (${analysis.suggestedDeadline})`)
    runtime.log(`  feeBps         : ${CONFIG.defaultFeeBps}`)
    runtime.log(`  category       : ${category} (${analysis.category})`)
    runtime.log(`  question       : "${analysis.refinedQuestion}"`)
    runtime.log(`  resolutionCriteria: "${analysis.resolutionCriteria?.slice(0, 60)}..."`)
    runtime.log(`  dataSources    : ${JSON.stringify(analysis.dataSources)}`)
    runtime.log(`  targetValue    : ${targetValue} (int256, 8 decimals)`)
    runtime.log(`  priceFeedAddr  : ${priceFeedAddress}`)

    // Mirrors: runtime.report({ encodedPayload: hexToBase64(payload), ... })
    const payloadObj = {
        action: ACTION_CREATE_MARKET,
        creator,
        deadline: deadlineTs,
        feeBps: CONFIG.defaultFeeBps,
        category,
        question: analysis.refinedQuestion,
        resolutionCriteria: analysis.resolutionCriteria,
        dataSources: JSON.stringify(analysis.dataSources),
        targetValue,
        priceFeedAddress,
    }
    const encodedPayload = Buffer.from(JSON.stringify(payloadObj)).toString('base64')
    runtime.log(`Payload base64 (first 60): ${encodedPayload.slice(0, 60)}...`)

    // Mirrors: evmClient.writeReport → receiver=verityCoreAddress
    runtime.log('Simulating BFT consensus (12 DON nodes signing)...')
    runtime.log(`Submitting writeReport → receiver: ${CONFIG.verityCoreAddress}`)

    const txHash = '0x' + Array.from(
        { length: 64 },
        () => Math.floor(Math.random() * 16).toString(16)
    ).join('')

    runtime.log(`[SIM] writeReport submitted: txHash=${txHash}`)
    runtime.log(`[SIM] TxStatus.SUCCESS (simulated — not real on-chain)`)
    runtime.log(`Market created — txHash: ${txHash}`)

    return txHash
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

    // Step 1: AI
    const prompt = buildPrompt(input.inputType, content)
    const analysis = await callGroq(runtime, prompt)

    runtime.log(
        `Groq result: resolvable=${analysis.resolvable} category=${analysis.category} riskScore=${analysis.riskScore}`
    )

    // Step 2: Decision logic (mirrors main.ts exactly)
    if (!analysis.resolvable) {
        const result = { status: 'rejected', riskScore: analysis.riskScore, reason: `Not resolvable: ${analysis.riskReason}` }
        runtime.log(`Rejected (unresolvable): ${result.reason}`)
        return result
    }

    if (analysis.riskScore > CONFIG.RISK_AUTO_REJECT) {
        const result = { status: 'rejected', riskScore: analysis.riskScore, riskReason: analysis.riskReason, reason: `Auto-rejected: risk score ${analysis.riskScore}/100 — ${analysis.riskReason}` }
        runtime.log(`Auto-rejected: score=${analysis.riskScore}`)
        return result
    }

    if (analysis.riskScore > CONFIG.RISK_AUTO_APPROVE) {
        const result = {
            status: 'pending',
            marketCategory: analysis.category,
            refinedQuestion: analysis.refinedQuestion,
            resolutionCriteria: analysis.resolutionCriteria,
            dataSources: analysis.dataSources,
            riskScore: analysis.riskScore,
            riskReason: analysis.riskReason,
            suggestedDeadline: analysis.suggestedDeadline,
        }
        runtime.log(`Pending review: score=${analysis.riskScore}`)
        return result
    }

    // Step 3: Auto approve → simulate on-chain write
    runtime.log(`Auto-approving: score=${analysis.riskScore}`)
    const txHash = simulateOnChainWrite(runtime, input.creator, analysis)

    return {
        status: 'created',
        txHash,
        marketCategory: analysis.category,
        refinedQuestion: analysis.refinedQuestion,
        resolutionCriteria: analysis.resolutionCriteria,
        dataSources: analysis.dataSources,
        riskScore: analysis.riskScore,
        riskReason: analysis.riskReason,
        suggestedDeadline: analysis.suggestedDeadline,
        simulatedCalldata: {
            action: 'ACTION_CREATE_MARKET',
            contract: CONFIG.verityCoreAddress,
            chain: CONFIG.chainSelectorName,
            targetValue: analysis.targetValue,
            priceFeedAddress: analysis.priceFeedAddress,
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
            status: 'ok',
            service: 'CRE-1 Local Simulator',
            workflow: 'safemarket-creation-staging',
            contract: CONFIG.verityCoreAddress,
            chain: CONFIG.chainSelectorName,
            mode: process.env.GROQ_API_KEY ? 'groq_live' : 'simulation',
            version: 'post-gitpull-2026-02-28',
        }))
        return
    }

    // POST /trigger  — mirrors CRE-1 HTTP trigger
    if (req.method === 'POST' && req.url === '/trigger') {
        const requestId = `cre1-sim-${Date.now()}`
        const runtime = createRuntime(requestId)
        runtime.log(`=== CRE-1 SIMULATOR — Request ${requestId} ===`)

        let body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', async () => {
            try {
                const input = JSON.parse(body)
                const result = await onHTTPTrigger(input, runtime)

                const response = {
                    ...result,
                    source: process.env.GROQ_API_KEY ? 'groq_live' : 'simulation',
                    _simulator: {
                        requestId,
                        workflow: 'safemarket-creation-staging',
                        nodeCount: 12,
                        consensusType: 'BFT',
                        donId: 'DON-SIMULATED',
                        logs: runtime.getLogs(),
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

    // GET /  — simple debug UI
    if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`
      <html>
      <head><title>CRE-1 Simulator</title>
      <style>body{background:#000;color:#0f0;font-family:monospace;padding:2rem;max-width:800px}</style>
      </head>
      <body>
        <h1>🔗 CRE-1 Local Simulator</h1>
        <p>Workflow: <b>safemarket-creation-staging</b></p>
        <p>Contract: <code>${CONFIG.verityCoreAddress}</code></p>
        <p>Chain: <code>${CONFIG.chainSelectorName}</code></p>
        <p>Mode: <b>${process.env.GROQ_API_KEY ? '🤖 Groq AI Live (llama-3.3-70b)' : '🔬 Simulation (no API key)'}</b></p>
        <p>Categories: <b>CRYPTO_PRICE | POLITICAL | SPORTS | OTHER</b></p>
        <p>ABI fields: <b>action, creator, deadline, feeBps, category, question, resolutionCriteria, dataSources, targetValue, priceFeedAddress</b></p>
        <hr/>
        <h2>Endpoints</h2>
        <ul>
          <li><code>POST /trigger</code> — CRE-1 HTTP Trigger</li>
          <li><code>GET /health</code> — Health check</li>
        </ul>
        <h2>Example</h2>
        <pre>curl -X POST http://localhost:${PORT}/trigger \\
  -H "Content-Type: application/json" \\
  -d '{"inputType":"manual","question":"Will BTC exceed $150k before Q3 2026?","creator":"0xYourAddress"}'</pre>
      </body>
      </html>
    `)
        return
    }

    res.writeHead(404)
    res.end('Not found')
})

server.listen(PORT, () => {
    console.log('\n🔗 CRE-1 LOCAL SIMULATOR (updated — post git pull)')
    console.log('====================================================')
    console.log(`📡 Endpoint  : http://localhost:${PORT}/trigger`)
    console.log(`🔍 Health    : http://localhost:${PORT}/health`)
    console.log(`📋 Contract  : ${CONFIG.verityCoreAddress}`)
    console.log(`⛓️  Chain     : ${CONFIG.chainSelectorName}`)
    console.log(`📁 Categories: CRYPTO_PRICE | POLITICAL | SPORTS | OTHER`)
    console.log(`🤖 Mode      : ${process.env.GROQ_API_KEY ? 'Groq AI Live (llama-3.3-70b)' : 'Simulation (no API key)'}`)
    console.log('====================================================')
    console.log('Waiting for requests...\n')
})
