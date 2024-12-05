const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { Address, Token, TokenTransfer, TransferTransactionsFactory, TransactionsFactoryConfig, Transaction, TransactionPayload, UserSigner } = require('@multiversx/sdk-core');
const { ApiNetworkProvider } = require('@multiversx/sdk-network-providers');
const BigNumber = require('bignumber.js');

// Constants
const app = express();
const PORT = process.env.PORT || 10000;
const SECURE_TOKEN = process.env.SECURE_TOKEN;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const USAGE_FEE = 100;
const REWARD_TOKEN = "REWARD-cf6eac";
const TREASURY_WALLET = "erd158k2c3aserjmwnyxzpln24xukl2fsvlk9x46xae4dxl5xds79g6sdz37qn";
const WEBHOOK_WHITELIST_URL = "https://hook.eu2.make.com/mvi4kvg6arzxrxd5462f6nh2yqq1p5ot";
const provider = new ApiNetworkProvider("https://gateway.multiversx.com", { clientName: "multiversx-app" });

// Middleware for parsing JSON and URL-encoded data
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Utility Functions
const getTokenDecimals = async (tokenTicker) => {
    const apiUrl = `https://api.multiversx.com/tokens/${tokenTicker}`;
    const response = await fetch(apiUrl);
    if (!response.ok) {
        throw new Error(`Failed to fetch token info: ${response.statusText}`);
    }
    const tokenInfo = await response.json();
    return tokenInfo.decimals || 0;
};

const getPemContent = (req) => {
    console.log('Request Body:', req.body);
    const pemContent = req.body.walletPem;
    if (!pemContent || typeof pemContent !== 'string' || !pemContent.includes('-----BEGIN PRIVATE KEY-----')) {
        throw new Error('Invalid PEM content');
    }
    return pemContent;
};

const deriveWalletAddressFromPem = (pemContent) => {
    const signer = UserSigner.fromPem(pemContent);
    return signer.getAddress().bech32();
};

const convertAmountToBlockchainValue = (amount, decimals) => {
    const factor = new BigNumber(10).pow(decimals);
    return new BigNumber(amount).multipliedBy(factor).toFixed(0);
};

const calculateEsdtGasLimit = () => BigInt(500000);

// Middleware
const checkToken = (req, res, next) => {
    const token = req.headers.authorization;
    if (token === `Bearer ${SECURE_TOKEN}`) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

const checkAdminToken = (req, res, next) => {
    const token = req.headers.authorization;
    if (token === `Bearer ${ADMIN_TOKEN}`) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized: Invalid Admin Token' });
    }
};

// Middleware to validate and sanitize the ESDT transfer request body
const validateEsdtTransferRequest = (req, res, next) => {
    const { recipient, amount, tokenTicker } = req.body;

    if (!recipient || !amount || !tokenTicker) {
        return res.status(400).json({
            error: 'Invalid request. Required fields: recipient, amount, tokenTicker.',
        });
    }

    if (isNaN(amount) || amount <= 0) {
        return res.status(400).json({
            error: 'Invalid amount. Must be a positive number.',
        });
    }

    console.log(`Validated ESDT transfer request: ${JSON.stringify(req.body)}`);
    next();
};



const handleUsageFee = async (req, res, next) => {
    try {
        const pemContent = getPemContent(req); // Validate and retrieve PEM content
        const walletAddress = deriveWalletAddressFromPem(pemContent); // Derive wallet address from PEM

        console.log(`Processing usage fee for wallet: ${walletAddress}`);

        if (isWhitelisted(walletAddress)) {
            console.log(`Wallet ${walletAddress} is whitelisted. Skipping usage fee.`);
            next(); // Skip the usage fee if whitelisted
            return;
        }

        // Send the usage fee in REWARD tokens
        const txHash = await sendUsageFee(pemContent);
        req.usageFeeHash = txHash; // Attach transaction hash to the request
        console.log(`Usage fee processed. Transaction hash: ${req.usageFeeHash}`);
        next(); // Proceed to the next middleware or route handler
    } catch (error) {
        console.error('Error processing usage fee:', error.message);
        res.status(400).json({ error: error.message });
    }
};


