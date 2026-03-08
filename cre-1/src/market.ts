import { bytesToHex, EVMClient, hexToBase64, TxStatus, type Runtime } from '@chainlink/cre-sdk'
import { type Address, encodeAbiParameters, zeroAddress } from 'viem'
import { CATEGORY_MAP, type Config } from './config'
import type { AIAnalysis } from './types'

// ACTION_CREATE_MARKET = 1 (matches CREAdapter.sol ACTION_CREATE_MARKET)
const ACTION_CREATE_MARKET = 1

/** Parse targetValue (USD) from question text. e.g. "$5000", "$5,000", "$5k" */
function parseTargetValueFromQuestion(question: string): number | null {
	// Match $5,000 or $5000 or $5k or 5000
	const match = question.match(/\$?\s*([\d,]+(?:\.\d+)?)\s*(k|K|thousand)?/i)
	if (!match) return null
	const numStr = match[1].replace(/,/g, '')
	let num = parseFloat(numStr)
	if (isNaN(num)) return null
	// Handle "5k" / "5K" / "5 thousand" = 5000
	if (match[2]) num *= 1000
	return num
}

/** Get price feed address from config for CRYPTO category */
function getPriceFeedAddress(config: Config, asset?: string | null): Address | null {
	const feeds = config.priceFeeds
	if (!feeds) return null
	const symbol = (asset || 'ETH').toUpperCase()
	const addr = feeds[symbol] ?? feeds['ETH']
	return addr ? (addr as Address) : null
}

export const submitCreateMarket = (
	runtime: Runtime<Config>,
	creator: string,
	analysis: AIAnalysis,
	proposalId: number | string,
): string => {
	// Use experimental chain selector from project.yaml.
	// '123456' bypasses CRE CLI's hardcoded Real KF for Base Sepolia.
	const chainSelector = BigInt(runtime.config.chainSelectorName)

	const evmClient = new EVMClient(chainSelector)

	// Clamp deadline: minimum 30 days from now to prevent DeadlineAlreadyPassed revert.
	// Groq sometimes suggests past dates for relative questions like "end of month".
	const nowTs = BigInt(Math.floor(Date.now() / 1000))
	const minDeadlineTs = nowTs + BigInt(30 * 24 * 60 * 60) // 30 days from now
	const rawDeadlineTs = BigInt(Math.floor(new Date(analysis.suggestedDeadline).getTime() / 1000))
	const deadlineTs = rawDeadlineTs > nowTs ? rawDeadlineTs : minDeadlineTs
	const category = CATEGORY_MAP[analysis.category] ?? 3

	const isCrypto = analysis.category === 'CRYPTO' || analysis.category === 'CRYPTO_PRICE'

	// targetValue: Chainlink 8 decimals. From Groq or parse from question
	let targetValue = 0n
	if (isCrypto) {
		const fromGroq = analysis.targetValue != null ? analysis.targetValue : null
		const fromQuestion = parseTargetValueFromQuestion(analysis.refinedQuestion || '')
		const usdValue = fromGroq ?? fromQuestion
		if (usdValue != null && usdValue > 0) {
			targetValue = BigInt(Math.round(usdValue * 1e8))
		}
	}

	// priceFeedAddress: from config (not Groq). Map asset -> Chainlink address
	const priceFeedFromConfig = getPriceFeedAddress(runtime.config, analysis.asset)
	const priceFeedAddress: Address =
		isCrypto && priceFeedFromConfig
			? priceFeedFromConfig
			: (analysis.priceFeedAddress as Address) || zeroAddress

	// riskScore: 0-100 from Groq, clamp to uint8
	const riskScore = Math.min(255, Math.max(0, analysis.riskScore)) & 0xff
	const proposalIdBigInt = BigInt(proposalId)

	// Encode as abi.encode(action, ...params) — _handleCreateMarket in CREAdapter expects 12 params
	const payload = encodeAbiParameters(
		[
			{ type: 'uint8' },    // action = ACTION_CREATE_MARKET
			{ type: 'uint256' },  // proposalId (from proposeMarket)
			{ type: 'address' },  // creator
			{ type: 'uint64' },   // deadline
			{ type: 'uint16' },   // feeBps
			{ type: 'uint8' },    // category
			{ type: 'string' },   // question
			{ type: 'string' },   // resolutionCriteria
			{ type: 'string' },   // dataSources
			{ type: 'int256' },   // targetValue (0 if not CRYPTO_PRICE)
			{ type: 'address' },  // priceFeedAddress (zero if not CRYPTO_PRICE)
			{ type: 'uint8' },    // riskScore (0-100)
		],
		[
			ACTION_CREATE_MARKET,
			proposalIdBigInt,
			creator as Address,
			deadlineTs,
			runtime.config.defaultFeeBps,
			category,
			analysis.refinedQuestion,
			analysis.resolutionCriteria,
			JSON.stringify(analysis.dataSources),
			targetValue,
			priceFeedAddress,
			riskScore,
		],
	)

	runtime.log(
		`Encoded ACTION_CREATE_MARKET: proposalId=${proposalIdBigInt} category=${category} riskScore=${riskScore} deadline=${deadlineTs} targetValue=${targetValue} priceFeed=${priceFeedAddress}`,
	)

	const report = runtime
		.report({
			encodedPayload: hexToBase64(payload),
			encoderName: 'evm',
			signingAlgo: 'ecdsa',
			hashingAlgo: 'keccak256',
		})
		.result()

	// Staging: writeReportReceiver = KeystoneOnReportAdapter (has CRE_ROLE, forwards to Verity)
	// Production: writeReportReceiver absent → falls back to verityCoreAddress (real KF handles it)
	const resp = evmClient
		.writeReport(runtime, {
			receiver: runtime.config.writeReportReceiver ?? runtime.config.verityCoreAddress,
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
