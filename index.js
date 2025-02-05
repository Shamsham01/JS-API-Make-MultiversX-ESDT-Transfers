const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const { Address, Token, TokenTransfer, TransferTransactionsFactory, TransactionsFactoryConfig, Transaction, TransactionPayload } = require('@multiversx/sdk-core');
const { ProxyNetworkProvider } = require('@multiversx/sdk-network-providers');
const { UserSigner } = require('@multiversx/sdk-wallet');
const BigNumber = require('bignumber.js');
const app = express();
const PORT = process.env.PORT || 10000;
const SECURE_TOKEN = process.env.SECURE_TOKEN;  // Secure Token for authorization
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;  // Admin Token for whitelist management
const USAGE_FEE = 500; // Fee in REWARD tokens
const REWARD_TOKEN = "REWARD-cf6eac"; // Token identifier
const TREASURY_WALLET = "erd158k2c3aserjmwnyxzpln24xukl2fsvlk9x46xae4dxl5xds79g6sdz37qn"; // Treasury wallet
const WEBHOOK_WHITELIST_URL = "https://hook.eu2.make.com/mvi4kvg6arzxrxd5462f6nh2yqq1p5ot"; // Your Make webhook URL
const adminRoutes = require('./admin');

// Set up the network provider for MultiversX (mainnet or devnet)
const provider = new ProxyNetworkProvider("https://gateway.multiversx.com", { clientName: "javascript-api" });
// Helper function to wait for a specified time
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const fs = require('fs');
const path = require('path');

const whitelistFilePath = path.join(__dirname, 'whitelist.json');

// Middleware to check admin authorization token
const checkAdminToken = (req, res, next) => {
    const token = req.headers.authorization;
    if (token === `Bearer ${ADMIN_TOKEN}`) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized: Invalid Admin Token' });
    }
};


// Load the whitelist file
const loadWhitelist = () => {
    if (!fs.existsSync(whitelistFilePath)) {
        fs.writeFileSync(whitelistFilePath, JSON.stringify([], null, 2));
    }
    const data = fs.readFileSync(whitelistFilePath);
    return JSON.parse(data);
};

// Check if a wallet is whitelisted
const isWhitelisted = (walletAddress) => {
    const whitelist = loadWhitelist();
    return whitelist.some(entry => entry.walletAddress === walletAddress);
};

const saveWhitelist = (whitelist) => {
    fs.writeFileSync(whitelistFilePath, JSON.stringify(whitelist, null, 2)); // Proper formatting with indentation
};

const sendWebhookUpdate = async (whitelist) => {
    try {
        const encodedContent = Buffer.from(JSON.stringify(whitelist)).toString('base64');
        const response = await fetch(WEBHOOK_WHITELIST_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: "Updated whitelist via API",
                content: encodedContent
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || 'Failed to send webhook update');
        }

        console.log('Webhook update sent successfully');
        return true;
    } catch (error) {
        console.error('Error sending webhook update:', error.message);
        throw error;
    }
};


app.use(bodyParser.json());  // Support JSON-encoded bodies

// Middleware to check authorization token
const checkToken = (req, res, next) => {
    const token = req.headers.authorization;
    if (token === `Bearer ${SECURE_TOKEN}`) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

// Function to validate and return the PEM content from the request body
const getPemContent = (req) => {
    const pemContent = req.body.walletPem;
    if (!pemContent || typeof pemContent !== 'string' || !pemContent.includes('-----BEGIN PRIVATE KEY-----')) {
        throw new Error('Invalid PEM content');
    }
    return pemContent;
};

// Helper to derive wallet address from PEM
const deriveWalletAddressFromPem = (pemContent) => {
    const signer = UserSigner.fromPem(pemContent);
    return signer.getAddress().toString();
};

// Helper function to check transaction status
const checkTransactionStatus = async (txHash, retries = 40, delay = 5000) => {
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

        await wait(delay);
    }

    throw new Error(
        `Transaction ${txHash} status could not be determined after ${retries} retries.`
    );
};

