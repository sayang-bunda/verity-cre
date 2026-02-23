import { bytesToHex, EVMClient, hexToBase64, TxStatus, type Runtime } from '@chainlink/cre-sdk'
import { type Address, encodeFunctionData } from 'viem'
import { VerityCore } from '../../contracts/abi'
import { CATEGORY_MAP, type Config } from './config'
import type { AIAnalysis } from './types'

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
		throw new Error(`writeReport failed (${resp.txStatus}): ${resp.errorMessage ?? ''}`)
	}

	const txHash = bytesToHex(resp.txHash ?? new Uint8Array(32))
	runtime.log(`Market created — txHash: ${txHash}`)
	return txHash
}
