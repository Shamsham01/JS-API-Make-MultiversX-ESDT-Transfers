const express = require('express');
const transactions = require('./utils/transactions');
const { Address, Token, TokenTransfer, TransferTransactionsFactory, TransactionsFactoryConfig, Transaction, TransactionPayload } = require('@multiversx/sdk-core');
const { ProxyNetworkProvider } = require('@multiversx/sdk-network-providers');
const { UserSigner } = require('@multiversx/sdk-wallet');
const { getTokenDecimals, convertAmountToBlockchainValue } = require('./utils/tokens');
const { checkTransactionStatus } = require('./utils/transactions');
const { isWhitelisted } = require('./utils/whitelist');


const router = express.Router();

// Constants
const provider = new ProxyNetworkProvider("https://gateway.multiversx.com", { clientName: "javascript-api" });
const TREASURY_WALLET = "erd158k2c3aserjmwnyxzpln24xukl2fsvlk9x46xae4dxl5xds79g6sdz37qn"; // Treasury wallet
const USAGE_FEE = 100; // Fee in REWARD tokens
const REWARD_TOKEN = "REWARD-cf6eac"; // Token identifier
const CHAIN_ID = process.env.CHAIN_ID || "1"; // Retrieve from environment variables, default to Mainnet

// Middleware to handle the usage fee
const handleUsageFee = async (req, res, next) => {
    try {
        const pemContent = req.body.walletPem;
        const signer = UserSigner.fromPem(pemContent);
        const walletAddress = signer.getAddress().toString();

        if (isWhitelisted(walletAddress)) {
            console.log(`Wallet ${walletAddress} is whitelisted. Skipping usage fee.`);
            next();
            return;
        }

        const decimals = await getTokenDecimals(REWARD_TOKEN);
        const amount = convertAmountToBlockchainValue(USAGE_FEE, decimals);

        const accountOnNetwork = await provider.getAccount(signer.getAddress());
        const factoryConfig = new TransactionsFactoryConfig({ chainID: CHAIN_ID });
        const factory = new TransferTransactionsFactory({ config: factoryConfig });

        const tx = factory.createTransactionForESDTTokenTransfer({
            sender: signer.getAddress(),
            receiver: new Address(TREASURY_WALLET),
            tokenTransfers: [
                new TokenTransfer({
                    token: new Token({ identifier: REWARD_TOKEN }),
                    amount: BigInt(amount),
                }),
            ],
        });

        tx.nonce = accountOnNetwork.nonce;
        tx.gasLimit = BigInt(500000);

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);
        const status = await checkTransactionStatus(txHash.toString());

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

// 1. EGLD Transfer
router.post('/egldTransfer', handleUsageFee, async (req, res) => {
    try {
        const { recipient, amount } = req.body;
        const pemContent = req.body.walletPem;

        const signer = UserSigner.fromPem(pemContent);
        const accountOnNetwork = await provider.getAccount(signer.getAddress());
        const receiverAddress = new Address(recipient);

        const tx = new Transaction({
            nonce: accountOnNetwork.nonce,
            sender: signer.getAddress(),
            receiver: receiverAddress,
            value: BigInt(new BigNumber(amount).multipliedBy(new BigNumber(10).pow(18)).toFixed(0)),
            gasLimit: BigInt(50000),
            data: new TransactionPayload(""),
            chainID: CHAIN_ID,
        });

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);
        const result = await checkTransactionStatus(txHash.toString());

        res.json({ message: "EGLD transfer executed successfully.", usageFeeHash: req.usageFeeHash, result });
    } catch (error) {
        console.error('Error executing EGLD transaction:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 2. ESDT Transfer
router.post('/esdtTransfer', handleUsageFee, async (req, res) => {
    try {
        const { recipient, amount, tokenTicker } = req.body;
        const pemContent = req.body.walletPem;

        const signer = UserSigner.fromPem(pemContent);
        const decimals = await getTokenDecimals(tokenTicker);
        const adjustedAmount = convertAmountToBlockchainValue(amount, decimals);

        const accountOnNetwork = await provider.getAccount(signer.getAddress());
        const factoryConfig = new TransactionsFactoryConfig({ chainID: CHAIN_ID });
        const factory = new TransferTransactionsFactory({ config: factoryConfig });

        const tx = factory.createTransactionForESDTTokenTransfer({
            sender: signer.getAddress(),
            receiver: new Address(recipient),
            tokenTransfers: [
                new TokenTransfer({
                    token: new Token({ identifier: tokenTicker }),
                    amount: BigInt(adjustedAmount),
                }),
            ],
        });

        tx.nonce = accountOnNetwork.nonce;
        tx.gasLimit = BigInt(500000);

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);
        const result = await checkTransactionStatus(txHash.toString());

        res.json({ message: "ESDT transfer executed successfully.", usageFeeHash: req.usageFeeHash, result });
    } catch (error) {
        console.error('Error executing ESDT transaction:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 3. NFT Transfer
router.post('/nftTransfer', handleUsageFee, async (req, res) => {
    try {
        const { recipient, tokenIdentifier, tokenNonce } = req.body;
        const pemContent = req.body.walletPem;

        if (!recipient || !tokenIdentifier || tokenNonce === undefined) {
            return res.status(400).json({ error: 'Missing required parameters: recipient, tokenIdentifier, tokenNonce.' });
        }

        const result = await transactions.sendNftToken(pemContent, recipient, tokenIdentifier, tokenNonce);

        res.json({ message: "NFT transfer executed successfully.", usageFeeHash: req.usageFeeHash, result });
    } catch (error) {
        console.error('Error executing NFT transfer:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 4. SFT Transfer
router.post('/sftTransfer', handleUsageFee, async (req, res) => {
    try {
        const { recipient, amount, tokenTicker, tokenNonce } = req.body;
        const pemContent = req.body.walletPem;

        if (!recipient || !amount || !tokenTicker || tokenNonce === undefined) {
            return res.status(400).json({ error: 'Missing required parameters: recipient, amount, tokenTicker, tokenNonce.' });
        }

        const result = await transactions.sendSftToken(pemContent, recipient, amount, tokenTicker, tokenNonce);

        res.json({ message: "SFT transfer executed successfully.", usageFeeHash: req.usageFeeHash, result });
    } catch (error) {
        console.error('Error executing SFT transfer:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 5. Free NFT Mint Airdrop
router.post('/freeNftMintAirdrop', handleUsageFee, async (req, res) => {
    try {
        const { scAddress, endpoint, receiver, qty } = req.body;
        const pemContent = req.body.walletPem;

        if (!scAddress || !endpoint || !receiver || qty === undefined) {
            return res.status(400).json({ error: 'Missing required parameters: scAddress, endpoint, receiver, qty.' });
        }

        const result = await transactions.executeFreeNftMintAirdrop(pemContent, scAddress, endpoint, receiver, qty);

        res.json({ message: "Free NFT mint airdrop executed successfully.", usageFeeHash: req.usageFeeHash, result });
    } catch (error) {
        console.error('Error executing Free NFT Mint Airdrop:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 6. ESDT Airdrop to NFT Owners
router.post('/distributeRewardsToNftOwners', handleUsageFee, async (req, res) => {
    try {
        const { uniqueOwnerStats, tokenTicker, baseAmount, multiply } = req.body;
        const pemContent = req.body.walletPem;

        if (!uniqueOwnerStats || !Array.isArray(uniqueOwnerStats)) {
            return res.status(400).json({ error: 'Invalid owner stats provided.' });
        }
        if (!tokenTicker || !baseAmount) {
            return res.status(400).json({ error: 'Token ticker and base amount are required.' });
        }

        const result = await transactions.distributeRewardsToNftOwners(pemContent, uniqueOwnerStats, tokenTicker, baseAmount, multiply);

        res.json({ message: 'Rewards distribution completed.', usageFeeHash: req.usageFeeHash, results: result });
    } catch (error) {
        console.error('Error during rewards distribution:', error.message);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
