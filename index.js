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
const USAGE_FEE = 100; // Fee in REWARD tokens
const REWARD_TOKEN = "REWARD-cf6eac"; // Token identifier
const TREASURY_WALLET = "erd158k2c3aserjmwnyxzpln24xukl2fsvlk9x46xae4dxl5xds79g6sdz37qn"; // Treasury wallet

// Set up the network provider for MultiversX (mainnet or devnet)
const provider = new ProxyNetworkProvider("https://gateway.multiversx.com", { clientName: "javascript-api" });

const fs = require('fs');
const path = require('path');

const whitelistFilePath = path.join(__dirname, 'whitelist.json');

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

// --------------- Transaction Confirmation Logic (Polling) --------------- //
const checkTransactionStatus = async (txHash, retries = 20, delay = 4000) => {
    const txStatusUrl = `https://api.multiversx.com/transactions/${txHash}`;

    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(txStatusUrl);

            // Ensure we only parse valid responses
            if (!response.ok) {
                console.warn(`Non-200 response for ${txHash}: ${response.status}`);
                throw new Error(`HTTP error ${response.status}`);
            }

            // Attempt to parse the JSON response
            const txStatus = await response.json();

            // Check the transaction status
            if (txStatus.status === "success") {
                return { status: "success", txHash };
            } else if (txStatus.status === "fail") {
                return { status: "fail", txHash };
            }

            console.log(`Transaction ${txHash} still pending, retrying...`);
        } catch (error) {
            if (error instanceof SyntaxError) {
                console.error(
                    `Failed to parse JSON for ${txHash}: ${error.message}. Retrying...`
                );
            } else {
                console.error(
                    `Error fetching transaction ${txHash}: ${error.message}`
                );
            }
        }

        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    throw new Error(
        `Transaction ${txHash} status could not be determined after ${retries} retries.`
    );
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

// Route for ESDT transfers with wallet address derivation and logging
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
    console.log(`Validating ${fieldName}:`, value);  // Log the input value for debugging
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

        // Log the payload received from the request
        console.log('Request Body:', req.body);

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

        const gasLimit = BigInt(10000000); // Default gas limit for interactions
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
        const pemContent = getPemContent(req);
        const result = await executeFreeNftMintAirdrop(pemContent, scAddress, endpoint, receiver, qty);
         res.json({ result, usageFeeHash: req.usageFeeHash });
    } catch (error) {
        console.error('Error executing free NFT mint airdrop:', error);
        res.status(500).json({ error: error.message });
    }
});

// Function for Distributing Rewards to NFT Owners with Parallel Broadcasting at 3 tx/s
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

        const decimals = await getTokenDecimals(tokenTicker);
        const multiplierEnabled = multiply === "yes";

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
            tx.gasLimit = calculateEsdtGasLimit();

            return tx;
        };

        // Step 1: Sign and send all transactions in parallel batches
        for (let i = 0; i < uniqueOwnerStats.length; i += 3) {
            const batch = uniqueOwnerStats.slice(i, i + 3);
            const batchPromises = batch.map((ownerData, index) => {
                const tx = createTransaction(
                    ownerData.owner,
                    ownerData.tokensCount,
                    currentNonce + i + index
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
                await new Promise(resolve => setTimeout(resolve, 1000)); // 1-second delay for next batch
            }
        }

        // Step 2: Poll for transaction statuses in parallel after all transactions are sent
        const statusPromises = txHashes.map(({ owner, txHash }) =>
            checkTransactionStatus(txHash)
                .then(status => ({ owner, txHash, status: status.status }))
                .catch(error => ({ owner, txHash, error: error.message, status: 'failed' }))
        );
        const statusResults = await Promise.all(statusPromises);

        // Return transaction results with UsageFee hash
res.json({
    message: 'Rewards distribution completed.',
    usageFeeHash: req.usageFeeHash, // Include the UsageFee transaction hash
    results: statusResults, // Existing results from the rewards distribution
});
    } catch (error) {
        console.error('Error during rewards distribution:', error.message);
        res.status(500).json({ error: error.message });
    }
});


// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
