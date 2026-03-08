import { z } from 'zod'

export const configSchema = z.object({
	verityCoreAddress: z.string(),
	// Hackathon: MockKeystoneForwarder address as writeReport receiver.
	// Production: omit this field — receiver falls back to verityCoreAddress (real Keystone Forwarder handles routing).
	writeReportReceiver: z.string().optional(),
	chainSelectorName: z.string(),
	gasLimit: z.string(),
	defaultFeeBps: z.number(),
	groqModel: z.string(),
	// Chainlink price feed addresses per asset (for CRYPTO category)
	// Key: asset symbol (ETH, BTC, etc.), Value: Chainlink feed address
	priceFeeds: z.record(z.string()).optional(),
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
