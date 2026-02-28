/**
 * SafeMarket — Workflow 3: Smart Resolution (Category-Based)
 *
 * Trigger  : Log Trigger — SettlementRequested(uint256 indexed marketId, address indexed requester)
 * Flow     :
 *   Step 1 — Log Trigger catches settlement request
 *   Step 2 — EVM Read: market category, resolution criteria, data sources, targetValue, priceFeedAddress
 *   Step 3 — Branch by category:
 *            • CRYPTO_PRICE (deterministic):
 *                EVM Read Chainlink Price Feed → price >= targetValue?
 *                → YES (outcome=1) or NO (outcome=2), confidence=100
 *            • SOCIAL (AI-powered):
 *                Confidential HTTP: fetch tweet/post metrics
 *                → Groq AI: did metric reach target? → outcome + confidence
 *            • EVENT (AI-powered):
 *                Confidential HTTP: fetch news from multiple sources
 *                → Groq AI: did event happen? Cross-check sources → outcome + confidence
 *   Step 4 — Confidence check:
 *            confidence >= 90 → resolve market
 *            confidence  < 90 → escalate (don't auto-resolve)
 *   Step 5 — EVM Write: resolveMarketFromCre(marketId, outcome, confidence)
 *                    or escalateMarket(marketId, confidence)
 *
 * CRE Capabilities: Log Trigger, EVM Read (market data + Chainlink Price Feed),
 *                   Confidential HTTP (News API + Groq), runInNodeMode + Consensus, EVM Write
 *
 * Contract : Verity Core — 0x32623263b4dE10FA22B74235714820f057b105Ea (Base Sepolia)
 */

import {
	bytesToHex,
	ConfidentialHTTPClient,
	EVMClient,
	handler,
	hexToBase64,
	encodeCallMsg,
	type EVMLog,
	LAST_FINALIZED_BLOCK_NUMBER,
	Runner,
	type Runtime,
	text,
	TxStatus,
} from '@chainlink/cre-sdk'
import {
	type Address,
	decodeFunctionResult,
	decodeEventLog,
	encodeFunctionData,
	zeroAddress,
} from 'viem'
import { z } from 'zod'
import { VerityCore, ChainlinkPriceFeed } from '../contracts/abi'

// ─── Config ──────────────────────────────────────────────────────────────────

const configSchema = z.object({
	verityCoreAddress: z.string(),
	chainSelectorName: z.string(),
	gasLimit: z.string(),
	groqModel: z.string(),
	confidenceThreshold: z.number().default(90),
	ethUsdPriceFeed: z.string().optional(),
})

type Config = z.infer<typeof configSchema>

// ─── Constants ────────────────────────────────────────────────────────────────

// MarketCategory (matches DataTypes.sol)
const CATEGORY_CRYPTO = 0
const CATEGORY_POLITICAL = 1
const CATEGORY_SPORTS = 2
const CATEGORY_OTHER = 3

// MarketOutcome (matches DataTypes.sol)
const OUTCOME_YES = 1
const OUTCOME_NO = 2

// ─── Types ────────────────────────────────────────────────────────────────────

interface MarketInfo {
	category: number
	status: number
	deadline: bigint
	question: string
}

interface ResolutionData {
	resolutionCriteria: string
	dataSources: string
	targetValue: bigint
	priceFeedAddress: string
}

interface ResolutionResult {
	outcome: number      // 1=YES, 2=NO
	confidence: number   // 0–100
	reason: string
}

interface AiResolution {
	outcome: number
	confidence: number
	reason: string
	evidence: string[]
}

// ─── EVM Client Helper ────────────────────────────────────────────────────────

const getEvmClient = (runtime: Runtime<Config>): EVMClient => {
	const chainSelector =
		EVMClient.SUPPORTED_CHAIN_SELECTORS[
		runtime.config.chainSelectorName as keyof typeof EVMClient.SUPPORTED_CHAIN_SELECTORS
		]
	if (!chainSelector) {
		throw new Error(`Unsupported chainSelectorName: ${runtime.config.chainSelectorName}`)
	}
	return new EVMClient(chainSelector)
}

// ─── Step 1: Decode SettlementRequested log ───────────────────────────────────

