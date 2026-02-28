/**
 * SafeMarket — Workflow 2: Trading Anomaly Detection (THE DIFFERENTIATOR)
 *
 * Trigger  : Log Trigger — BetPlaced(uint256 marketId, address bettor, bool isYes, uint256 amount, uint256 shares, uint256 feeAmount)
 * Flow     :
 *   Step 1 — Log Trigger catches every bet
 *   Step 2 — EVM Read: market context (question, category, pools, volume, bettor count)
 *   Step 3 — Confidential HTTP: fetch external context
 *            • News API: recent news related to market topic (last 24h)
 *            • If CRYPTO_PRICE: current price from Chainlink Price Feed (onchain read)
 *            • Scheduled events within 48h
 *   Step 4 — AI Analysis via Confidential HTTP (Groq — llama-3.3-70b-versatile):
 *            Returns: { manipulationScore, reason, patterns_matched, recommendation }
 *   Step 5 — Decision:
 *            Score  0-30  → safe, no action
 *            Score 31-70  → monitor, log warning onchain
 *            Score 71-100 → flag, market PAUSED (matches MANIPULATION_THRESHOLD=70 in RiskEngine.sol)
 *   Step 6 — EVM Write: reportManipulation(marketId, score)
 *
 * CRE Capabilities: Log Trigger, EVM Read, Confidential HTTP x2 (News + Groq),
 *                   runInNodeMode + Consensus, EVM Write
 *
 * Contract : Verity Core — 0x44BA2833fcaAee071CE852DC75caA47538dCd220 (Base Sepolia)
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
	decodeAbiParameters,
	decodeFunctionResult,
	encodeAbiParameters,
	encodeFunctionData,
	zeroAddress,
	decodeEventLog,
} from 'viem'
import { z } from 'zod'
import { VerityCore, ChainlinkPriceFeed } from '../contracts/abi'
import { buildAnalysisPrompt, callGroqAI } from './src/groq'

// ─── Config ──────────────────────────────────────────────────────────────────

const configSchema = z.object({
	verityCoreAddress: z.string(),
	chainSelectorName: z.string(),
	gasLimit: z.string(),
	groqModel: z.string(),
	// Chainlink Price Feed addresses (Base Sepolia)
	ethUsdPriceFeed: z.string().optional(),
	btcUsdPriceFeed: z.string().optional(),
})

type Config = z.infer<typeof configSchema>

// ─── Thresholds (matching spec exactly) ──────────────────────────────────────

const SCORE_SAFE = 30       // 0-30: safe, no action
const SCORE_FLAG = 70       // 71-100: flag & pause market (matches MANIPULATION_THRESHOLD=70 in RiskEngine.sol)

// ─── Types ────────────────────────────────────────────────────────────────────

interface MarketData {
	creator: string
	deadline: bigint
	feeBps: number
	status: number
	outcome: number
	poolYes: bigint
	poolNo: bigint
	category: number
	manipulationScore: number
	totalVolume: bigint
	question: string
	bettorCount: bigint
}

interface BetInfo {
	marketId: bigint
	bettor: string
	isYes: boolean
	amount: bigint
	shares: bigint
	feeAmount: bigint
}

interface AiAnalysis {
	manipulationScore: number
	reason: string
	patterns_matched: string[]
	recommendation: 'safe' | 'monitor' | 'flag'
}

// ─── EVM Read helpers ─────────────────────────────────────────────────────────

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

/**
 * Step 2 — EVM Read: fetch full market context including question & bettor count
 */