// Utility function to send usage fee
const sendUsageFee = async (pemContent) => {
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();
    const receiverAddress = new Address(TREASURY_WALLET);

    const accountOnNetwork = await provider.getAccount(senderAddress);
    const nonce = accountOnNetwork.nonce;

    const decimals = await getTokenDecimals(REWARD_TOKEN);
    const convertedAmount = convertAmountToBlockchainValue(USAGE_FEE, decimals);

    const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
    const factory = new TransferTransactionsFactory({ config: factoryConfig });

    const tx = factory.createTransactionForESDTTokenTransfer({
        sender: senderAddress,
        receiver: receiverAddress,
        tokenTransfers: [TokenTransfer.fungibleFromBigInt(REWARD_TOKEN, BigInt(convertedAmount))],
    });

    tx.nonce = nonce;
    tx.gasLimit = calculateEsdtGasLimit();

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);

    // Wait for transaction confirmation
    const status = await checkTransactionStatus(txHash.toString());
    if (status.status !== "success") {
        throw new Error('Usage fee transaction failed. Ensure sufficient REWARD tokens are available.');
    }
    return txHash.toString();
};


const validateRequestBody = (requiredFields) => (req, res, next) => {
    const body = req.body || {};
    const missingFields = requiredFields.filter((field) => !body[field]);
    if (missingFields.length > 0) {
        return res.status(400).json({ error: `Missing required fields: ${missingFields.join(', ')}` });
    }
    next();
};

// Whitelist Management
const whitelistFilePath = path.join(__dirname, 'whitelist.json');
const loadWhitelist = () => {
    if (!fs.existsSync(whitelistFilePath)) {
        fs.writeFileSync(whitelistFilePath, JSON.stringify([], null, 2));
    }
    return JSON.parse(fs.readFileSync(whitelistFilePath));
};

const saveWhitelist = (whitelist) => {
    fs.writeFileSync(whitelistFilePath, JSON.stringify(whitelist, null, 2));
};

const isWhitelisted = (walletAddress) => loadWhitelist().some(entry => entry.walletAddress === walletAddress);

const sendWebhookUpdate = async (whitelist) => {
    try {
        const response = await fetch(WEBHOOK_WHITELIST_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: "Updated whitelist via API", content: Buffer.from(JSON.stringify(whitelist)).toString('base64') }),
        });
        if (!response.ok) throw new Error(`Webhook failed with status ${response.status}`);
        console.log('Webhook update sent successfully');
    } catch (error) {
        console.error('Webhook update error:', error.message);
        throw error;
    }
};

