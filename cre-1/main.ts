/**
 * SafeMarket — Workflow 1: Market Creation + AI Quality Gate
 *
 * Trigger  : HTTP Trigger (POST from frontend)
 * Steps    :
 *   1. Decode incoming JSON payload (manual question OR tweet text)
 *   2. Call Groq via Confidential HTTP to analyse, categorise, and risk-score
 *   3. Decision:
 *        riskScore  0-30  → AUTO APPROVE  → createMarketFromCre() on-chain
 *        riskScore 31-70  → PENDING       → return pending (admin reviews)
 *        riskScore 71-100 → AUTO REJECT   → return rejection reason
 *   4. On approval: encode calldata, sign with BFT consensus, writeReport to Verity
 *
 * Contract : Verity Core — 0x32623263b4dE10FA22B74235714820f057b105Ea (Base Sepolia)
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
		const result: WorkflowResult = {
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
		return JSON.stringify(result)
	}

	// ── Step 3: Auto approve (0-30) → create market on-chain ────────────────
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