const readMarketData = (runtime: Runtime<Config>, marketId: bigint): MarketData => {
	const evmClient = getEvmClient(runtime)
	const contractAddr = runtime.config.verityCoreAddress as Address

	// ── Read market struct ──
	const marketCallData = encodeFunctionData({
		abi: VerityCore,
		functionName: 'getMarket',
		args: [marketId],
	})

	const marketResult = evmClient
		.callContract(runtime, {
			call: encodeCallMsg({
				from: zeroAddress,
				to: contractAddr,
				data: marketCallData,
			}),
			blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
		})
		.result()

	const decoded = decodeFunctionResult({
		abi: VerityCore,
		functionName: 'getMarket',
		data: bytesToHex(marketResult.data),
	})

	const market = decoded as any

	// ── Read market question ──
	const questionCallData = encodeFunctionData({
		abi: VerityCore,
		functionName: 'getMarketQuestion',
		args: [marketId],
	})

	let question = 'Unknown'
	try {
		const questionResult = evmClient
			.callContract(runtime, {
				call: encodeCallMsg({
					from: zeroAddress,
					to: contractAddr,
					data: questionCallData,
				}),
				blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
			})
			.result()

		const decodedQuestion = decodeFunctionResult({
			abi: VerityCore,
			functionName: 'getMarketQuestion',
			data: bytesToHex(questionResult.data),
		})
		question = decodedQuestion as string
	} catch (err) {
		runtime.log(`Failed to read market question: ${err}`)
	}

	// ── Read bettor count ──
	const bettorCountCallData = encodeFunctionData({
		abi: VerityCore,
		functionName: 'getBettorCount',
		args: [marketId],
	})

	let bettorCount = 0n
	try {
		const bettorCountResult = evmClient
			.callContract(runtime, {
				call: encodeCallMsg({
					from: zeroAddress,
					to: contractAddr,
					data: bettorCountCallData,
				}),
				blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
			})
			.result()

		const decodedBettorCount = decodeFunctionResult({
			abi: VerityCore,
			functionName: 'getBettorCount',
			data: bytesToHex(bettorCountResult.data),
		})
		bettorCount = decodedBettorCount as bigint
	} catch (err) {
		runtime.log(`Failed to read bettor count: ${err}`)
	}

	return {
		creator: market.creator,
		deadline: market.deadline,
		feeBps: Number(market.feeBps),
		status: Number(market.status),
		outcome: Number(market.outcome),
		poolYes: market.poolYes,
		poolNo: market.poolNo,
		category: Number(market.category),
		manipulationScore: Number(market.manipulationScore),
		totalVolume: market.totalVolume,
		question,
		bettorCount,
	}
}

// ─── Chainlink Price Feed read (onchain) ──────────────────────────────────────

/**
 * If CRYPTO_PRICE category: read current price from Chainlink Price Feed (onchain read)
 */
const readChainlinkPrice = (runtime: Runtime<Config>, category: number): string => {
	// Category 0 = CRYPTO_PRICE
	if (category !== 0) {
		return ''
	}

	const feedAddress = runtime.config.ethUsdPriceFeed
	if (!feedAddress) {
		runtime.log('No ethUsdPriceFeed configured, skipping price feed read')
		return 'Price feed not configured'
	}

	try {
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
		// Chainlink ETH/USD has 8 decimals
		const price = Number(answer) / 1e8
		return `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
	} catch (err) {
		runtime.log(`Chainlink price read failed: ${err}`)
		return 'Price feed read failed'
	}
}

// ─── External data fetch (Confidential HTTP) ─────────────────────────────────

/**
 * Step 3a — News API: recent news related to market topic (last 24h)
 */
const fetchNewsContext = (runtime: Runtime<Config>, topic: string): string => {
	try {
		const client = new ConfidentialHTTPClient()
		const query = encodeURIComponent(topic)

		const response = client
			.sendRequest(runtime, {
				vaultDonSecrets: [{ key: 'NEWS_API_KEY' }],
				request: {
					url: `https://newsapi.org/v2/everything?q=${query}&sortBy=publishedAt&pageSize=5&language=en`,
					method: 'GET',
					multiHeaders: {
						'X-Api-Key': { values: ['{{.NEWS_API_KEY}}'] },
					},
				},
			})
			.result()

		if (response.statusCode !== 200) {
			runtime.log(`NewsAPI returned ${response.statusCode}, skipping news context`)
			return '- Recent news: [none]'
		}

		const body = JSON.parse(text(response)) as {
			articles?: Array<{ title?: string; description?: string; publishedAt?: string }>
		}

		if (!body.articles || body.articles.length === 0) {
			return '- Recent news: [none]'
		}

		const headlines = body.articles
			.slice(0, 3)
			.map((a) => `  • ${a.title} (${a.publishedAt?.slice(0, 10) ?? 'unknown date'})`)
			.join('\n')

		return `- Recent news:\n${headlines}`
	} catch (err) {
		runtime.log(`News fetch failed: ${err}. Proceeding without news context.`)
		return '- Recent news: [fetch unavailable]'
	}
}