// Whitelist Management Endpoints
app.post('/admin/addToWhitelist', checkAdminToken, validateRequestBody(['walletAddress', 'label', 'whitelistStart']), async (req, res) => {
    try {
        const { walletAddress, label, whitelistStart } = req.body;

        const whitelist = loadWhitelist();
        if (whitelist.some(entry => entry.walletAddress === walletAddress)) {
            return res.status(400).json({ error: 'Wallet address is already whitelisted.' });
        }

        // Add new entry to the whitelist
        const newEntry = { walletAddress, label, whitelistStart };
        whitelist.push(newEntry);
        saveWhitelist(whitelist);

        // Trigger webhook with updated whitelist
        await sendWebhookUpdate(whitelist);

        res.json({ message: 'Wallet added to whitelist and webhook triggered successfully.' });
    } catch (error) {
        console.error('Error adding to whitelist:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.delete('/admin/removeFromWhitelist', checkAdminToken, validateRequestBody(['walletAddress']), async (req, res) => {
    try {
        const { walletAddress } = req.body;

        const whitelist = loadWhitelist();
        const updatedWhitelist = whitelist.filter(entry => entry.walletAddress !== walletAddress);

        if (whitelist.length === updatedWhitelist.length) {
            return res.status(404).json({ error: 'Wallet address not found in whitelist.' });
        }

        saveWhitelist(updatedWhitelist);

        // Trigger webhook with updated whitelist
        await sendWebhookUpdate(updatedWhitelist);

        res.json({ message: 'Wallet removed from whitelist and webhook triggered successfully.' });
    } catch (error) {
        console.error('Error removing from whitelist:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/admin/getWhitelist', checkAdminToken, (req, res) => {
    try {
        const whitelist = loadWhitelist();
        res.json({ whitelist });
    } catch (error) {
        console.error('Error fetching whitelist:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// User Activity Logging and Authorization Endpoints

// Route for wallet authorization
app.post('/execute/authorize', checkToken, validateRequestBody(['walletPem']), (req, res) => {
    try {
        const pemContent = getPemContent(req);
        const walletAddress = deriveWalletAddressFromPem(pemContent);

        // Log the user activity
        logUserActivity(walletAddress);

        res.json({ message: "Authorization Successful", walletAddress });
    } catch (error) {
        console.error('Error in authorization:', error.message);
        res.status(400).json({ error: error.message });
    }
});

// Utility to log user activity
const logUserActivity = (walletAddress) => {
    const currentDate = new Date().toISOString();

    let usersData = [];
    if (fs.existsSync(usersFilePath)) {
        const rawData = fs.readFileSync(usersFilePath);
        usersData = JSON.parse(rawData);
    }

    usersData.push({ walletAddress, authorizedAt: currentDate });

    fs.writeFileSync(usersFilePath, JSON.stringify(usersData, null, 2));
    console.log(`User activity logged: ${walletAddress} at ${currentDate}`);
};

// File path for storing user activity logs
const usersFilePath = path.join(__dirname, 'users.json');


// --------------- Transaction Confirmation Logic (Polling) --------------- //

const checkTransactionStatus = async (txHash, retries = 20, delay = 4000) => {
    const txStatusUrl = `https://api.multiversx.com/transactions/${txHash}`;

    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(txStatusUrl);

            if (!response.ok) {
                console.warn(`Non-200 response for ${txHash}: ${response.status}`);
                throw new Error(`HTTP error ${response.status}`);
            }

            const txStatus = await response.json();

            if (txStatus.status === "success") {
                return { status: "success", txHash };
            } else if (txStatus.status === "fail") {
                return { status: "fail", txHash };
            }

            console.log(`Transaction ${txHash} still pending, retrying...`);
        } catch (error) {
            console.error(`Error fetching transaction ${txHash}: ${error.message}`);
        }

        await new Promise(resolve => setTimeout(resolve, delay));
    }

    throw new Error(`Transaction ${txHash} status could not be determined after ${retries} retries.`);
};

// --------------- Gas Calculation Functions --------------- //

// Utility to calculate total gas limit for NFTs/scCalls
const calculateNftGasLimit = (qty) => 15000000 * qty;

// Utility to calculate total gas limit for SFTs
const calculateSftGasLimit = (qty) => 500000 * qty;

// Utility to convert EGLD to WEI (1 EGLD = 10^18 WEI)
const convertEGLDToWEI = (amount) => {
    return new BigNumber(amount).multipliedBy(new BigNumber(10).pow(18)).toFixed(0);
};

// --------------- EGLD Transfer Logic --------------- //

const sendEgld = async (pemContent, recipient, amount) => {
    try {
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        const accountOnNetwork = await provider.getAccount(senderAddress);
        const senderNonce = accountOnNetwork.nonce;

        const amountInWEI = convertEGLDToWEI(amount);

        const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
        const factory = new TransferTransactionsFactory({ config: factoryConfig });

        const tx = factory.createTransactionForNativeTokenTransfer({
            sender: senderAddress,
            receiver: receiverAddress,
            nativeAmount: BigInt(amountInWEI)
        });

        tx.nonce = senderNonce;
        tx.gasLimit = 50000n;

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        // Poll for transaction confirmation
        const finalStatus = await checkTransactionStatus(txHash.toString());
        return finalStatus;
    } catch (error) {
        console.error('Error sending EGLD transaction:', error.message);
        throw new Error('Transaction failed: ' + error.message);
    }
};

// Route for EGLD transfers
app.post('/execute/egldTransfer', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { recipient, amount } = req.body;
        const pemContent = getPemContent(req);

        const result = await sendEgld(pemContent, recipient, amount);
        res.json({ result, usageFeeHash: req.usageFeeHash });
    } catch (error) {
        console.error('Error executing EGLD transfer:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// --------------- ESDT Transfer Logic --------------- //

const sendEsdtToken = async (pemContent, recipient, amount, tokenTicker) => {
    try {
        // Validate the UserSigner import and PEM content
        if (!UserSigner || typeof UserSigner.fromPem !== 'function') {
            throw new Error('UserSigner is not properly imported or initialized.');
        }

        const signer = UserSigner.fromPem(pemContent);
        if (!signer) {
            throw new Error('Failed to initialize UserSigner from PEM content.');
        }

        // Derive sender address
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);
        console.log(`Sender Address: ${senderAddress.bech32()}, Recipient Address: ${receiverAddress.bech32()}`);

        // Fetch sender account information from the network
        const accountOnNetwork = await provider.getAccount(senderAddress);
        const nonce = accountOnNetwork.nonce;
        console.log(`Sender Nonce: ${nonce}`);

        // Fetch token decimals and calculate the amount to transfer
        const decimals = await getTokenDecimals(tokenTicker);
        const convertedAmount = convertAmountToBlockchainValue(amount, decimals);
        console.log(`Token Decimals: ${decimals}, Converted Amount: ${convertedAmount}`);

        // Configure the transaction factory
        const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
        const factory = new TransferTransactionsFactory({ config: factoryConfig });

        // Create token transfer object
        const tokenTransfer = TokenTransfer.fungibleFromBigInt(tokenTicker, BigInt(convertedAmount));

        // Create ESDT transfer transaction
        const tx = factory.createTransactionForESDTTokenTransfer({
            sender: senderAddress,
            receiver: receiverAddress,
            tokenTransfers: [tokenTransfer],
        });

        // Set nonce and gas limit for the transaction
        tx.nonce = nonce;
        tx.gasLimit = calculateEsdtGasLimit();
        console.log(`Transaction Gas Limit: ${tx.gasLimit}`);

        // Sign and send the transaction
        await signer.sign(tx);
        console.log('Transaction signed successfully.');

        const txHash = await provider.sendTransaction(tx);
        console.log(`Transaction sent successfully. TX Hash: ${txHash}`);

        // Poll for transaction confirmation
        const finalStatus = await checkTransactionStatus(txHash.toString());
        console.log(`Transaction Status: ${finalStatus.status}`);
        return finalStatus;
    } catch (error) {
        console.error('Error in sendEsdtToken:', error.message);
        throw new Error('Transaction failed: ' + error.message);
    }
};

// Route for ESDT transfers
app.post('/execute/esdtTransfer', checkToken, validateRequestBody(['walletPem', 'recipient', 'amount', 'tokenTicker']), async (req, res) => {
    try {
        const { recipient, amount, tokenTicker } = req.body;
        const pemContent = getPemContent(req);

        const result = await sendEsdtToken(pemContent, recipient, amount, tokenTicker);
        res.json({ message: "ESDT transfer executed successfully.", result });
    } catch (error) {
        console.error('Error executing ESDT transfer:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// --------------- NFT Transfer Logic --------------- //

const sendNftToken = async (pemContent, recipient, tokenIdentifier, tokenNonce) => {
    try {
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        const accountOnNetwork = await provider.getAccount(senderAddress);
        const senderNonce = accountOnNetwork.nonce;

        const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
        const factory = new TransferTransactionsFactory({ config: factoryConfig });

        // Create transaction for NFT transfer
        const tx = factory.createTransactionForESDTNFTTransfer({
            sender: senderAddress,
            receiver: receiverAddress,
            token: new Token({
                identifier: tokenIdentifier,
                nonce: BigInt(tokenNonce),
            }),
            amount: BigInt(1), // NFTs typically have a quantity of 1
        });

        tx.nonce = senderNonce;
        tx.gasLimit = BigInt(calculateNftGasLimit(1)); // Default gas for single NFT

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        // Poll for transaction confirmation
        const finalStatus = await checkTransactionStatus(txHash.toString());
        return finalStatus;
    } catch (error) {
        console.error('Error sending NFT transaction:', error.message);
        throw new Error('Transaction failed: ' + error.message);
    }
};

// Route for NFT transfers
app.post('/execute/nftTransfer', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { recipient, tokenIdentifier, tokenNonce } = req.body;
        const pemContent = getPemContent(req);

        const result = await sendNftToken(pemContent, recipient, tokenIdentifier, tokenNonce);
        res.json({ result, usageFeeHash: req.usageFeeHash });
    } catch (error) {
        console.error('Error executing NFT transfer:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// --------------- SFT Transfer Logic --------------- //

const sendSftToken = async (pemContent, recipient, amount, tokenTicker, tokenNonce) => {
    try {
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        const accountOnNetwork = await provider.getAccount(senderAddress);
        const senderNonce = accountOnNetwork.nonce;

        const adjustedAmount = BigInt(amount); // SFTs usually have 0 decimals

        const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
        const factory = new TransferTransactionsFactory({ config: factoryConfig });

        // Create transaction for SFT transfer
        const tx = factory.createTransactionForESDTNFTTransfer({
            sender: senderAddress,
            receiver: receiverAddress,
            token: new Token({
                identifier: tokenTicker,
                nonce: BigInt(tokenNonce),
            }),
            amount: adjustedAmount,
        });

        tx.nonce = senderNonce;
        tx.gasLimit = BigInt(calculateSftGasLimit(amount)); // Calculate gas limit dynamically

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        // Poll for transaction confirmation
        const finalStatus = await checkTransactionStatus(txHash.toString());
        return finalStatus;
    } catch (error) {
        console.error('Error sending SFT transaction:', error.message);
        throw new Error('Transaction failed: ' + error.message);
    }
};

// Route for SFT transfers
app.post('/execute/sftTransfer', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { recipient, amount, tokenTicker, tokenNonce } = req.body;
        const pemContent = getPemContent(req);

        const result = await sendSftToken(pemContent, recipient, amount, tokenTicker, tokenNonce);
        res.json({ result, usageFeeHash: req.usageFeeHash });
    } catch (error) {
        console.error('Error executing SFT transfer:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// --------------- Free NFT Mint Airdrop Logic --------------- //

const executeFreeNftMintAirdrop = async (pemContent, scAddress, endpoint, receiver, qty) => {
    try {
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();

        const receiverAddress = new Address(receiver);
        const receiverHex = receiverAddress.hex();
        const qtyHex = BigInt(qty).toString(16).padStart(2, '0');
        const dataField = `${endpoint}@${receiverHex}@${qtyHex}`;

        const gasLimit = BigInt(17000000); // Default gas limit for smart contract interactions
        const accountOnNetwork = await provider.getAccount(senderAddress);
        const senderNonce = accountOnNetwork.nonce;

        const tx = new Transaction({
            nonce: senderNonce,
            receiver: new Address(scAddress),
            sender: senderAddress,
            value: '0', // No EGLD value for mint
            gasLimit: gasLimit,
            data: new TransactionPayload(dataField),
            chainID: '1',
        });

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        // Poll for transaction confirmation
        const finalStatus = await checkTransactionStatus(txHash.toString());
        return finalStatus;
    } catch (error) {
        console.error('Error executing free NFT mint airdrop:', error.message);
        throw new Error('Transaction failed: ' + error.message);
    }
};

// Route for Free NFT Mint Airdrop
app.post('/execute/freeNftMintAirdrop', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { scAddress, endpoint, receiver, qty } = req.body;
        const pemContent = getPemContent(req);

        const result = await executeFreeNftMintAirdrop(pemContent, scAddress, endpoint, receiver, qty);
        res.json({ result, usageFeeHash: req.usageFeeHash });
    } catch (error) {
        console.error('Error executing free NFT mint airdrop:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// --------------- Distribute Rewards to NFT Owners Logic --------------- //

const distributeRewardsToNftOwners = async (pemContent, uniqueOwnerStats, tokenTicker, baseAmount, multiplierEnabled) => {
    try {
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();

        const accountOnNetwork = await provider.getAccount(senderAddress);
        let currentNonce = accountOnNetwork.nonce;

        const decimals = await getTokenDecimals(tokenTicker);
        const txHashes = [];

        const createTransaction = (owner, tokensCount, nonce) => {
            const adjustedAmount = multiplierEnabled
                ? convertAmountToBlockchainValue(baseAmount * tokensCount, decimals)
                : convertAmountToBlockchainValue(baseAmount, decimals);

            const receiverAddress = new Address(owner);
            const tokenTransfer = TokenTransfer.fungibleFromBigInt(tokenTicker, BigInt(adjustedAmount));

            const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
            const factory = new TransferTransactionsFactory({ config: factoryConfig });

            const tx = factory.createTransactionForESDTTokenTransfer({
                sender: senderAddress,
                receiver: receiverAddress,
                tokenTransfers: [tokenTransfer],
            });

            tx.nonce = nonce;
            tx.gasLimit = calculateEsdtGasLimit();

            return tx;
        };

        // Sign and send all transactions in parallel batches
        for (let i = 0; i < uniqueOwnerStats.length; i += 3) {
            const batch = uniqueOwnerStats.slice(i, i + 3);
            const batchPromises = batch.map((ownerData, index) => {
                const tx = createTransaction(
                    ownerData.owner,
                    ownerData.tokensCount,
                    currentNonce + index
                );

                return signer.sign(tx).then(async () => {
                    const txHash = await provider.sendTransaction(tx);
                    return { owner: ownerData.owner, txHash: txHash.toString() };
                }).catch(error => ({
                    owner: ownerData.owner,
                    error: error.message,
                    status: "failed",
                }));
            });

            const batchResults = await Promise.all(batchPromises);
            txHashes.push(...batchResults);

            if (i + 3 < uniqueOwnerStats.length) {
                await new Promise(resolve => setTimeout(resolve, 1000)); // Throttle batch processing
            }
        }

        return txHashes;
    } catch (error) {
        console.error('Error during reward distribution:', error.message);
        throw new Error('Reward distribution failed: ' + error.message);
    }
};

// Route for Distributing Rewards to NFT Owners
app.post('/execute/distributeRewardsToNftOwners', checkToken, handleUsageFee, async (req, res) => {
    try {
        const pemContent = getPemContent(req);
        const { uniqueOwnerStats, tokenTicker, baseAmount, multiply } = req.body;

        if (!uniqueOwnerStats || !Array.isArray(uniqueOwnerStats)) {
            return res.status(400).json({ error: 'Invalid owner stats provided.' });
        }
        if (!tokenTicker || !baseAmount) {
            return res.status(400).json({ error: 'Token ticker and base amount are required.' });
        }

        const multiplierEnabled = multiply === "yes";
        const txHashes = await distributeRewardsToNftOwners(
            pemContent,
            uniqueOwnerStats,
            tokenTicker,
            baseAmount,
            multiplierEnabled
        );

        const statusPromises = txHashes.map(({ owner, txHash }) =>
            checkTransactionStatus(txHash)
                .then(status => ({ owner, txHash, status: status.status }))
                .catch(error => ({ owner, txHash, error: error.message, status: 'failed' }))
        );
        const statusResults = await Promise.all(statusPromises);

        res.json({
            message: 'Rewards distribution completed.',
            usageFeeHash: req.usageFeeHash,
            results: statusResults,
        });
    } catch (error) {
        console.error('Error during rewards distribution:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Start the Express server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
