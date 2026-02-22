/**
 * SafeMarket — Workflow 1: Market Creation + AI Quality Gate
 *
 * Trigger  : HTTP Trigger (POST from frontend)
 * Steps    :
 *   1. Decode incoming JSON payload (manual question OR tweet text)
 *   2. Call Gemini via Confidential HTTP to analyse, categorise, and risk-score
 *   3. Decision:
 *        riskScore  0-30  → AUTO APPROVE  → createMarketFromCre() on-chain
 *        riskScore 31-70  → PENDING       → return pending (admin reviews)
 *        riskScore 71-100 → AUTO REJECT   → return rejection reason
 *   4. On approval: encode calldata, sign with BFT consensus, writeReport to Verity
 *
 * Contract : Verity Core — 0x32623263b4dE10FA22B74235714820f057b105Ea (Base Sepolia)
 *
 * NOTE: Verity contract must implement IReceiver.onReport() to accept writeReport calls.
 * The onReport handler should decode the payload and route to _createMarket() internally.
 */

import {
	bytesToHex,
	ConfidentialHTTPClient,
	EVMClient,
	handler,
	hexToBase64,
	HTTPCapability,
	type HTTPPayload,
	Runner,
	type Runtime,
	text,
	TxStatus,
} from '@chainlink/cre-sdk'
import { type Address, encodeFunctionData } from 'viem'
import { z } from 'zod'
import { VerityCore } from '../contracts/abi'

// ─── Config ──────────────────────────────────────────────────────────────────

const configSchema = z.object({
	verityCoreAddress: z.string(),
	chainSelectorName: z.string(),
	gasLimit: z.string(),
	defaultFeeBps: z.number(),
	geminiModel: z.string(),
})

type Config = z.infer<typeof configSchema>

// ─── Contract constants (DataTypes.sol) ──────────────────────────────────────

/**
 * MarketCategory enum mapping: Gemini output → contract uint8
 *   CryptoPrice = 0, Political = 1, Sports = 2, Other = 3
 */
const CATEGORY_MAP: Record<string, number> = {
	CRYPTO_PRICE: 0,
	SOCIAL: 3,
	EVENT: 3,
}

const RISK_AUTO_APPROVE = 30
const RISK_AUTO_REJECT = 70

// ─── Types ────────────────────────────────────────────────────────────────────

interface WorkflowInput {
	inputType: 'manual' | 'social_post'
	question?: string
	tweetText?: string
	creator: string
}

interface GeminiAnalysis {
	resolvable: boolean
	category: string
	refinedQuestion: string
	resolutionCriteria: string
	dataSources: string[]
	riskScore: number
	riskReason: string
	suggestedDeadline: string
	targetValue: number | null
	priceFeedAddress: string | null
}

interface WorkflowResult {
	status: 'created' | 'pending' | 'rejected'
	txHash?: string
	marketCategory?: string
	refinedQuestion?: string
	resolutionCriteria?: string
	dataSources?: string[]
	riskScore?: number
	riskReason?: string
	suggestedDeadline?: string
	reason?: string
}

// ─── Gemini helpers ───────────────────────────────────────────────────────────

const buildPrompt = (inputType: string, content: string): string => `\
You are a prediction market generator and risk assessor.

INPUT TYPE: ${inputType}
CONTENT: "${content}"

Your job:
1. Extract the verifiable claim from the content
2. Categorize: CRYPTO_PRICE, SOCIAL, or EVENT
3. Generate precise, unambiguous resolution criteria
4. Identify data sources for verification
5. Assess risk score (0-100) for auto-approval

Risk scoring criteria:
- 0-30  (AUTO APPROVE): Clear, verifiable, well-known topic, reputable source
- 31-70 (PENDING REVIEW): Ambiguous source, niche topic, potential controversy
- 71-100 (AUTO REJECT): Unverifiable, subjective, spam, or harmful

Category guidance:
- CRYPTO_PRICE: "Will ETH hit $3,000?" — resolve via Chainlink Price Feed
- SOCIAL: "Will @elonmusk tweet 50 times this week?" — resolve via social metrics
- EVENT: "Will Starship launch successfully?" — resolve via news sources

Respond ONLY with valid JSON (no markdown, no extra text):
{
  "resolvable": true,
  "category": "EVENT",
  "refinedQuestion": "Will SpaceX Starship Flight 7 launch successfully before 2026-03-01?",
  "resolutionCriteria": "Resolves YES if SpaceX Starship Flight 7 completes a successful launch and landing before the deadline, per official SpaceX communications or 3+ major news outlets.",
  "dataSources": ["spacex.com", "nasa.gov", "reuters.com"],
  "riskScore": 15,
  "riskReason": "Well-known public event, verifiable via official sources",
  "suggestedDeadline": "2026-03-01T23:59:59Z",
  "targetValue": null,
  "priceFeedAddress": null
}`