// Helper function to poll transaction statuses with retries
const pollTransactionStatuses = async (txHashes, batchSize = 10, delay = 10000, maxRetries = 10) => {
    const results = [];
    const pendingTransactions = [...txHashes]; // Copy of all transaction hashes

    // Wait 7 seconds before starting to poll (to account for block time)
    await wait(7000);

    let retryCount = 0;
    while (pendingTransactions.length > 0 && retryCount < maxRetries) {
        const batch = pendingTransactions.splice(0, batchSize); // Take the next batch
        const batchPromises = batch.map(async ({ owner, txHash }) => {
            try {
                const status = await checkTransactionStatus(txHash);
                if (status.status === "success" || status.status === "fail") {
                    return { owner, txHash, status: status.status };
                } else {
                    // Transaction is still pending, add it back to the list
                    pendingTransactions.push({ owner, txHash });
                    return null; // Skip this result for now
                }
            } catch (error) {
                return { owner, txHash, error: error.message, status: 'failed' };
            }
        });

        // Process the current batch
        const batchResults = await Promise.all(batchPromises);
        const completedResults = batchResults.filter(result => result !== null); // Filter out pending transactions
        results.push(...completedResults);

        // If there are still pending transactions, wait before the next batch
        if (pendingTransactions.length > 0) {
            await wait(delay); // Wait 10 seconds before the next batch
            retryCount++;
        }
    }

    // Handle any remaining pending transactions after max retries
    if (pendingTransactions.length > 0) {
        pendingTransactions.forEach(({ owner, txHash }) => {
            results.push({ owner, txHash, error: 'Max retries reached', status: 'pending' });
        });
    }

    return results;
};


// --------------- Gas Calculation Functions --------------- //

// Function to calculate total gas limit for NFTs/scCalls (15,000,000 gas per asset)
const calculateNftGasLimit = (qty) => {
    return 15000000 * qty;
};

// Function to calculate total gas limit for SFTs (500,000 gas per asset)
const calculateSftGasLimit = (qty) => {
    return 500000 * qty;
};

// Function to calculate gas limit for ESDT transfers
const calculateEsdtGasLimit = () => {
    return BigInt(500000);  // Base gas per ESDT transaction
};

// --------------- Authorization Endpoint --------------- //
const usersFilePath = path.join(__dirname, 'users.json');

// Helper to log user activity
const logUserActivity = (walletAddress) => {
    const currentDate = new Date().toISOString();

    // Load existing users
    let usersData = [];
    if (fs.existsSync(usersFilePath)) {
        const rawData = fs.readFileSync(usersFilePath);
        usersData = JSON.parse(rawData);
    }

    // Append the new activity
    usersData.push({
        walletAddress: walletAddress,
        authorizedAt: currentDate,
    });

    // Save back to file
    fs.writeFileSync(usersFilePath, JSON.stringify(usersData, null, 2));
    console.log(`User activity logged: ${walletAddress} at ${currentDate}`);
};

// Update `/execute/authorize` endpoint
app.post('/execute/authorize', checkToken, (req, res) => {
    try {
        const pemContent = getPemContent(req);
        const walletAddress = deriveWalletAddressFromPem(pemContent);

        // Log the user activity
        logUserActivity(walletAddress);

        // Respond with a success message
        res.json({ message: "Authorization Successful", walletAddress });
    } catch (error) {
        console.error('Error in authorization:', error.message);
        res.status(400).json({ error: error.message });
    }
});

app.post('/admin/addToWhitelist', checkAdminToken, async (req, res) => {
    try {
        const { walletAddress, label, whitelistStart } = req.body;

        if (!walletAddress || !label || !whitelistStart) {
            return res.status(400).json({ error: 'Invalid data. walletAddress, label, and whitelistStart are required.' });
        }

        const whitelist = loadWhitelist();
        const existingWallet = whitelist.find(entry => entry.walletAddress === walletAddress);

        if (existingWallet) {
            return res.status(400).json({ error: 'Wallet address is already whitelisted.' });
        }

        // Add new entry to whitelist
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
        tokenTransfers: [
            new TokenTransfer({
                token: new Token({ identifier: REWARD_TOKEN }),
                amount: BigInt(convertedAmount),
            }),
        ],
    });

    tx.nonce = nonce;
    tx.gasLimit = BigInt(500000);

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);

    // Poll for transaction confirmation
    const status = await checkTransactionStatus(txHash.toString());
    if (status.status !== "success") {
        throw new Error('UsageFee transaction failed. Ensure sufficient REWARD tokens are available.');
    }
    return txHash.toString();
};

