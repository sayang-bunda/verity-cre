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
 * Contract : Verity Core — 0x44BA2833fcaAee071CE852DC75caA47538dCd220 (Base Sepolia)
 */

import {
	handler,
	type EVMLog,
	Runner,
	type Runtime,
	EVMClient,
} from '@chainlink/cre-sdk'
import {
	bytesToHex,
	decodeEventLog,
} from 'viem'
import { VerityCore } from '../contracts/abi'
import { configSchema, type Config, CATEGORY_CRYPTO, OUTCOME_YES } from './src/config'
import type { ResolutionResult } from './src/types'
import { readMarketInfo, readResolutionData, resolveCryptoPrice, submitResolveMarket } from './src/evm'
import { resolveWithAI } from './src/groq'

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
		// Category 1/2/3: EVENT / SOCIAL / OTHER — AI-powered via Groq
		const label = ['CRYPTO', 'EVENT', 'SOCIAL', 'OTHER'][market.category] ?? 'OTHER'
		runtime.log(`Branch: ${label} — calling Groq AI for resolution`)
		result = resolveWithAI(runtime, market.category, market, resolution)
	}

	runtime.log(
		`Resolution result: outcome=${result.outcome} confidence=${result.confidence}% reason="${result.reason}"`,
	)

	// ── Step 4: Confidence check ─────────────────────────────────────────────
	const threshold = runtime.config.confidenceThreshold ?? 90

	if (result.confidence < threshold) {
		// Still write to chain with the low confidence value.
		// SettlementEngine._resolveMarket() checks: if confidence < CONFIDENCE_THRESHOLD (90)
		// → sets market status to Escalated, enabling claimRefund() for bettors.
		runtime.log(
			`LOW CONFIDENCE: ${result.confidence}% < ${threshold}% — writing to chain, contract will escalate`,
		)

		const txHash = submitResolveMarket(runtime, marketId, result.outcome, result.confidence)

		return JSON.stringify({
			action: 'escalated',
			marketId: marketId.toString(),
			outcome: result.outcome,
			confidence: result.confidence,
			reason: result.reason,
			threshold,
			txHash,
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