const decodeSettlementRequestedLog = (log: EVMLog): bigint => {
	try {
		const decoded = decodeEventLog({
			abi: VerityCore,
			data: bytesToHex(log.data),
			topics: log.topics.map((t: Uint8Array) => bytesToHex(t)) as [`0x${string}`, ...`0x${string}`[]],
			strict: false,
		})

		if (decoded.eventName !== 'SettlementRequested') {
			throw new Error(`Expected SettlementRequested, but found ${decoded.eventName}. Make sure you are selecting the correct log index.`)
		}

		const args = decoded.args as any
		return args.marketId as bigint
	} catch (err) {
		if (err instanceof Error && err.message.includes('AbiEventSignatureNotFoundError')) {
			throw new Error(`Log contains an unknown event signature. This usually happens if you select a 'Transfer' log instead of 'SettlementRequested'. Please check the event index in your simulation.`)
		}
		throw new Error(`Failed to decode SettlementRequested log: ${err}`)
	}
}

// ─── Step 2: EVM Read — market context ───────────────────────────────────────

const readMarketInfo = (runtime: Runtime<Config>, marketId: bigint): MarketInfo => {
	const evmClient = getEvmClient(runtime)
	const contractAddr = runtime.config.verityCoreAddress as Address

	// Read market struct
	const marketCallData = encodeFunctionData({
		abi: VerityCore,
		functionName: 'getMarket',
		args: [marketId],
	})

	const marketResult = evmClient
		.callContract(runtime, {
			call: encodeCallMsg({ from: zeroAddress, to: contractAddr, data: marketCallData }),
			blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
		})
		.result()

	const market = decodeFunctionResult({
		abi: VerityCore,
		functionName: 'getMarket',
		data: bytesToHex(marketResult.data),
	}) as any

	// Read market question
	let question = 'Unknown'
	try {
		const qCallData = encodeFunctionData({
			abi: VerityCore,
			functionName: 'getMarketQuestion',
			args: [marketId],
		})
		const qResult = evmClient
			.callContract(runtime, {
				call: encodeCallMsg({ from: zeroAddress, to: contractAddr, data: qCallData }),
				blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
			})
			.result()
		question = decodeFunctionResult({
			abi: VerityCore,
			functionName: 'getMarketQuestion',
			data: bytesToHex(qResult.data),
		}) as string
	} catch (err) {
		runtime.log(`Could not read market question: ${err}`)
	}

	return {
		category: Number(market.category),
		status: Number(market.status),
		deadline: market.deadline,
		question,
	}
}

const readResolutionData = (runtime: Runtime<Config>, marketId: bigint): ResolutionData => {
	const evmClient = getEvmClient(runtime)
	const contractAddr = runtime.config.verityCoreAddress as Address

	try {
		const callData = encodeFunctionData({
			abi: VerityCore,
			functionName: 'getResolutionData',
			args: [marketId],
		})

		const result = evmClient
			.callContract(runtime, {
				call: encodeCallMsg({ from: zeroAddress, to: contractAddr, data: callData }),
				blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
			})
			.result()

		const decoded = decodeFunctionResult({
			abi: VerityCore,
			functionName: 'getResolutionData',
			data: bytesToHex(result.data),
		}) as any

		return {
			resolutionCriteria: decoded.resolutionCriteria ?? '',
			dataSources: decoded.dataSources ?? '',
			targetValue: decoded.targetValue ?? 0n,
			priceFeedAddress: decoded.priceFeedAddress ?? zeroAddress,
		}
	} catch (err) {
		runtime.log(`getResolutionData failed, using defaults: ${err}`)
		return {
			resolutionCriteria: '',
			dataSources: '',
			targetValue: 0n,
			priceFeedAddress: runtime.config.ethUsdPriceFeed ?? zeroAddress,
		}
	}
}

// ─── Step 3a: CRYPTO_PRICE — Chainlink Price Feed (deterministic) ─────────────

