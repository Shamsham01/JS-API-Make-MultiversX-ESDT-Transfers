const transactions = require('./utils/transactions');
const express = require('express');
const Joi = require('joi');
const { ProxyNetworkProvider } = require('@multiversx/sdk-network-providers');

const router = express.Router();

// Constants
const API_BASE_URL = process.env.API_BASE_URL || "https://api.multiversx.com";
const CHAIN_ID = process.env.CHAIN_ID || "1";
const REWARD_TOKEN = process.env.REWARD_TOKEN || "REWARD-cf6eac";
const TREASURY_WALLET = process.env.TREASURY_WALLET || "erd158k2c3aserjmwnyxzpln24xukl2fsvlk9x46xae4dxl5xds79g6sdz37qn";
const provider = new ProxyNetworkProvider(API_BASE_URL, { clientName: "MultiversX Transfers API" });

// Joi Schemas
const schemas = {
    egldTransfer: Joi.object({
        recipient: Joi.string().required().label('Recipient Address'),
        amount: Joi.number().positive().required().label('Transfer Amount'),
        walletPem: Joi.string().required().label('Wallet PEM Content'),
    }),
    esdtTransfer: Joi.object({
        recipient: Joi.string().required().label('Recipient Address'),
        amount: Joi.number().positive().required().label('Transfer Amount'),
        tokenTicker: Joi.string().required().label('Token Ticker'),
        walletPem: Joi.string().required().label('Wallet PEM Content'),
    }),
    nftTransfer: Joi.object({
        recipient: Joi.string().required().label('Recipient Address'),
        tokenIdentifier: Joi.string().required().label('Token Identifier'),
        tokenNonce: Joi.number().integer().min(0).required().label('Token Nonce'),
        walletPem: Joi.string().required().label('Wallet PEM Content'),
    }),
    sftTransfer: Joi.object({
        recipient: Joi.string().required().label('Recipient Address'),
        amount: Joi.number().positive().required().label('Transfer Amount'),
        tokenTicker: Joi.string().required().label('Token Ticker'),
        tokenNonce: Joi.number().integer().min(0).required().label('Token Nonce'),
        walletPem: Joi.string().required().label('Wallet PEM Content'),
    }),
    freeNftMintAirdrop: Joi.object({
        scAddress: Joi.string().required().label('Smart Contract Address'),
        endpoint: Joi.string().required().label('Smart Contract Endpoint'),
        receiver: Joi.string().required().label('Receiver Address'),
        qty: Joi.number().integer().positive().required().label('Quantity'),
        walletPem: Joi.string().required().label('Wallet PEM Content'),
    }),
    distributeRewards: Joi.object({
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
    }),
};

// Routes
router.post('/egldTransfer', transactions.handleUsageFee, async (req, res) => {
    try {
        const { error } = schemas.egldTransfer.validate(req.body);
        if (error) return res.status(400).json({ error: error.details[0].message });
        const { recipient, amount, walletPem } = req.body;
        const result = await transactions.sendEgld(walletPem, recipient, amount);
        res.json({ message: "EGLD transfer executed successfully.", usageFeeHash: req.usageFeeHash, result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/esdtTransfer', transactions.handleUsageFee, async (req, res) => {
    try {
        const { recipient, amount, tokenTicker, walletPem } = req.body;

        const signer = UserSigner.fromPem(walletPem);
        const senderAddress = signer.getAddress();

        const nonce = await getNonce(senderAddress); // Fetch nonce
        const decimals = await getTokenDecimals(tokenTicker);
        const adjustedAmount = convertAmountToBlockchainValue(amount, decimals);

        const tokenTransfer = TokenTransfer.fungibleFromAmount(tokenTicker, adjustedAmount, decimals);
        const factoryConfig = new TransactionsFactoryConfig({ chainID: CHAIN_ID });
        const transferFactory = new TransferTransactionsFactory({ config: factoryConfig });

        const tx = transferFactory.createTransactionForESDTTokenTransfer({
            sender: senderAddress,
            receiver: new Address(recipient),
            tokenTransfers: [tokenTransfer],
            nonce, // Use locked nonce
        });

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);
        incrementNonce(senderAddress); // Increment nonce

        res.json({
            message: "ESDT transfer executed successfully.",
            usageFeeHash: req.usageFeeHash,
            result: { txHash },
        });
    } catch (error) {
        console.error('Error executing ESDT transfer:', error.message);
        res.status(500).json({ error: error.message });
    }
});


router.post('/nftTransfer', transactions.handleUsageFee, async (req, res) => {
    try {
        // Validate the request body
        const { error } = schemas.nftTransfer.validate(req.body);
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
router.post('/sftTransfer', transactions.handleUsageFee, async (req, res) => {
    try {
        const { error } = schemas.sftTransfer.validate(req.body);
        if (error) {
            console.error('Validation error in sftTransfer:', error.details[0].message);
            return res.status(400).json({ error: error.details[0].message });
        }

        const { recipient, amount, tokenTicker, tokenNonce, walletPem } = req.body;

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
router.post('/freeNftMintAirdrop', transactions.handleUsageFee, async (req, res) => {
    try {
        const { error } = schemas.freeNftMintAirdrop.validate(req.body);
        if (error) {
            console.error('Validation error in freeNftMintAirdrop:', error.details[0].message);
            return res.status(400).json({ error: error.details[0].message });
        }

        const { scAddress, endpoint, receiver, qty, walletPem } = req.body;

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

router.post('/distributeRewardsToNftOwners', transactions.handleUsageFee, async (req, res) => {
    try {
        const { error } = schemas.distributeRewards.validate(req.body);
        if (error) return res.status(400).json({ error: error.details[0].message });
        const { uniqueOwnerStats, tokenTicker, baseAmount, multiply, walletPem } = req.body;
        const results = await transactions.distributeRewardsToNftOwners(walletPem, uniqueOwnerStats, tokenTicker, baseAmount, multiply);
        res.json({ message: "Rewards distribution completed successfully.", usageFeeHash: req.usageFeeHash, results });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