const handleUsageFee = async (req, res, next) => {
    try {
        const pemContent = getPemContent(req);
        const walletAddress = deriveWalletAddressFromPem(pemContent);

        // Check if the wallet is whitelisted
        if (isWhitelisted(walletAddress)) {
            console.log(`Wallet ${walletAddress} is whitelisted. Skipping usage fee.`);
            next(); // Skip the usage fee and proceed
            return;
        }

        const txHash = await sendUsageFee(pemContent);
        req.usageFeeHash = txHash; // Attach transaction hash to the request
        next();
    } catch (error) {
        console.error('Error processing UsageFee:', error.message);
        res.status(400).json({ error: error.message });
    }
};

// Function to convert EGLD to WEI (1 EGLD = 10^18 WEI)
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

        // Poll transaction status
        const finalStatus = await checkTransactionStatus(txHash.toString());
        return finalStatus;
    } catch (error) {
        console.error('Error sending EGLD transaction:', error);
        throw new Error('Transaction failed');
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
        console.error('Error executing EGLD transaction:', error);
        res.status(500).json({ error: error.message });
    }
});

// --------------- ESDT Transfer Logic --------------- //
const getTokenDecimals = async (tokenTicker) => {
    const apiUrl = `https://api.multiversx.com/tokens/${tokenTicker}`;
    const response = await fetch(apiUrl);
    if (!response.ok) {
        throw new Error(`Failed to fetch token info: ${response.statusText}`);
    }
    const tokenInfo = await response.json();
    return tokenInfo.decimals || 0;
};

const convertAmountToBlockchainValue = (amount, decimals) => {
    const factor = new BigNumber(10).pow(decimals);
    return new BigNumber(amount).multipliedBy(factor).toFixed(0);
};

const sendEsdtToken = async (pemContent, recipient, amount, tokenTicker) => {
    try {
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        const accountOnNetwork = await provider.getAccount(senderAddress);
        const nonce = accountOnNetwork.nonce;

        const decimals = await getTokenDecimals(tokenTicker);
        const convertedAmount = convertAmountToBlockchainValue(amount, decimals);

        const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
        const factory = new TransferTransactionsFactory({ config: factoryConfig });

        const tx = factory.createTransactionForESDTTokenTransfer({
            sender: senderAddress,
            receiver: receiverAddress,
            tokenTransfers: [
                new TokenTransfer({
                    token: new Token({ identifier: tokenTicker }),
                    amount: BigInt(convertedAmount)
                })
            ]
        });

        tx.nonce = nonce;
        tx.gasLimit = calculateEsdtGasLimit();

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        // Poll transaction status
        const finalStatus = await checkTransactionStatus(txHash.toString());
        return finalStatus;
    } catch (error) {
        console.error('Error sending ESDT transaction:', error);
        throw new Error('Transaction failed');
    }
};