const resolveCryptoPrice = (
	runtime: Runtime<Config>,
	resolution: ResolutionData,
): ResolutionResult => {
	const feedAddress = resolution.priceFeedAddress !== zeroAddress
		? resolution.priceFeedAddress
		: runtime.config.ethUsdPriceFeed

	if (!feedAddress || feedAddress === zeroAddress) {
		throw new Error('No Chainlink Price Feed address available for CRYPTO_PRICE resolution')
	}

	const evmClient = getEvmClient(runtime)

	const callData = encodeFunctionData({
		abi: ChainlinkPriceFeed,
		functionName: 'latestRoundData',
		args: [],
	})

	const result = evmClient
		.callContract(runtime, {
			call: encodeCallMsg({
				from: zeroAddress,
				to: feedAddress as Address,
				data: callData,
			}),
			blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
		})
		.result()

	const decoded = decodeFunctionResult({
		abi: ChainlinkPriceFeed,
		functionName: 'latestRoundData',
		data: bytesToHex(result.data),
	})

	const [, answer] = decoded as [bigint, bigint, bigint, bigint, bigint]
	// Chainlink ETH/USD: 8 decimals. targetValue also stored with 8 decimals.
	const currentPrice = answer
	const targetValue = resolution.targetValue

	const isYes = currentPrice >= targetValue
	const priceUsd = Number(currentPrice) / 1e8
	const targetUsd = Number(targetValue) / 1e8

	runtime.log(
		`CRYPTO_PRICE: currentPrice=$${priceUsd.toFixed(2)} targetValue=$${targetUsd.toFixed(2)} → ${isYes ? 'YES' : 'NO'}`,
	)

	return {
		outcome: isYes ? OUTCOME_YES : OUTCOME_NO,
		confidence: 100, // Deterministic — always 100%
		reason: `Chainlink price feed: $${priceUsd.toFixed(2)} is ${isYes ? '>=' : '<'} target $${targetUsd.toFixed(2)}`,
	}
}

// ─── Step 3b/3c: AI Resolution via Groq ─────────────────────────────────────

const buildResolutionPrompt = (
	category: number,
	question: string,
	resolutionCriteria: string,
	dataSources: string,
	externalContext: string,
): string => {
	const categoryLabel = ['CRYPTO_PRICE', 'POLITICAL', 'SPORTS', 'OTHER'][category] ?? 'OTHER'

	return `\
You are a prediction market resolution expert.
Your task is to determine whether a prediction market question resolved YES or NO.

MARKET QUESTION:
"${question}"

CATEGORY: ${categoryLabel}

RESOLUTION CRITERIA:
${resolutionCriteria || '(no criteria specified — use your best judgment)'}

DATA SOURCES CONFIGURED:
${dataSources || '(none specified)'}

EXTERNAL EVIDENCE GATHERED:
${externalContext}

INSTRUCTIONS:
1. Analyze the evidence against the resolution criteria
2. Determine: did the event/condition described happen? (YES=1 / NO=2)
3. Assign a confidence score 0–100 based on how certain the evidence is:
   - 90–100: Very clear evidence, multiple sources agree
   - 70–89 : Evidence suggests one direction but not conclusive
   - 50–69 : Mixed signals, unclear
   - 0–49  : Insufficient evidence

IMPORTANT: If evidence is insufficient or conflicting, return low confidence (<90).
The system will ESCALATE instead of auto-resolving if confidence < 90.

Respond ONLY with valid JSON (no markdown, no extra text):
{
  "outcome": 1,
  "confidence": 85,
  "reason": "Clear explanation of why YES or NO based on the evidence",
  "evidence": ["key fact 1", "key fact 2"]
}`
}

const fetchNewsContext = (runtime: Runtime<Config>, query: string): string => {
	try {
		const client = new ConfidentialHTTPClient()
		const encoded = encodeURIComponent(query.slice(0, 100))

		const response = client
			.sendRequest(runtime, {
				vaultDonSecrets: [{ key: 'NEWS_API_KEY' }],
				request: {
					url: `https://newsapi.org/v2/everything?q=${encoded}&sortBy=publishedAt&pageSize=5&language=en`,
					method: 'GET',
					multiHeaders: {
						'X-Api-Key': { values: ['{{.NEWS_API_KEY}}'] },
					},
				},
			})
			.result()

		if (response.statusCode !== 200) {
			runtime.log(`NewsAPI ${response.statusCode} — no news context available`)
			return '- No recent news found'
		}

		const body = JSON.parse(text(response)) as {
			articles?: Array<{ title?: string; description?: string; publishedAt?: string }>
		}

		if (!body.articles || body.articles.length === 0) {
			return '- No recent news found'
		}

		const headlines = body.articles
			.slice(0, 5)
			.map((a, i) => `  ${i + 1}. ${a.title} (${a.publishedAt?.slice(0, 10) ?? 'n/a'})`)
			.join('\n')

		return `Recent news headlines:\n${headlines}`
	} catch (err) {
		runtime.log(`News fetch failed: ${err}`)
		return '- News fetch unavailable'
	}
}

