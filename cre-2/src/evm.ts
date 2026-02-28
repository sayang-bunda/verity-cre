import {
    bytesToHex,
    EVMClient,
    encodeCallMsg,
    hexToBase64,
    LAST_FINALIZED_BLOCK_NUMBER,
    TxStatus,
    type Runtime,
} from '@chainlink/cre-sdk'
import {
    type Address,
    decodeFunctionResult,
    encodeFunctionData,
    zeroAddress,
} from 'viem'
import { VerityCore, ChainlinkPriceFeed } from '../../contracts/abi'
import type { Config } from './config'
import type { MarketData } from './types'


export const getEvmClient = (runtime: Runtime<Config>): EVMClient => {
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
export const readMarketData = (runtime: Runtime<Config>, marketId: bigint): MarketData => {
    const evmClient = getEvmClient(runtime)
    const contractAddr = runtime.config.verityCoreAddress as Address

    // ── Read market struct ──
    const marketResult = evmClient
        .callContract(runtime, {
            call: encodeCallMsg({
                from: zeroAddress,
                to: contractAddr,
                data: encodeFunctionData({ abi: VerityCore, functionName: 'getMarket', args: [marketId] }),
            }),
            blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
        })
        .result()

    const market = decodeFunctionResult({
        abi: VerityCore,
        functionName: 'getMarket',
        data: bytesToHex(marketResult.data),
    }) as any

    // ── Read market question ──
    let question = 'Unknown'
    try {
        const questionResult = evmClient
            .callContract(runtime, {
                call: encodeCallMsg({
                    from: zeroAddress,
                    to: contractAddr,
                    data: encodeFunctionData({ abi: VerityCore, functionName: 'getMarketQuestion', args: [marketId] }),
                }),
                blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
            })
            .result()

        question = decodeFunctionResult({
            abi: VerityCore,
            functionName: 'getMarketQuestion',
            data: bytesToHex(questionResult.data),
        }) as string
    } catch (err) {
        runtime.log(`Failed to read market question: ${err}`)
    }

    // ── Read bettor count ──
    let bettorCount = 0n
    try {
        const bettorCountResult = evmClient
            .callContract(runtime, {
                call: encodeCallMsg({
                    from: zeroAddress,
                    to: contractAddr,
                    data: encodeFunctionData({ abi: VerityCore, functionName: 'getBettorCount', args: [marketId] }),
                }),
                blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
            })
            .result()

        bettorCount = decodeFunctionResult({
            abi: VerityCore,
            functionName: 'getBettorCount',
            data: bytesToHex(bettorCountResult.data),
        }) as bigint
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


/**
 * If CRYPTO_PRICE category (0): read current price from Chainlink Price Feed
 */
export const readChainlinkPrice = (runtime: Runtime<Config>, category: number): string => {
    if (category !== 0) return ''

    const feedAddress = runtime.config.ethUsdPriceFeed
    if (!feedAddress) {
        runtime.log('No ethUsdPriceFeed configured, skipping price feed read')
        return 'Price feed not configured'
    }

    try {
        const evmClient = getEvmClient(runtime)

        const result = evmClient
            .callContract(runtime, {
                call: encodeCallMsg({
                    from: zeroAddress,
                    to: feedAddress as Address,
                    data: encodeFunctionData({ abi: ChainlinkPriceFeed, functionName: 'latestRoundData', args: [] }),
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
        const price = Number(answer) / 1e8   // Chainlink ETH/USD has 8 decimals
        return `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    } catch (err) {
        runtime.log(`Chainlink price read failed: ${err}`)
        return 'Price feed read failed'
    }
}


/**
 * Step 6 — EVM Write: reportManipulation(marketId, score, reason)
 */
export const submitManipulationReport = (
    runtime: Runtime<Config>,
    marketId: bigint,
    score: number,
    reason: string,
): string => {
    const evmClient = getEvmClient(runtime)

    const callData = encodeFunctionData({
        abi: VerityCore,
        functionName: 'reportManipulation',
        args: [marketId, score, reason],
    })

    runtime.log(`Encoded reportManipulation: marketId=${marketId} score=${score}`)

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
    runtime.log(`Manipulation reported — txHash: ${txHash}`)
    return txHash
}