// Route for ESDT transfers
app.post('/execute/esdtTransfer', checkToken, async (req, res) => {
    try {
        const { recipient, amount, tokenTicker } = req.body;
        const pemContent = getPemContent(req);

        // Derive the wallet address from the PEM content
        const deriveWalletAddressFromPem = (pemContent) => {
            const signer = UserSigner.fromPem(pemContent);
            return signer.getAddress().toString(); // Derive and return the wallet address
        };

        const walletAddress = deriveWalletAddressFromPem(pemContent);

        // Log the derived wallet address
        console.log(`Derived wallet address: ${walletAddress}`);

        // Perform the ESDT transfer
        const result = await sendEsdtToken(pemContent, recipient, amount, tokenTicker);

        // Return the result along with the derived wallet address
        res.json({
            message: "ESDT transfer executed successfully.",
            walletAddress: walletAddress, // Include the wallet address in the response
            result: result,
        });
    } catch (error) {
        console.error('Error executing ESDT transaction:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Function to handle Meta-ESDT transfers
const sendMetaEsdt = async (pemContent, recipient, tokenIdentifier, nonce, amount) => {
    try {
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        const accountOnNetwork = await provider.getAccount(senderAddress);
        const senderNonce = accountOnNetwork.nonce;

        const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
        const factory = new TransferTransactionsFactory({ config: factoryConfig });

        // Construct data payload for Meta-ESDT Transfer
        const dataField = `ESDTNFTTransfer@${Buffer.from(tokenIdentifier).toString('hex')}@${toHex(nonce)}@${toHex(amount)}`;

        // Create the transaction
        const tx = new Transaction({
            nonce: senderNonce,
            receiver: receiverAddress,
            sender: senderAddress,
            value: '0',
            gasLimit: BigInt(5000000), // Adjust gas limit if necessary
            data: new TransactionPayload(dataField),
            chainID: '1',
        });

        // Sign and send the transaction
        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        // Check the transaction status
        const finalStatus = await checkTransactionStatus(txHash.toString());
        return finalStatus;
    } catch (error) {
        console.error('Error sending Meta-ESDT transaction:', error);
        throw new Error('Transaction failed');
    }
};

// Route to handle Meta-ESDT transfers
app.post('/execute/metaEsdtTransfer', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { recipient, tokenIdentifier, nonce, amount } = req.body;
        const pemContent = getPemContent(req);

        // Execute the Meta-ESDT transfer
        const result = await sendMetaEsdt(pemContent, recipient, tokenIdentifier, nonce, amount);
         res.json({ result, usageFeeHash: req.usageFeeHash });
    } catch (error) {
        console.error('Error executing Meta-ESDT transaction:', error);
        res.status(500).json({ error: error.message });
    }
});


// --------------- NFT Transfer Logic --------------- //

// Function to validate amount before conversion to BigInt
const validateNumberInput = (value, fieldName) => {
    const numValue = Number(value);
    if (isNaN(numValue) || numValue <= 0) {
        throw new Error(`Invalid ${fieldName} provided. It must be a positive number.`);
    }
    return numValue;
};

// Function to send NFT tokens (no qty required, amount is always 1)
const sendNftToken = async (pemContent, recipient, tokenIdentifier, tokenNonce) => {
    try {
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        const accountOnNetwork = await provider.getAccount(senderAddress);
        const senderNonce = accountOnNetwork.nonce;

        const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
        const factory = new TransferTransactionsFactory({ config: factoryConfig });

        // Hardcode the amount to 1 for NFTs
        const amount = BigInt(1);

        // Calculate gas limit (no need for qty, so just set base gas limit)
        const gasLimit = BigInt(calculateNftGasLimit(1));  // Base gas limit for 1 NFT

        const tx = factory.createTransactionForESDTTokenTransfer({
            sender: senderAddress,
            receiver: receiverAddress,
            tokenTransfers: [
                new TokenTransfer({
                    token: new Token({ identifier: tokenIdentifier, nonce: BigInt(tokenNonce) }),
                    amount: amount  // Always transfer 1 NFT
                })
            ]
        });

        tx.nonce = senderNonce;
        tx.gasLimit = gasLimit;  // Set dynamic gas limit

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        // Wait for transaction confirmation using polling logic
        const finalStatus = await checkTransactionStatus(txHash.toString());
        return finalStatus;
    } catch (error) {
        console.error('Error sending NFT transaction:', error);
        throw new Error('Transaction failed');
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
        console.error('Error executing NFT transaction:', error);
        res.status(500).json({ error: error.message });
    }
});


// --------------- SFT Transfer Logic --------------- //

// Function to validate amount before conversion to BigInt
const validateAmountInput = (value, fieldName) => {
    console.log(`Validating ${fieldName}:`, value);  // Log the input value for debugging
    const numValue = Number(value);
    if (isNaN(numValue) || numValue <= 0) {
        throw new Error(`Invalid ${fieldName} provided. It must be a positive number.`);
    }
    return numValue;
};

// Function to send SFT tokens with dynamic gas limit
const sendSftToken = async (pemContent, recipient, amount, tokenTicker, nonce) => {
    try {
        // Validate amount
        const validAmount = validateAmountInput(amount, 'amount');

        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        const accountOnNetwork = await provider.getAccount(senderAddress);
        const accountNonce = accountOnNetwork.nonce;

        // Convert amount to BigInt (SFTs typically have 0 decimals)
        const adjustedAmount = BigInt(validAmount);

        const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
        const factory = new TransferTransactionsFactory({ config: factoryConfig });

        // Calculate total gas limit based on amount
        const gasLimit = BigInt(calculateSftGasLimit(validAmount));  // Use amount for gas calculation

        const tx = factory.createTransactionForESDTTokenTransfer({
            sender: senderAddress,
            receiver: receiverAddress,
            tokenTransfers: [
                new TokenTransfer({
                    token: new Token({ identifier: tokenTicker, nonce: BigInt(nonce) }),
                    amount: adjustedAmount  // Ensure BigInt usage for amount
                })
            ]
        });

        tx.nonce = accountNonce;
        tx.gasLimit = gasLimit;  // Set dynamic gas limit

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        // Wait for transaction confirmation using polling logic
        const finalStatus = await checkTransactionStatus(txHash.toString());
        return { txHash: txHash.toString(), status: finalStatus };
    } catch (error) {
        console.error('Error sending SFT transaction:', error);
        throw new Error('Transaction failed');
    }
};

// Route for SFT transfers with dynamic gas calculation
app.post('/execute/sftTransfer', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { recipient, amount, tokenTicker, tokenNonce } = req.body;
        const pemContent = getPemContent(req);

        const result = await sendSftToken(pemContent, recipient, amount, tokenTicker, tokenNonce);
         res.json({ result, usageFeeHash: req.usageFeeHash });
    } catch (error) {
        console.error('Error executing SFT transaction:', error);
        res.status(500).json({ error: error.message });
    }
});