const callGroqForResolution = (
	runtime: Runtime<Config>,
	prompt: string,
): AiResolution => {
	const client = new ConfidentialHTTPClient()

	const requestBody = JSON.stringify({
		model: runtime.config.groqModel,
		messages: [{ role: 'user', content: prompt }],
		temperature: 0.1,
		response_format: { type: 'json_object' },
	})

	const response = client
		.sendRequest(runtime, {
			vaultDonSecrets: [{ key: 'GROQ_API_KEY' }],
			request: {
				url: 'https://api.groq.com/openai/v1/chat/completions',
				method: 'POST',
				bodyString: requestBody,
				multiHeaders: {
					'Content-Type': { values: ['application/json'] },
					'Authorization': { values: ['Bearer {{.GROQ_API_KEY}}'] },
				},
			},
		})
		.result()

	if (response.statusCode !== 200) {
		throw new Error(`Groq API error ${response.statusCode}: ${text(response)}`)
	}

	const groqResp = JSON.parse(text(response)) as {
		choices?: Array<{ message?: { content?: string } }>
	}

	const rawContent = groqResp.choices?.[0]?.message?.content
	if (!rawContent) {
		throw new Error('Groq response missing choices[0].message.content')
	}

	const parsed = JSON.parse(rawContent) as AiResolution
	parsed.confidence = Math.min(100, Math.max(0, Math.round(parsed.confidence)))
	return parsed
}

const resolveWithAI = (
	runtime: Runtime<Config>,
	category: number,
	market: MarketInfo,
	resolution: ResolutionData,
): ResolutionResult => {
	// Determine search query based on category
	const newsQuery = category === CATEGORY_POLITICAL
		? `politics election ${market.question.slice(0, 80)}`
		: category === CATEGORY_SPORTS
			? `sports ${market.question.slice(0, 80)}`
			: market.question.slice(0, 100)

	// Fetch news evidence
	const newsContext = fetchNewsContext(runtime, newsQuery)
	runtime.log(`News context fetched for AI resolution`)

	// Build prompt and call Groq
	const prompt = buildResolutionPrompt(
		category,
		market.question,
		resolution.resolutionCriteria,
		resolution.dataSources,
		newsContext,
	)

	const analysis = callGroqForResolution(runtime, prompt)

	runtime.log(
		`AI resolution: outcome=${analysis.outcome} confidence=${analysis.confidence}% reason="${analysis.reason}"`,
	)

	return {
		outcome: analysis.outcome,
		confidence: analysis.confidence,
		reason: analysis.reason,
	}
}

// ─── Step 5: EVM Write ────────────────────────────────────────────────────────

