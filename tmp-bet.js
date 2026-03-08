/**
 * Test script: kirim onReport ke MockKeystoneForwarder
 * Tujuan: verifikasi di BaseScan bahwa "To" = MockKeystoneForwarder,
 *         bukan langsung ke Verity.
 *
 * Flow:
 *   1. Approve USDC
 *   2. proposeMarket() → Verity (bukan onReport)
 *   3. onReport() → MockKeystoneForwarder → forward ke Verity.onReport()
 *   4. Print txHash untuk dicek di BaseScan
 */

import { createWalletClient, createPublicClient, http, encodeAbiParameters, keccak256, toHex, parseUnits, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { readFileSync } from 'fs'

const PRIVATE_KEY             = '0x322ba80cd878d0a923045fc0ae2a3c8a07dfc19b7685912647ee16b0038182bf'
const VERITY_CORE             = '0x357E246B17bEF83BE4eA3321cBCA1BB642D17150'  // Verity — untuk read & proposeMarket
const MOCK_KEYSTONE_FORWARDER = '0x4aa01B2E8900EAfF69f761e0D9a2b58570F242F3'  // MockKeystoneForwarder — receiver onReport
const MOCK_USDC               = '0x9643419d69363278Bf74aA1494c3394aBF9E25da'
const RPC                     = 'https://sepolia.base.org'

const account      = privateKeyToAccount(PRIVATE_KEY)
const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) })
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC) })

const FORWARDER_ABI = parseAbi(['function forward(bytes, bytes)'])

const ERC20_ABI = parseAbi(['function approve(address, uint256) returns (bool)'])

async function main() {
    const payload = JSON.parse(readFileSync('./payload.json', 'utf8'))
    const proposalId = BigInt(payload.proposalId)

    console.log('=== TEST: onReport via MockKeystoneForwarder ===')
    console.log(`Verity              : ${VERITY_CORE}`)
    console.log(`MockKeystoneForwarder: ${MOCK_KEYSTONE_FORWARDER}`)
    console.log(`Creator             : ${account.address}`)
    console.log(`proposalId          : ${proposalId} (from payload.json)\n`)

    console.log('[1/3] Approving 5 USDC...')
    const approveTx = await walletClient.writeContract({
        address: MOCK_USDC, abi: ERC20_ABI, functionName: 'approve',
        args: [VERITY_CORE, parseUnits('5', 6)],
    })
    await publicClient.waitForTransactionReceipt({ hash: approveTx })
    console.log(`Approved — ${approveTx}\n`)

    console.log('[2/3] onReport() → MockKeystoneForwarder (bukan Verity!)...')
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const report = encodeAbiParameters(
        [
            { type: 'uint8' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint64' }, { type: 'uint16' },
            { type: 'uint8' }, { type: 'string' }, { type: 'string' }, { type: 'string' },
            { type: 'int256' }, { type: 'address' }, { type: 'uint8' },
        ],
        [
            1, proposalId, account.address, deadline, 200, 3,
            payload.question,
            `Resolves YES if: ${payload.question}`,
            '["chainlink"]',
            0n, '0x0000000000000000000000000000000000000000', 10,
        ]
    )
    const metadata = keccak256(toHex('safemarket-creation-v1'))

    const createTx = await walletClient.writeContract({
        address: MOCK_KEYSTONE_FORWARDER,  // ← ke MockKeystoneForwarder, bukan Verity
        abi: FORWARDER_ABI,
        functionName: 'forward',
        args: [metadata, report],
    })
    await publicClient.waitForTransactionReceipt({ hash: createTx })

    console.log('\n✅ BERHASIL!')
    console.log(`txHash: ${createTx}`)
    console.log(`\nCek di BaseScan:`)
    console.log(`https://sepolia.basescan.org/tx/${createTx}`)
    console.log(`\nPastikan field "To" = ${MOCK_KEYSTONE_FORWARDER} (MockKeystoneForwarder)`)
}

main().catch(console.error)
