import { z } from 'zod'

export const configSchema = z.object({
    verityCoreAddress: z.string(),
    chainSelectorName: z.string(),
    gasLimit: z.string(),
    geminiModel: z.string(),
    // Chainlink Price Feed addresses (Base Sepolia)
    ethUsdPriceFeed: z.string().optional(),
    btcUsdPriceFeed: z.string().optional(),
})

export type Config = z.infer<typeof configSchema>

// Score thresholds (matching spec exactly)
export const SCORE_SAFE = 30   // 0-30: safe, no action
export const SCORE_FLAG = 80   // 81-100: flag & pause market