const callGemini = (runtime: Runtime<Config>, prompt: string): GeminiAnalysis => {
	const client = new ConfidentialHTTPClient()

	const requestBody = JSON.stringify({
		contents: [{ parts: [{ text: prompt }] }],
		generationConfig: {
			responseMimeType: 'application/json',
			temperature: 0.1,
		},
	})

	// GEMINI_API_KEY injected from VaultDON secrets into the x-goog-api-key header
	const response = client
		.sendRequest(runtime, {
			vaultDonSecrets: [{ key: 'GEMINI_API_KEY', namespace: 'safemarket-wf1' }],
			request: {
				url: `https://generativelanguage.googleapis.com/v1beta/models/${runtime.config.geminiModel}:generateContent`,
				method: 'POST',
				bodyString: requestBody,
				multiHeaders: {
					'Content-Type': { values: ['application/json'] },
					'x-goog-api-key': { values: ['{{GEMINI_API_KEY}}'] },
				},
			},
		})
		.result()

	if (response.statusCode !== 200) {
		throw new Error(`Gemini API error ${response.statusCode}: ${text(response)}`)
	}

	const geminiResp = JSON.parse(text(response)) as {
		candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
	}

	const rawText = geminiResp.candidates?.[0]?.content?.parts?.[0]?.text
	if (!rawText) {
		throw new Error('Unexpected Gemini response structure — missing candidates text')
	}

	return JSON.parse(rawText) as GeminiAnalysis
}

// ─── On-chain write ───────────────────────────────────────────────────────────

const submitCreateMarket = (
	runtime: Runtime<Config>,
	creator: string,
	analysis: GeminiAnalysis,
): string => {
	const chainSelector =
		EVMClient.SUPPORTED_CHAIN_SELECTORS[
			runtime.config.chainSelectorName as keyof typeof EVMClient.SUPPORTED_CHAIN_SELECTORS
		]
	if (!chainSelector) {
		throw new Error(`Unsupported chainSelectorName: ${runtime.config.chainSelectorName}`)
	}

	const evmClient = new EVMClient(chainSelector)

	const deadlineTs = BigInt(Math.floor(new Date(analysis.suggestedDeadline).getTime() / 1000))
	const category = CATEGORY_MAP[analysis.category] ?? 3

	// Encode createMarketFromCre(address,uint64,uint16,uint8,string,string,string)
	const callData = encodeFunctionData({
		abi: VerityCore,
		functionName: 'createMarketFromCre',
		args: [
			creator as Address,
			deadlineTs,
			runtime.config.defaultFeeBps,
			category,
			analysis.refinedQuestion,
			analysis.resolutionCriteria,
			JSON.stringify(analysis.dataSources),
		],
	})

	runtime.log(
		`Encoded createMarketFromCre: selector=${callData.slice(0, 10)} deadline=${deadlineTs} category=${category}`,
	)

	// Sign with BFT consensus
	const report = runtime
		.report({
			encodedPayload: hexToBase64(callData),
			encoderName: 'evm',
			signingAlgo: 'ecdsa',
			hashingAlgo: 'keccak256',
		})
		.result()

	// Submit to Verity contract (must implement IReceiver.onReport)
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
	runtime.log(`Market created — txHash: ${txHash}`)
	return txHash
}

// ─── HTTP Trigger handler ─────────────────────────────────────────────────────

const onHTTPTrigger = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
	runtime.log('WF1 Market Creation — trigger received')

	// Decode payload.input (Uint8Array → UTF-8 JSON)
	const inputJson = new TextDecoder().decode(payload.input)
	runtime.log(`Input: ${inputJson}`)

	const input = JSON.parse(inputJson) as WorkflowInput

	if (!input.creator || !input.inputType) {
		throw new Error('Missing required fields: creator, inputType')
	}

	// Determine content to analyse
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
	const analysis = callGemini(runtime, prompt)

	runtime.log(
		`Gemini result: resolvable=${analysis.resolvable} category=${analysis.category} riskScore=${analysis.riskScore}`,
	)

	// ── Step 2: Decision logic ───────────────────────────────────────────────

	// Not resolvable
	if (!analysis.resolvable) {
		const result: WorkflowResult = {
			status: 'rejected',
			riskScore: analysis.riskScore,
			reason: `Not resolvable: ${analysis.riskReason}`,
		}
		runtime.log(`Rejected (unresolvable): ${result.reason}`)
		return JSON.stringify(result)
	}

	// Auto reject (71-100)
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

	// Pending review (31-70) — no on-chain write; admin handles via dashboard
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
			// authorizedKeys: [] = no request signing required (open for demo)
			// In production: populate with frontend's ECDSA public key
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
