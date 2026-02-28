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
 *   Step 4 — AI Analysis via Confidential HTTP (Gemini):
 *            Returns: { manipulationScore, reason, patterns_matched, recommendation }
 *   Step 5 — Decision:
 *            Score  0-30  → safe, no action
 *            Score 31-80  → monitor, log warning onchain
 *            Score 81-100 → flag, market PAUSED
 *   Step 6 — EVM Write: reportManipulation(marketId, score)
 *
 * CRE Capabilities: Log Trigger, EVM Read, Confidential HTTP x2 (News + Gemini),
 *                   runInNodeMode + Consensus, EVM Write
 *
 * Contract : Verity Core — 0x32623263b4dE10FA22B74235714820f057b105Ea (Base Sepolia)
 */


import { bytesToHex, EVMClient, handler, type EVMLog, Runner, type Runtime } from '@chainlink/cre-sdk'
import { decodeEventLog } from 'viem'
import { VerityCore } from '../contracts/abi'
import { configSchema, SCORE_SAFE, SCORE_FLAG, type Config } from './src/config'
import { readMarketData, readChainlinkPrice, submitManipulationReport } from './src/evm'
import { fetchNewsContext, fetchScheduledEvents } from './src/external'
import { buildAnalysisPrompt, callGeminiAI } from './src/gemini'
import type { BetInfo } from './src/types'


// ─── Log Trigger handler ──────────────────────────────────────────────────────


const decodeBetPlacedLog = (log: EVMLog): BetInfo | null => {
	try {
		const decoded = decodeEventLog({
			abi: VerityCore,
			data: bytesToHex(log.data),
			topics: log.topics.map((t: Uint8Array) => bytesToHex(t)) as [`0x${string}`, ...`0x${string}`[]],
		})

		if (decoded.eventName !== 'BetPlaced') return null

		const args = decoded.args as any
		return {
			marketId: args.marketId,
			bettor: args.user,
			isYes: args.isYes,
			amount: args.amount,
			shares: args.shares,
			feeAmount: args.feeAmount,
		}
	} catch {
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
	runtime.log(`Bet: marketId=${bet.marketId} bettor=${bet.bettor} isYes=${bet.isYes} amount=${bet.amount}`)

	// ── Step 2: EVM Read — market context ────────────────────────────────────
	const market = readMarketData(runtime, bet.marketId)
	runtime.log(
		`Market: question="${market.question}" category=${market.category} poolYes=${market.poolYes} poolNo=${market.poolNo} volume=${market.totalVolume} bettors=${market.bettorCount} status=${market.status}`,
	)

	if (market.status !== 0) {
		runtime.log(`Market ${bet.marketId} is not active (status=${market.status}), skipping`)
		return JSON.stringify({ action: 'skipped', reason: 'market_not_active' })
	}

	// ── Step 3: Confidential HTTP — fetch external context ───────────────────
	const categoryName = ['crypto price', 'politics', 'sports', 'general'][market.category] ?? 'general'

	const newsContext = fetchNewsContext(runtime, categoryName)
	runtime.log('News context fetched')

	const priceContext = readChainlinkPrice(runtime, market.category)
	if (priceContext) runtime.log(`Chainlink price: ${priceContext}`)

	const scheduledEvents = fetchScheduledEvents(runtime, categoryName)
	runtime.log('Scheduled events fetched')

	// ── Step 4: AI Analysis via Confidential HTTP (Gemini) ───────────────────
	const prompt = buildAnalysisPrompt(bet, market, newsContext, priceContext, scheduledEvents)
	const analysis = callGeminiAI(runtime, prompt)

	runtime.log(
		`AI result: score=${analysis.manipulationScore} recommendation=${analysis.recommendation} patterns=[${analysis.patterns_matched.join(',')}]`,
	)

	// ── Step 5: Decision ─────────────────────────────────────────────────────
	if (analysis.manipulationScore <= SCORE_SAFE) {
		runtime.log(`SAFE: score=${analysis.manipulationScore} — no action taken`)
		return JSON.stringify({
			action: 'safe',
			manipulationScore: analysis.manipulationScore,
			reason: analysis.reason,
			patterns_matched: analysis.patterns_matched,
		})
	}

	const action = analysis.manipulationScore > SCORE_FLAG ? 'flag' : 'monitor'
	runtime.log(`${action.toUpperCase()}: score=${analysis.manipulationScore} — writing to chain`)

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
