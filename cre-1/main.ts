/**
 * SafeMarket — Workflow 1: Market Creation + AI Quality Gate
 *
 * Trigger  : HTTP Trigger (POST from frontend)
 * Steps    :
 *   1. Decode incoming JSON payload (manual question OR tweet text)
 *   2. Call Groq via Confidential HTTP (temperature=0, seed=42) to analyse,
 *      categorise, and risk-score
 *   3. Decision:
 *        riskScore  0-30  → LOW    → AUTO APPROVE  → createMarketFromCre() on-chain
 *        riskScore 31-70  → MEDIUM → BFT CONSENSUS → 21 DON nodes verify
 *                                                     ≥13 agree → on-chain
 *                                                     <13 agree → no action
 *        riskScore 71-100 → HIGH   → AUTO REJECT   → return rejection reason
 *   4. On LOW/MEDIUM: BFT signs with 21 nodes, writeReport to Verity
 *
 * Contract : Verity Core — 0xEF5Fb431494da36f0459Dc167Faf7D23ad50A869 (Base Sepolia)
 */

import { handler, HTTPCapability, type HTTPPayload, Runner, type Runtime } from '@chainlink/cre-sdk'
import { configSchema, RISK_AUTO_APPROVE, RISK_AUTO_REJECT, type Config } from './src/config'
import { callGroq } from './src/groq'
import { submitCreateMarket } from './src/market'
import { buildPrompt } from './src/prompts'
import type { WorkflowInput, WorkflowResult } from './src/types'

// ─── HTTP Trigger handler ─────────────────────────────────────────────────────

const onHTTPTrigger = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
	runtime.log('WF1 Market Creation — trigger received')

	const inputJson = new TextDecoder().decode(payload.input)
	runtime.log(`Input: ${inputJson}`)

	const input = JSON.parse(inputJson) as WorkflowInput

	if (!input.creator || !input.inputType) {
		throw new Error('Missing required fields: creator, inputType')
	}

	let content: string
	if (input.inputType === 'manual') {
		if (!input.question) throw new Error("inputType 'manual' requires field: question")
		content = input.question
	} else if (input.inputType === 'social_post') {
		if (!input.tweetText) throw new Error("inputType 'social_post' requires field: tweetText")
		content = input.tweetText
	} else {
		throw new Error(`Unknown inputType: ${(input as WorkflowInput).inputType}`)
	}

	runtime.log(`Analysing "${content}" (${input.inputType})`)

	// ── Step 1: AI analysis ──────────────────────────────────────────────────
	const prompt = buildPrompt(input.inputType, content)
	const analysis = callGroq(runtime, prompt)

	runtime.log(
		`Groq result: resolvable=${analysis.resolvable} category=${analysis.category} riskScore=${analysis.riskScore}`,
	)

	// ── Step 2: Decision logic ───────────────────────────────────────────────

	if (!analysis.resolvable) {
		const result: WorkflowResult = {
			status: 'rejected',
			riskScore: analysis.riskScore,
			reason: `Not resolvable: ${analysis.riskReason}`,
		}
		runtime.log(`Rejected (unresolvable): ${result.reason}`)
		return JSON.stringify(result)
	}

	if (analysis.riskScore > RISK_AUTO_REJECT) {
		const result: WorkflowResult = {
			status: 'rejected',
			riskScore: analysis.riskScore,
			riskReason: analysis.riskReason,
			reason: `Auto-rejected: risk score ${analysis.riskScore}/100 — ${analysis.riskReason}`,
		}
		runtime.log(`Auto-rejected: score=${analysis.riskScore}`)
		return JSON.stringify(result)
	}

	if (analysis.riskScore > RISK_AUTO_APPROVE) {
		// ── Step 3: MEDIUM risk (31-70) → BFT 21-node consensus ─────────────
		// All 21 DON nodes independently run Groq (temperature=0, seed=42)
		// and must produce identical payload. BFT requires ≥13/21 nodes to
		// agree before writeReport is submitted on-chain.
		runtime.log(
			`MEDIUM risk: score=${analysis.riskScore} — submitting for BFT 21-node consensus`,
		)

		const txHash = submitCreateMarket(runtime, input.creator, analysis)

		const result: WorkflowResult = {
			status: 'created',
			txHash,
			marketCategory: analysis.category,
			refinedQuestion: analysis.refinedQuestion,
			resolutionCriteria: analysis.resolutionCriteria,
			dataSources: analysis.dataSources,
			riskScore: analysis.riskScore,
			riskReason: analysis.riskReason,
			suggestedDeadline: analysis.suggestedDeadline,
		}
		runtime.log(`MEDIUM risk resolved via BFT — txHash: ${txHash}`)
		return JSON.stringify(result)
	}

	// ── Step 4: LOW risk (0-30) → Auto approve → create market on-chain ─────
	runtime.log(`Auto-approving: score=${analysis.riskScore}`)

	const txHash = submitCreateMarket(runtime, input.creator, analysis)

	const result: WorkflowResult = {
		status: 'created',
		txHash,
		marketCategory: analysis.category,
		refinedQuestion: analysis.refinedQuestion,
		resolutionCriteria: analysis.resolutionCriteria,
		dataSources: analysis.dataSources,
		riskScore: analysis.riskScore,
		riskReason: analysis.riskReason,
		suggestedDeadline: analysis.suggestedDeadline,
	}

	return JSON.stringify(result)
}

// ─── Workflow init ────────────────────────────────────────────────────────────

const initWorkflow = (_config: Config) => {
	const httpCapability = new HTTPCapability()

	return [
		handler(
			httpCapability.trigger({ authorizedKeys: [] }),
			onHTTPTrigger,
		),
	]
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function main() {
	const runner = await Runner.newRunner<Config>({ configSchema })
	await runner.run(initWorkflow)
}