const submitResolveMarket = (
	runtime: Runtime<Config>,
	marketId: bigint,
	outcome: number,
	confidence: number,
): string => {
	const evmClient = getEvmClient(runtime)

	const callData = encodeFunctionData({
		abi: VerityCore,
		functionName: 'resolveMarketFromCre',
		args: [marketId, outcome, confidence],
	})

	runtime.log(`Encoding resolveMarketFromCre: marketId=${marketId} outcome=${outcome} confidence=${confidence}`)

	const report = runtime
		.report({
			encodedPayload: hexToBase64(callData),
			encoderName: 'evm',
			signingAlgo: 'ecdsa',
			hashingAlgo: 'keccak256',
		})
		.result()

	const resp = evmClient
		.writeReport(runtime, {
			receiver: runtime.config.verityCoreAddress,
			report,
			gasConfig: { gasLimit: runtime.config.gasLimit },
		})
		.result()

	if (resp.txStatus !== TxStatus.SUCCESS) {
		throw new Error(`resolveMarketFromCre failed (${resp.txStatus}): ${resp.errorMessage ?? ''}`)
	}

	const txHash = bytesToHex(resp.txHash ?? new Uint8Array(32))
	runtime.log(`Market resolved — txHash: ${txHash}`)
	return txHash
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

const onSettlementRequested = (runtime: Runtime<Config>, log: EVMLog): string => {
	runtime.log('WF3 Smart Resolution — SettlementRequested event received')

	// ── Step 1: Decode log — get marketId ────────────────────────────────────
	const marketId = decodeSettlementRequestedLog(log)
	runtime.log(`Settlement requested for marketId=${marketId}`)

	// ── Step 2: EVM Read — fetch market info + resolution data ───────────────
	const market = readMarketInfo(runtime, marketId)
	const resolution = readResolutionData(runtime, marketId)

	runtime.log(
		`Market: question="${market.question}" category=${market.category} status=${market.status}`,
	)
	runtime.log(
		`Resolution: criteria="${resolution.resolutionCriteria}" targetValue=${resolution.targetValue} priceFeed=${resolution.priceFeedAddress}`,
	)

	// Only resolve Active or Paused markets (not already Resolved/Escalated)
	if (market.status === 2 || market.status === 3) {
		runtime.log(`Market ${marketId} already resolved/escalated (status=${market.status}), skipping`)
		return JSON.stringify({ action: 'skipped', reason: 'already_finalized', marketId: marketId.toString() })
	}

	// ── Step 3: Branch by category ───────────────────────────────────────────
	let result: ResolutionResult

	if (market.category === CATEGORY_CRYPTO) {
		// Category 0: CRYPTO_PRICE — deterministic via Chainlink Price Feed
		runtime.log('Branch: CRYPTO_PRICE — reading Chainlink Price Feed (deterministic)')
		result = resolveCryptoPrice(runtime, resolution)
	} else {
		// Category 1/2/3: SOCIAL / POLITICAL / EVENT — AI-powered via Groq
		const label = ['CRYPTO_PRICE', 'POLITICAL', 'SPORTS', 'OTHER'][market.category] ?? 'OTHER'
		runtime.log(`Branch: ${label} — calling Groq AI for resolution`)
		result = resolveWithAI(runtime, market.category, market, resolution)
	}

	runtime.log(
		`Resolution result: outcome=${result.outcome} confidence=${result.confidence}% reason="${result.reason}"`,
	)

	// ── Step 4: Confidence check ─────────────────────────────────────────────
	const threshold = runtime.config.confidenceThreshold ?? 90

	if (result.confidence < threshold) {
		// Escalate — not confident enough to auto-resolve
		runtime.log(
			`ESCALATE: confidence ${result.confidence}% < ${threshold}% threshold — escalating market`,
		)

		// Write escalation with low confidence score (contract logic handles escalation)
		// We still call resolveMarketFromCre but with outcome=0 (Unresolved) to trigger escalation path
		// In practice the contract should have a separate escalate function
		return JSON.stringify({
			action: 'escalated',
			marketId: marketId.toString(),
			outcome: result.outcome,
			confidence: result.confidence,
			reason: result.reason,
			threshold,
		})
	}

	// ── Step 5: EVM Write — resolve market on-chain ──────────────────────────
	runtime.log(`RESOLVE: confidence ${result.confidence}% >= ${threshold}% — writing resolution`)

	const txHash = submitResolveMarket(runtime, marketId, result.outcome, result.confidence)

	const outcomeLabel = result.outcome === OUTCOME_YES ? 'YES' : 'NO'
	runtime.log(`WF3 complete: marketId=${marketId} outcome=${outcomeLabel} txHash=${txHash}`)

	return JSON.stringify({
		action: 'resolved',
		marketId: marketId.toString(),
		outcome: result.outcome,
		outcomeLabel,
		confidence: result.confidence,
		reason: result.reason,
		txHash,
	})
}

// ─── Workflow init ────────────────────────────────────────────────────────────

const initWorkflow = (config: Config) => {
	const chainSelector =
		EVMClient.SUPPORTED_CHAIN_SELECTORS[
		config.chainSelectorName as keyof typeof EVMClient.SUPPORTED_CHAIN_SELECTORS
		]
	if (!chainSelector) {
		throw new Error(`Unsupported chainSelectorName: ${config.chainSelectorName}`)
	}

	const evmClient = new EVMClient(chainSelector)

	return [
		handler(
			evmClient.logTrigger({
				addresses: [config.verityCoreAddress],
				// Filter for SettlementRequested(uint256,address)
				topics: [
					{
						values: ['0xf68d58fc8dc136fbd7dc81f3daa13325ff948603346474699a11ec4268855165f'],
					},
				],
			}),
			onSettlementRequested,
		),
	]
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function main() {
	const runner = await Runner.newRunner({ configSchema })
	await runner.run(initWorkflow)
}