// Function for free NFT mint airdrop
const executeFreeNftMintAirdrop = async (pemContent, scAddress, endpoint, receiver, qty) => {
    try {
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();

        const receiverAddress = new Address(receiver);
        const receiverHex = receiverAddress.hex();
        const qtyHex = BigInt(qty).toString(16).padStart(2, '0');
        const dataField = `${endpoint}@${receiverHex}@${qtyHex}`;

        // Dynamic gas calculation: base gas + additional gas per mint
        const baseGas = BigInt(17000000); // Base gas for single mint
        const additionalGasPerMint = BigInt(8000000); // Estimated additional gas per mint
        const gasLimit = baseGas + BigInt(qty - 1) * additionalGasPerMint;

        const accountOnNetwork = await provider.getAccount(senderAddress);
        const senderNonce = accountOnNetwork.nonce;

        const tx = new Transaction({
            nonce: senderNonce,
            receiver: new Address(scAddress),
            sender: senderAddress,
            value: '0',
            gasLimit: gasLimit,
            data: new TransactionPayload(dataField),
            chainID: '1',
        });

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        const finalStatus = await checkTransactionStatus(txHash.toString());
        return finalStatus;
    } catch (error) {
        console.error('Error executing free NFT mint airdrop:', error);
        throw new Error('Transaction failed: ' + error.message);
    }
};

