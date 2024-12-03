const express = require('express');
const transactions = require('./utils/transactions');
const { getTokenDecimals, convertAmountToBlockchainValue } = require('./utils/tokens');
const { isWhitelisted } = require('./utils/whitelist');
const { UserSigner } = require('@multiversx/sdk-wallet');
const { Address, TransactionPayload, TokenTransfer } = require('@multiversx/sdk-core');
const { ProxyNetworkProvider } = require('@multiversx/sdk-network-providers');

const router = express.Router();

// Constants
const API_BASE_URL = "https://api.multiversx.com";
const CHAIN_ID = process.env.CHAIN_ID || "1"; // Default to Mainnet if not specified
const USAGE_FEE = 100; // Fee in REWARD tokens
const REWARD_TOKEN = "REWARD-cf6eac"; // Token identifier
const TREASURY_WALLET = "erd158k2c3aserjmwnyxzpln24xukl2fsvlk9x46xae4dxl5xds79g6sdz37qn"; // Treasury wallet
const DEFAULT_GAS_LIMIT = 500_000; // Gas limit for transactions
const provider = new ProxyNetworkProvider(API_BASE_URL, { clientName: "MultiversX Transfers API" }); // Updated client name

// Middleware to handle the usage fee
const handleUsageFee = async (req, res, next) => {
    try {
        const pemContent = req.body.walletPem;
        const signer = UserSigner.fromPem(pemContent);
        const walletAddress = signer.getAddress().toString();

        // Skip fee if user is whitelisted
        if (isWhitelisted(walletAddress)) {
            console.log(`Wallet ${walletAddress} is whitelisted. Skipping usage fee.`);
            next();
            return;
        }

        const decimals = await getTokenDecimals(REWARD_TOKEN);
        const amount = convertAmountToBlockchainValue(USAGE_FEE, decimals);

        const tokenTransfer = TokenTransfer.fungibleFromAmount(REWARD_TOKEN, amount, decimals);

        const tx = new transactions.TransactionBuilder()
            .setSender(signer.getAddress())
            .setReceiver(new Address(TREASURY_WALLET))
            .setGasLimit(DEFAULT_GAS_LIMIT)
            .setData(TransactionPayload.esdtTransfer(tokenTransfer))
            .setChainID(CHAIN_ID)
            .build();

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);
        const status = await transactions.watchTransactionStatus(txHash.toString());

        if (status.status !== "success") {
            throw new Error('Usage fee transaction failed. Ensure sufficient REWARD tokens are available.');
        }

        req.usageFeeHash = txHash.toString();
        next();
    } catch (error) {
        console.error('Error processing usage fee:', error.message);
        res.status(400).json({ error: error.message });
    }
};

// EGLD Transfer
router.post('/egldTransfer', handleUsageFee, async (req, res) => {
    try {
        const { recipient, amount } = req.body;
        const pemContent = req.body.walletPem;

        if (!recipient || !amount) {
            return res.status(400).json({ error: 'Recipient and amount are required for EGLD transfer.' });
        }

        // Send EGLD Transaction
        const result = await transactions.sendEgld(pemContent, recipient, amount);

        res.json({
            message: "EGLD transfer executed successfully.",
            usageFeeHash: req.usageFeeHash,
            result,
        });
    } catch (error) {
        console.error('Error executing EGLD transfer:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ESDT Transfer
router.post('/esdtTransfer', handleUsageFee, async (req, res) => {
    try {
        const { recipient, amount, tokenTicker } = req.body;
        const pemContent = req.body.walletPem;

        if (!recipient || !amount || !tokenTicker) {
            return res.status(400).json({ error: 'Recipient, amount, and tokenTicker are required for ESDT transfer.' });
        }

        // Send ESDT Transaction
        const result = await transactions.sendEsdtToken(pemContent, recipient, amount, tokenTicker);

        res.json({
            message: "ESDT transfer executed successfully.",
            usageFeeHash: req.usageFeeHash,
            result,
        });
    } catch (error) {
        console.error('Error executing ESDT transfer:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// NFT Transfer
router.post('/nftTransfer', handleUsageFee, async (req, res) => {
    try {
        const { recipient, tokenIdentifier, tokenNonce } = req.body;
        const pemContent = req.body.walletPem;

        if (!recipient || !tokenIdentifier || tokenNonce === undefined) {
            return res.status(400).json({
                error: 'Recipient, tokenIdentifier, and tokenNonce are required for NFT transfer.',
            });
        }

        // Send NFT Transaction
        const result = await transactions.sendNftToken(pemContent, recipient, tokenIdentifier, tokenNonce);

        res.json({
            message: "NFT transfer executed successfully.",
            usageFeeHash: req.usageFeeHash,
            result,
        });
    } catch (error) {
        console.error('Error executing NFT transfer:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// SFT Transfer
router.post('/sftTransfer', handleUsageFee, async (req, res) => {
    try {
        const { recipient, amount, tokenTicker, tokenNonce } = req.body;
        const pemContent = req.body.walletPem;

        if (!recipient || !amount || !tokenTicker || tokenNonce === undefined) {
            return res.status(400).json({
                error: 'Recipient, amount, tokenTicker, and tokenNonce are required for SFT transfer.',
            });
        }

        // Send SFT Transaction
        const result = await transactions.sendSftToken(pemContent, recipient, amount, tokenTicker, tokenNonce);

        res.json({
            message: "SFT transfer executed successfully.",
            usageFeeHash: req.usageFeeHash,
            result,
        });
    } catch (error) {
        console.error('Error executing SFT transfer:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Free NFT Mint Airdrop
router.post('/freeNftMintAirdrop', handleUsageFee, async (req, res) => {
    try {
        const { scAddress, endpoint, receiver, qty } = req.body;
        const pemContent = req.body.walletPem;

        if (!scAddress || !endpoint || !receiver || qty === undefined) {
            return res.status(400).json({
                error: 'scAddress, endpoint, receiver, and qty are required for the NFT mint airdrop.',
            });
        }

        // Execute Free NFT Mint Airdrop
        const result = await transactions.executeFreeNftMintAirdrop(pemContent, scAddress, endpoint, receiver, qty);

        res.json({
            message: "Free NFT mint airdrop executed successfully.",
            usageFeeHash: req.usageFeeHash,
            result,
        });
    } catch (error) {
        console.error('Error executing Free NFT Mint Airdrop:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ESDT Airdrop to NFT Owners
router.post('/distributeRewardsToNftOwners', handleUsageFee, async (req, res) => {
    try {
        const { uniqueOwnerStats, tokenTicker, baseAmount, multiply } = req.body;
        const pemContent = req.body.walletPem;

        // Validation
        if (!uniqueOwnerStats || !Array.isArray(uniqueOwnerStats)) {
            return res.status(400).json({
                error: 'Invalid uniqueOwnerStats provided. It must be an array.',
            });
        }
        if (!tokenTicker || !baseAmount) {
            return res.status(400).json({
                error: 'Token ticker and base amount are required.',
            });
        }

        // Execute rewards distribution
        const results = await transactions.distributeRewardsToNftOwners(
            pemContent,
            uniqueOwnerStats,
            tokenTicker,
            baseAmount,
            multiply
        );

        res.json({
            message: "Rewards distribution to NFT owners completed successfully.",
            usageFeeHash: req.usageFeeHash,
            results,
        });
    } catch (error) {
        console.error('Error during rewards distribution:', error.message);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
