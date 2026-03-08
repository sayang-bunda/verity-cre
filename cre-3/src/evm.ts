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
    encodeAbiParameters,
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

        const dataHex = bytesToHex(result.data)
        if (dataHex === '0x' || result.data.length === 0) {
            runtime.log('Data returned from getResolutionData is empty ("0x"). Using fallback data.')
            return {
                resolutionCriteria: 'Resolves YES if ETH exceeds $2000.',
                dataSources: '["chainlink"]',
                targetValue: 200000000000n, // $2000
                priceFeedAddress: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1', // ETH/USD
            }
        }

        const decoded = decodeFunctionResult({
            abi: VerityCore,
            functionName: 'getResolutionData',
            data: dataHex,
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
 * Fallback: if priceFeed is 0x0 or call fails → escalate (low confidence) so users can claimRefund
 */
export const resolveCryptoPrice = (
    runtime: Runtime<Config>,
    resolution: ResolutionData,
): ResolutionResult => {
    const feedAddress = resolution.priceFeedAddress !== zeroAddress
        ? resolution.priceFeedAddress
        : runtime.config.ethUsdPriceFeed

    if (!feedAddress || feedAddress === zeroAddress) {
        runtime.log('CRYPTO_PRICE: No price feed address (targetValue=0, priceFeed=0x0) — escalating for manual resolution')
        return {
            outcome: OUTCOME_YES, // Placeholder, contract will escalate
            confidence: 50,
            reason: 'Market missing targetValue/priceFeed — escalated for manual resolution. Users may claimRefund.',
            evidenceUrls: [],
        }
    }

    const evmClient = getEvmClient(runtime)

    try {
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

        const dataHex = bytesToHex(result.data)
        if (dataHex === '0x' || !result.data || result.data.length === 0) {
            runtime.log('CRYPTO_PRICE: Price feed returned empty data — escalating')
            return {
                outcome: OUTCOME_YES,
                confidence: 50,
                reason: 'Chainlink price feed returned no data — escalated for manual resolution.',
                evidenceUrls: [],
            }
        }

        const decoded = decodeFunctionResult({
            abi: ChainlinkPriceFeed,
            functionName: 'latestRoundData',
            data: dataHex,
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
            confidence: 100,
            reason: `Chainlink price feed: $${priceUsd.toFixed(2)} is ${isYes ? '>=' : '<'} target $${targetUsd.toFixed(2)}`,
            evidenceUrls: [],
        }
    } catch (err) {
        runtime.log(`CRYPTO_PRICE: Failed to read price feed (${err}) — escalating`)
        return {
            outcome: OUTCOME_YES,
            confidence: 50,
            reason: `Price feed read failed: ${err instanceof Error ? err.message : String(err)} — escalated. Users may claimRefund.`,
            evidenceUrls: [],
        }
    }
}


/**
 * Step 5 — EVM Write: resolveMarketFromCre(marketId, outcome, confidence, evidenceUrls)
 */
export const submitResolveMarket = (
    runtime: Runtime<Config>,
    marketId: bigint,
    outcome: number,
    confidence: number,
    reason: string,
    evidenceUrls: string[],
): string => {
    const evmClient = getEvmClient(runtime)

    const callData = encodeAbiParameters(
        [
            { type: 'uint8' },
            { type: 'uint256' },
            { type: 'uint8' },
            { type: 'uint8' },
            { type: 'string' },
            { type: 'string[]' },
        ],
        [3, marketId, outcome, confidence, reason, evidenceUrls] // 3 is ACTION_RESOLVE_MARKET
    )

    runtime.log(`Encoded ACTION_RESOLVE_MARKET: marketId=${marketId} outcome=${outcome} confidence=${confidence} urls=[${evidenceUrls.slice(0, 2).join(', ')}]`)

    const report = runtime
        .report({
            encodedPayload: hexToBase64(callData),
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
        throw new Error(`resolveMarketFromCre failed (${resp.txStatus}): ${resp.errorMessage ?? ''}`)
    }

    const txHash = bytesToHex(resp.txHash ?? new Uint8Array(32))
    runtime.log(`Market resolved — txHash: ${txHash}`)
    return txHash
}