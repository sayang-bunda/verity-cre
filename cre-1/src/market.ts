import { bytesToHex, EVMClient, hexToBase64, TxStatus, type Runtime } from '@chainlink/cre-sdk'
import { type Address, encodeAbiParameters, zeroAddress } from 'viem'
import { CATEGORY_MAP, type Config } from './config'
import type { AIAnalysis } from './types'

// ACTION_CREATE_MARKET = 1 (matches CREAdapter.sol ACTION_CREATE_MARKET)
const ACTION_CREATE_MARKET = 1

export const submitCreateMarket = (
	runtime: Runtime<Config>,
	creator: string,
	analysis: AIAnalysis,
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

	// targetValue: convert float USD to int256 with 8 decimals (Chainlink format)
	// e.g. 3000.00 → 300000000000n. Null/non-crypto → 0n
	const targetValue =
		analysis.targetValue != null ? BigInt(Math.round(analysis.targetValue * 1e8)) : 0n

	const priceFeedAddress: Address =
		analysis.category === 'CRYPTO_PRICE' && analysis.priceFeedAddress
			? (analysis.priceFeedAddress as Address)
			: zeroAddress

	// Encode as abi.encode(action, ...params) — onReport decoder in CREAdapter expects this format
	// NOT encodeFunctionData (which would include a 4-byte function selector)
	const payload = encodeAbiParameters(
		[
			{ type: 'uint8' },    // action = ACTION_CREATE_MARKET
			{ type: 'address' },  // creator
			{ type: 'uint64' },   // deadline
			{ type: 'uint16' },   // feeBps
			{ type: 'uint8' },    // category
			{ type: 'string' },   // question
			{ type: 'string' },   // resolutionCriteria
			{ type: 'string' },   // dataSources
			{ type: 'int256' },   // targetValue (0 if not CRYPTO_PRICE)
			{ type: 'address' },  // priceFeedAddress (zero if not CRYPTO_PRICE)
		],
		[
			ACTION_CREATE_MARKET,
			creator as Address,
			deadlineTs,
			runtime.config.defaultFeeBps,
			category,
			analysis.refinedQuestion,
			analysis.resolutionCriteria,
			JSON.stringify(analysis.dataSources),
			targetValue,
			priceFeedAddress,
		],
	)

	runtime.log(
		`Encoded ACTION_CREATE_MARKET: category=${category} deadline=${deadlineTs} targetValue=${targetValue} priceFeed=${priceFeedAddress}`,
	)

	const report = runtime
		.report({
			encodedPayload: hexToBase64(payload),
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
		throw new Error(`writeReport failed (${resp.txStatus}): ${resp.errorMessage ?? ''}`)
	}

	const txHash = bytesToHex(resp.txHash ?? new Uint8Array(32))
	runtime.log(`Market created — txHash: ${txHash}`)
	return txHash
}