// Function for free NFT mint airdrop
app.post('/execute/freeNftMintAirdrop', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { scAddress, endpoint, receiver, qty } = req.body;
        if (!scAddress || !endpoint || !receiver || !qty || qty <= 0) {
            return res.status(400).json({ error: 'Invalid input parameters' });
        }

        const pemContent = getPemContent(req);
        const result = await executeFreeNftMintAirdrop(pemContent, scAddress, endpoint, receiver, qty);
        res.json({ result, usageFeeHash: req.usageFeeHash });
    } catch (error) {
        console.error('Error executing free NFT mint airdrop:', error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint for distributing rewards to NFT owners
app.post('/execute/distributeRewardsToNftOwners', checkToken, handleUsageFee, async (req, res) => {
    try {
        const pemContent = getPemContent(req);
        const { uniqueOwnerStats, tokenTicker, baseAmount, multiply } = req.body;

        // Validate inputs
        if (!uniqueOwnerStats || !Array.isArray(uniqueOwnerStats)) {
            return res.status(400).json({ error: 'Invalid owner stats provided.' });
        }
        if (!tokenTicker || !baseAmount) {
            return res.status(400).json({ error: 'Token ticker and base amount are required.' });
        }

        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const accountOnNetwork = await provider.getAccount(senderAddress);
        let currentNonce = accountOnNetwork.nonce;

        const decimals = await getTokenDecimals(tokenTicker); // Get token decimals
        const multiplierEnabled = multiply === "yes"; // Check if multiplier is enabled
        const txHashes = [];

        // Helper function to create a transaction
        const createTransaction = (owner, tokensCount, nonce) => {
            const adjustedAmount = multiplierEnabled
                ? convertAmountToBlockchainValue(baseAmount * tokensCount, decimals)
                : convertAmountToBlockchainValue(baseAmount, decimals);

            const receiverAddress = new Address(owner);
            const tokenTransfer = new TokenTransfer({
                token: new Token({ identifier: tokenTicker }),
                amount: BigInt(adjustedAmount),
            });

            const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
            const factory = new TransferTransactionsFactory({ config: factoryConfig });

            const tx = factory.createTransactionForESDTTokenTransfer({
                sender: senderAddress,
                receiver: receiverAddress,
                tokenTransfers: [tokenTransfer],
            });

            tx.nonce = nonce;
            tx.gasLimit = BigInt(500000); // Fixed Gas Limit

            return tx;
        };

        // Step 1: Sign and send all transactions in parallel batches
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
                    status: "failed"
                }));
            });

            // Process batch
            const batchResults = await Promise.all(batchPromises);
            txHashes.push(...batchResults);

            // Throttle to 3 transactions per second
            if (i + 3 < uniqueOwnerStats.length) {
                await wait(1000); // 1-second delay for next batch
            }

            currentNonce += batch.length; // Increment nonce for next batch
        }

        // Step 2: Poll transaction statuses in batches with retries
        const statusResults = await pollTransactionStatuses(txHashes);

        // Return transaction results with UsageFee hash
        res.json({
            message: 'Rewards distribution completed.',
            usageFeeHash: req.usageFeeHash, // Include the UsageFee transaction hash
            results: statusResults, // Include results from the rewards distribution
        });
    } catch (error) {
        console.error('Error during rewards distribution:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ESDT Creator Endpoint
app.post('/execute/esdt-create', checkToken, async (req, res) => {
    try {
        const { walletPem, tokenName, tokenTicker, initialSupply, tokenDecimals, canFreeze, canWipe, canPause, canChangeOwner, canUpgrade, canAddSpecialRoles } = req.body;

        if (!walletPem || !tokenName || !tokenTicker || initialSupply === undefined || tokenDecimals === undefined) {
            return res.status(400).json({ error: "Missing required parameters" });
        }

        console.log(`Creating ESDT: ${tokenName} (${tokenTicker}), Supply: ${initialSupply}, Decimals: ${tokenDecimals}`);

        // Convert input values to blockchain-expected HEX format
        const tokenNameHex = Buffer.from(tokenName, 'utf8').toString('hex');
        const tokenTickerHex = Buffer.from(tokenTicker, 'utf8').toString('hex');
        const initialSupplyHex = BigInt(initialSupply * (10 ** tokenDecimals)).toString(16).padStart(16, '0');  // Ensure correct hex padding
        const decimalsHex = tokenDecimals.toString(16).padStart(2, '0');  // Ensure even-length hex

        // Construct transaction payload using existing encoding method
        const txPayload = `issue@${tokenNameHex}@${tokenTickerHex}@${initialSupplyHex}@${decimalsHex}`
            + `@${Buffer.from('canFreeze', 'utf8').toString('hex')}@${Buffer.from(canFreeze ? 'true' : 'false', 'utf8').toString('hex')}`
            + `@${Buffer.from('canWipe', 'utf8').toString('hex')}@${Buffer.from(canWipe ? 'true' : 'false', 'utf8').toString('hex')}`
            + `@${Buffer.from('canPause', 'utf8').toString('hex')}@${Buffer.from(canPause ? 'true' : 'false', 'utf8').toString('hex')}`
            + `@${Buffer.from('canChangeOwner', 'utf8').toString('hex')}@${Buffer.from(canChangeOwner ? 'true' : 'false', 'utf8').toString('hex')}`
            + `@${Buffer.from('canUpgrade', 'utf8').toString('hex')}@${Buffer.from(canUpgrade ? 'true' : 'false', 'utf8').toString('hex')}`
            + `@${Buffer.from('canAddSpecialRoles', 'utf8').toString('hex')}@${Buffer.from(canAddSpecialRoles ? 'true' : 'false', 'utf8').toString('hex')}`;

        console.log("Transaction Payload:", txPayload);  // Debugging payload before sending transaction

        // Initialize signer
        const signer = UserSigner.fromPem(walletPem);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address("erd1qqqqqqqqqqqqqqqpqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzllls8a5w6u"); // Smart Contract
        const senderNonce = (await provider.getAccount(senderAddress)).nonce;

        // Construct the transaction
        const tx = new Transaction({
            nonce: senderNonce,
            receiver: receiverAddress,
            sender: senderAddress,
            value: "50000000000000000", // Fixed ESDT creation cost (0.05 EGLD)
            gasLimit: BigInt(60000000),
            data: new TransactionPayload(txPayload),
            chainID: '1',
        });

        // Sign and send the transaction
        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        // Poll for transaction confirmation
        const finalStatus = await checkTransactionStatus(txHash.toString());

        res.json({
            message: 'ESDT created successfully.',
            tokenName,
            tokenTicker,
            initialSupply,
            tokenDecimals,
            transactionHash: txHash.toString(),
            status: finalStatus,
        });
    } catch (error) {
        console.error("Error executing ESDT creation:", error);
        res.status(500).json({ error: error.message });
    }
});

app.use('/admin', adminRoutes);


// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
