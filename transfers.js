const transactions = require('./utils/transactions');
const express = require('express');
const Joi = require('joi');
const { getTokenDecimals, convertAmountToBlockchainValue } = require('./utils/tokens');
const { isWhitelisted } = require('./utils/whitelist');
const { UserSigner } = require('@multiversx/sdk-wallet');
const { Address, TransactionPayload, TokenTransfer, TransferTransactionsFactory, TransactionsFactoryConfig, TransactionWatcher } = require('@multiversx/sdk-core');
const { ProxyNetworkProvider } = require('@multiversx/sdk-network-providers');

const router = express.Router();

// Constants
const API_BASE_URL = process.env.API_BASE_URL || "https://api.multiversx.com";
const CHAIN_ID = process.env.CHAIN_ID || "1"; // Default to Mainnet if not specified
const USAGE_FEE = parseInt(process.env.USAGE_FEE || "100");
const REWARD_TOKEN = process.env.REWARD_TOKEN || "REWARD-cf6eac";
const TREASURY_WALLET = process.env.TREASURY_WALLET || "erd158k2c3aserjmwnyxzpln24xukl2fsvlk9x46xae4dxl5xds79g6sdz37qn";
const DEFAULT_GAS_LIMIT = 500_000;
const provider = new ProxyNetworkProvider(API_BASE_URL, { clientName: "MultiversX Transfers API" });

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

        const factoryConfig = new TransactionsFactoryConfig({ chainID: CHAIN_ID });
        const transferFactory = new TransferTransactionsFactory({ config: factoryConfig });

        const tx = transferFactory.createTransactionForESDTTokenTransfer({
            sender: signer.getAddress(),
            receiver: new Address(TREASURY_WALLET),
            tokenTransfers: [tokenTransfer],
            gasLimit: BigInt(DEFAULT_GAS_LIMIT),
        });
        console.log(`Prepared usage fee transaction: ${JSON.stringify(tx)}`);

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        // Watch transaction status
        const watcher = new TransactionWatcher(provider);
        const status = await watcher.awaitCompleted(txHash.toString());
        console.log(`Usage fee transaction status: ${status.isSuccessful() ? 'success' : 'fail'}`);

        if (status.isSuccessful()) {
            req.usageFeeHash = txHash.toString(); // Pass the transaction hash to the next middleware
            next();
        } else {
            throw new Error('Usage fee transaction failed. Ensure sufficient REWARD tokens are available.');
        }
    } catch (error) {
        console.error('Error processing usage fee:', error.message);
        res.status(400).json({ error: error.message });
    }
};

// EGLD Transfer
// Define Joi schema for EGLD transfer
const egldTransferSchema = Joi.object({
    recipient: Joi.string().required().label('Recipient Address'),
    amount: Joi.number().positive().required().label('Transfer Amount'),
    walletPem: Joi.string().required().label('Wallet PEM Content'),
});

