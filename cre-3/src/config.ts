import { z } from 'zod'

export const configSchema = z.object({
    verityCoreAddress: z.string(),
    chainSelectorName: z.string(),
    gasLimit: z.string(),
    groqModel: z.string(),
    confidenceThreshold: z.number().default(90),
    ethUsdPriceFeed: z.string().optional(),
})

export type Config = z.infer<typeof configSchema>

// MarketCategory (matches DataTypes.sol)
export const CATEGORY_CRYPTO = 0
export const CATEGORY_POLITICAL = 1
export const CATEGORY_SPORTS = 2
export const CATEGORY_OTHER = 3

// MarketOutcome (matches DataTypes.sol)
export const OUTCOME_YES = 1
export const OUTCOME_NO = 2