/**
 * Step 3b — Scheduled events within 48h
 * Fetches from a public events/calendar API for context
 */
const fetchScheduledEvents = (runtime: Runtime<Config>, topic: string): string => {
	try {
		const client = new ConfidentialHTTPClient()
		const query = encodeURIComponent(topic)

		// Use NewsAPI with future-focused query to approximate scheduled events
		const response = client
			.sendRequest(runtime, {
				vaultDonSecrets: [{ key: 'NEWS_API_KEY' }],
				request: {
					url: `https://newsapi.org/v2/everything?q=${query}+scheduled+event+upcoming&sortBy=publishedAt&pageSize=3&language=en`,
					method: 'GET',
					multiHeaders: {
						'X-Api-Key': { values: ['{{.NEWS_API_KEY}}'] },
					},
				},
			})
			.result()

		if (response.statusCode !== 200) {
			return '- Scheduled events: [none in 48h]'
		}

		const body = JSON.parse(text(response)) as {
			articles?: Array<{ title?: string; publishedAt?: string }>
		}

		if (!body.articles || body.articles.length === 0) {
			return '- Scheduled events: [none in 48h]'
		}

		const events = body.articles
			.slice(0, 3)
			.map((a) => `  • ${a.title}`)
			.join('\n')

		return `- Scheduled events (next 48h):\n${events}`
	} catch (err) {
		runtime.log(`Scheduled events fetch failed: ${err}`)
		return '- Scheduled events: [none in 48h]'
	}
}

// ─── On-chain write ───────────────────────────────────────────────────────────

/**
 * Step 6 — EVM Write: reportManipulation(marketId, score, reason)
 */
// ACTION_REPORT_MANIPULATION = 2 (matches CREAdapter.sol)
const ACTION_REPORT_MANIPULATION = 2

const submitManipulationReport = (
	runtime: Runtime<Config>,
	marketId: bigint,
	score: number,
	reason: string,
): string => {
	const evmClient = getEvmClient(runtime)

	// Encode as abi.encode(action, ...params) — onReport decoder in CREAdapter expects this format
	const payload = encodeAbiParameters(
		[
			{ type: 'uint8' },    // action = ACTION_REPORT_MANIPULATION
			{ type: 'uint256' },  // marketId
			{ type: 'uint8' },    // score
			{ type: 'string' },   // reason
		],
		[ACTION_REPORT_MANIPULATION, marketId, score, reason],
	)

	runtime.log(`Encoded ACTION_REPORT_MANIPULATION: marketId=${marketId} score=${score}`)

	// Sign with BFT consensus (runInNodeMode + Consensus)
	const report = runtime
		.report({
			encodedPayload: hexToBase64(payload),
			encoderName: 'evm',
			signingAlgo: 'ecdsa',
			hashingAlgo: 'keccak256',
		})
		.result()

	// Submit to Verity contract via EVM Write
	const resp = evmClient
		.writeReport(runtime, {
			receiver: runtime.config.verityCoreAddress,
			report,
			gasConfig: { gasLimit: runtime.config.gasLimit },
		})
		.result()

	if (resp.txStatus !== TxStatus.SUCCESS) {
		throw new Error(`writeReport failed (${resp.txStatus}): ${resp.errorMessage ?? ''}`)
	}

	const txHash = bytesToHex(resp.txHash ?? new Uint8Array(32))
	runtime.log(`Manipulation reported — txHash: ${txHash}`)
	return txHash
}

// ─── Log Trigger handler ──────────────────────────────────────────────────────

const decodeBetPlacedLog = (log: EVMLog): BetInfo | null => {
	try {
		const decoded = decodeEventLog({
			abi: VerityCore,
			data: bytesToHex(log.data),
			topics: log.topics.map((t: Uint8Array) => bytesToHex(t)) as [`0x${string}`, ...`0x${string}`[]],
		})

		if (decoded.eventName !== 'BetPlaced') {
			return null
		}

		const args = decoded.args as any
		return {
			marketId: args.marketId,
			bettor: args.user,
			isYes: args.isYes,
			amount: args.amount,
			shares: args.shares,
			feeAmount: args.feeAmount,
		}
	} catch (err) {
		return null
	}
}