router.post('/egldTransfer', handleUsageFee, async (req, res) => {
    try {
        // Validate the request body using Joi
        const { error } = egldTransferSchema.validate(req.body);
        if (error) {
            console.error('Validation error in egldTransfer:', error.details[0].message);
            return res.status(400).json({ error: error.details[0].message });
        }

        const { recipient, amount, walletPem } = req.body;

        // Perform the EGLD transfer
        const result = await transactions.sendEgld(walletPem, recipient, amount);

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
// Define Joi schema for ESDT transfer
const esdtTransferSchema = Joi.object({
    recipient: Joi.string().required().label('Recipient Address'),
    amount: Joi.number().positive().required().label('Transfer Amount'),
    tokenTicker: Joi.string().required().label('Token Ticker'),
    walletPem: Joi.string().required().label('Wallet PEM Content'),
});

router.post('/esdtTransfer', handleUsageFee, async (req, res) => {
    try {
        // Validate the request body
        const { error } = esdtTransferSchema.validate(req.body);
        if (error) {
            console.error('Validation error in esdtTransfer:', error.details[0].message);
            return res.status(400).json({ error: error.details[0].message });
        }

        const { recipient, amount, tokenTicker, walletPem } = req.body;

        // Perform the ESDT transfer
        const result = await transactions.sendEsdtToken(walletPem, recipient, amount, tokenTicker);

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
// Define Joi schema for NFT transfer
const nftTransferSchema = Joi.object({
    recipient: Joi.string().required().label('Recipient Address'),
    tokenIdentifier: Joi.string().required().label('Token Identifier'),
    tokenNonce: Joi.number().integer().min(0).required().label('Token Nonce'),
    walletPem: Joi.string().required().label('Wallet PEM Content'),
});

router.post('/nftTransfer', handleUsageFee, async (req, res) => {
    try {
        // Validate the request body
        const { error } = nftTransferSchema.validate(req.body);
        if (error) {
            console.error('Validation error in nftTransfer:', error.details[0].message);
            return res.status(400).json({ error: error.details[0].message });
        }

        const { recipient, tokenIdentifier, tokenNonce, walletPem } = req.body;

        // Perform the NFT transfer
        const result = await transactions.sendNftToken(walletPem, recipient, tokenIdentifier, tokenNonce);

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
// Define Joi schema for SFT transfer
const sftTransferSchema = Joi.object({
    recipient: Joi.string().required().label('Recipient Address'),
    amount: Joi.number().positive().required().label('Transfer Amount'),
    tokenTicker: Joi.string().required().label('Token Ticker'),
    tokenNonce: Joi.number().integer().min(0).required().label('Token Nonce'),
    walletPem: Joi.string().required().label('Wallet PEM Content'),
});

router.post('/sftTransfer', handleUsageFee, async (req, res) => {
    try {
        // Validate the request body
        const { error } = sftTransferSchema.validate(req.body);
        if (error) {
            console.error('Validation error in sftTransfer:', error.details[0].message);
            return res.status(400).json({ error: error.details[0].message });
        }

        const { recipient, amount, tokenTicker, tokenNonce, walletPem } = req.body;

        // Perform the SFT transfer
        const result = await transactions.sendSftToken(walletPem, recipient, amount, tokenTicker, tokenNonce);

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
// Define Joi schema for Free NFT Mint Airdrop
const freeNftMintAirdropSchema = Joi.object({
    scAddress: Joi.string().required().label('Smart Contract Address'),
    endpoint: Joi.string().required().label('Smart Contract Endpoint'),
    receiver: Joi.string().required().label('Receiver Address'),
    qty: Joi.number().integer().positive().required().label('Quantity'),
    walletPem: Joi.string().required().label('Wallet PEM Content'),
});

router.post('/freeNftMintAirdrop', handleUsageFee, async (req, res) => {
    try {
        // Validate the request body
        const { error } = freeNftMintAirdropSchema.validate(req.body);
        if (error) {
            console.error('Validation error in freeNftMintAirdrop:', error.details[0].message);
            return res.status(400).json({ error: error.details[0].message });
        }

        const { scAddress, endpoint, receiver, qty, walletPem } = req.body;

        // Perform the Free NFT Mint Airdrop
        const result = await transactions.executeFreeNftMintAirdrop(walletPem, scAddress, endpoint, receiver, qty);

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
// Define Joi schema for Distribute Rewards
const distributeRewardsSchema = Joi.object({
    uniqueOwnerStats: Joi.array().items(
        Joi.object({
            owner: Joi.string().required().label('Owner Address'),
            tokensCount: Joi.number().integer().positive().required().label('Tokens Count'),
        })
    ).required().label('Unique Owner Stats'),
    tokenTicker: Joi.string().required().label('Token Ticker'),
    baseAmount: Joi.number().positive().required().label('Base Amount'),
    multiply: Joi.string().valid('yes', 'no').optional().label('Multiply Rewards'),
    walletPem: Joi.string().required().label('Wallet PEM Content'),
});

router.post('/distributeRewardsToNftOwners', handleUsageFee, async (req, res) => {
    try {
        // Validate the request body
        const { error } = distributeRewardsSchema.validate(req.body);
        if (error) {
            console.error('Validation error in distributeRewardsToNftOwners:', error.details[0].message);
            return res.status(400).json({ error: error.details[0].message });
        }

        const { uniqueOwnerStats, tokenTicker, baseAmount, multiply, walletPem } = req.body;

        // Perform rewards distribution
        const results = await transactions.distributeRewardsToNftOwners(
            walletPem,
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
