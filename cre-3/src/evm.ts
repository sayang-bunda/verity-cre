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
import { OUTCOME_YES, OUTCOME_NO } from './config'
import type { MarketInfo, ResolutionData, ResolutionResult } from './types'


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
 * Step 2a — EVM Read: market category, status, deadline, question
 */
export const readMarketInfo = (runtime: Runtime<Config>, marketId: bigint): MarketInfo => {
    const evmClient = getEvmClient(runtime)
    const contractAddr = runtime.config.verityCoreAddress as Address

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

    let question = 'Unknown'
    try {
        const qResult = evmClient
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
            data: bytesToHex(qResult.data),
        }) as string
    } catch (err) {
        runtime.log(`Could not read market question: ${err}`)
    }

    return {
        category: Number(market.category),
        status: Number(market.status),
        deadline: market.deadline,
        question,
    }
}


/**
 * Step 2b — EVM Read: resolution criteria, data sources, targetValue, priceFeedAddress
 */
export const readResolutionData = (runtime: Runtime<Config>, marketId: bigint): ResolutionData => {
    const evmClient = getEvmClient(runtime)
    const contractAddr = runtime.config.verityCoreAddress as Address

    try {
        const result = evmClient
            .callContract(runtime, {
                call: encodeCallMsg({
                    from: zeroAddress,
                    to: contractAddr,
                    data: encodeFunctionData({ abi: VerityCore, functionName: 'getResolutionData', args: [marketId] }),
                }),
                blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
            })
            .result()

        const decoded = decodeFunctionResult({
            abi: VerityCore,
            functionName: 'getResolutionData',
            data: bytesToHex(result.data),
        }) as any

        return {
            resolutionCriteria: decoded.resolutionCriteria ?? '',
            dataSources: decoded.dataSources ?? '',
            targetValue: decoded.targetValue ?? 0n,
            priceFeedAddress: decoded.priceFeedAddress ?? zeroAddress,
        }
    } catch (err) {
        runtime.log(`getResolutionData failed, using defaults: ${err}`)
        return {
            resolutionCriteria: '',
            dataSources: '',
            targetValue: 0n,
            priceFeedAddress: runtime.config.ethUsdPriceFeed ?? zeroAddress,
        }
    }
}


/**
 * Step 3a — CRYPTO_PRICE: read Chainlink Price Feed and compare to targetValue (deterministic)
 */
export const resolveCryptoPrice = (
    runtime: Runtime<Config>,
    resolution: ResolutionData,
): ResolutionResult => {
    const feedAddress = resolution.priceFeedAddress !== zeroAddress
        ? resolution.priceFeedAddress
        : runtime.config.ethUsdPriceFeed

    if (!feedAddress || feedAddress === zeroAddress) {
        throw new Error('No Chainlink Price Feed address available for CRYPTO_PRICE resolution')
    }

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

    // Chainlink ETH/USD: 8 decimals. targetValue also stored with 8 decimals.
    const [, answer] = decoded as [bigint, bigint, bigint, bigint, bigint]
    const isYes = answer >= resolution.targetValue
    const priceUsd = Number(answer) / 1e8
    const targetUsd = Number(resolution.targetValue) / 1e8

    runtime.log(
        `CRYPTO_PRICE: currentPrice=$${priceUsd.toFixed(2)} targetValue=$${targetUsd.toFixed(2)} → ${isYes ? 'YES' : 'NO'}`,
    )

    return {
        outcome: isYes ? OUTCOME_YES : OUTCOME_NO,
        confidence: 100, // Deterministic — always 100%
        reason: `Chainlink price feed: $${priceUsd.toFixed(2)} is ${isYes ? '>=' : '<'} target $${targetUsd.toFixed(2)}`,
    }
}


/**
 * Step 5 — EVM Write: resolveMarketFromCre(marketId, outcome, confidence)
 */
export const submitResolveMarket = (
    runtime: Runtime<Config>,
    marketId: bigint,
    outcome: number,
    confidence: number,
): string => {
    const evmClient = getEvmClient(runtime)

    const callData = encodeFunctionData({
        abi: VerityCore,
        functionName: 'resolveMarketFromCre',
        args: [marketId, outcome, confidence],
    })

    runtime.log(`Encoding resolveMarketFromCre: marketId=${marketId} outcome=${outcome} confidence=${confidence}`)

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
        throw new Error(`resolveMarketFromCre failed (${resp.txStatus}): ${resp.errorMessage ?? ''}`)
    }

    const txHash = bytesToHex(resp.txHash ?? new Uint8Array(32))
    runtime.log(`Market resolved — txHash: ${txHash}`)
    return txHash
}