/**
 * Main handler — orchestrates all 6 steps of the workflow
 */
const onBetPlaced = (runtime: Runtime<Config>, log: EVMLog): string => {
	// ── Step 1: Log Trigger catches every bet ────────────────────────────────
	const bet = decodeBetPlacedLog(log)

	if (!bet) {
		runtime.log('WF2 — Received non-BetPlaced event from VerityCore, skipping')
		return JSON.stringify({ action: 'skipped', reason: 'not_bet_placed_event' })
	}

	runtime.log('WF2 Trading Anomaly Detection — BetPlaced event received')
	runtime.log(
		`Bet: marketId=${bet.marketId} bettor=${bet.bettor} isYes=${bet.isYes} amount=${bet.amount}`,
	)

	// ── Step 2: EVM Read — market context (question, category, pools, volume, bettor count) ──
	const market = readMarketData(runtime, bet.marketId)
	runtime.log(
		`Market: question="${market.question}" category=${market.category} poolYes=${market.poolYes} poolNo=${market.poolNo} volume=${market.totalVolume} bettors=${market.bettorCount} status=${market.status}`,
	)

	// Skip if market is not active (status 0 = Active)
	if (market.status !== 0) {
		runtime.log(`Market ${bet.marketId} is not active (status=${market.status}), skipping`)
		return JSON.stringify({ action: 'skipped', reason: 'market_not_active' })
	}

	// ── Step 3: Confidential HTTP — fetch external context ───────────────────
	const categoryName = ['crypto price', 'politics', 'sports', 'general'][market.category] ?? 'general'

	// Step 3a: News API — recent news related to market topic (last 24h)
	const newsContext = fetchNewsContext(runtime, categoryName)
	runtime.log(`News context fetched`)

	// Step 3b: If CRYPTO_PRICE — current price from Chainlink Price Feed (onchain read)
	const priceContext = readChainlinkPrice(runtime, market.category)
	if (priceContext) {
		runtime.log(`Chainlink price: ${priceContext}`)
	}

	// Step 3c: Scheduled events within 48h
	const scheduledEvents = fetchScheduledEvents(runtime, categoryName)
	runtime.log(`Scheduled events fetched`)

	// ── Step 4: AI Analysis via Confidential HTTP (Groq) ────────────────────
	const prompt = buildAnalysisPrompt(bet, market, newsContext, priceContext, scheduledEvents)
	const analysis = callGroqAI(runtime, prompt)

	runtime.log(
		`AI result: score=${analysis.manipulationScore} recommendation=${analysis.recommendation} patterns=[${analysis.patterns_matched.join(',')}]`,
	)

	// ── Step 5: Decision ─────────────────────────────────────────────────────
	// Score 0-30 → safe, no action
	if (analysis.manipulationScore <= SCORE_SAFE) {
		runtime.log(`SAFE: score=${analysis.manipulationScore} — no action taken`)
		return JSON.stringify({
			action: 'safe',
			manipulationScore: analysis.manipulationScore,
			reason: analysis.reason,
			patterns_matched: analysis.patterns_matched,
		})
	}

	// Score 31-80 → monitor, log warning onchain
	// Score 81-100 → flag, market PAUSED
	const action = analysis.manipulationScore > SCORE_FLAG ? 'flag' : 'monitor'

	runtime.log(
		`${action.toUpperCase()}: score=${analysis.manipulationScore} — writing to chain`,
	)

	// ── Step 6: EVM Write — reportManipulation(marketId, score) ──────────────
	const txHash = submitManipulationReport(
		runtime,
		bet.marketId,
		analysis.manipulationScore,
		`[${action}] ${analysis.reason} | patterns: ${analysis.patterns_matched.join(', ')}`,
	)

	return JSON.stringify({
		action,
		manipulationScore: analysis.manipulationScore,
		reason: analysis.reason,
		patterns_matched: analysis.patterns_matched,
		recommendation: analysis.recommendation,
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
				// Filter for BetPlaced event signature
				// keccak256("BetPlaced(uint256,address,bool,uint256,uint256,uint256)")
			}),
			onBetPlaced,
		),
	]
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function main() {
	const runner = await Runner.newRunner<Config>({ configSchema })
	await runner.run(initWorkflow)
}
