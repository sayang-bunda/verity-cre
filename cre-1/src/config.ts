import { z } from 'zod'

export const configSchema = z.object({
	verityCoreAddress: z.string(),
	chainSelectorName: z.string(),
	gasLimit: z.string(),
	defaultFeeBps: z.number(),
	groqModel: z.string(),
})

export type Config = z.infer<typeof configSchema>

// MarketCategory enum mapping: AI output → contract uint8
// CRYPTO = 0, EVENT = 1, SOCIAL = 2, OTHER = 3
export const CATEGORY_MAP: Record<string, number> = {
	CRYPTO_PRICE: 0,
	CRYPTO: 0,
	EVENT: 1,
	SOCIAL: 2,
	OTHER: 3,
}

export const RISK_AUTO_APPROVE = 30
export const RISK_AUTO_REJECT = 70
