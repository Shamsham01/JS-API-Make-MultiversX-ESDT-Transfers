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

// Set up the network provider for MultiversX (mainnet or devnet)
const provider = new ProxyNetworkProvider("https://gateway.multiversx.com", { clientName: "javascript-api" });

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

// --------------- Transaction Confirmation Logic (Polling) --------------- //
const checkTransactionStatus = async (txHash, retries = 20, delay = 7000) => {
    for (let i = 0; i < retries; i++) {
        const txStatusUrl = `https://api.multiversx.com/transactions/${txHash}`;
        const response = await fetch(txStatusUrl);
        const txStatus = await response.json();

        if (txStatus.status === 'success') {
            return { status: 'success', txHash };
        } else if (txStatus.status === 'fail') {
            throw new Error(`Transaction ${txHash} failed.`);
        }

        await new Promise(resolve => setTimeout(resolve, delay));
    }

    throw new Error(`Transaction ${txHash} not confirmed after ${retries} retries.`);
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
app.post('/execute/authorize', checkToken, (req, res) => {
    try {
        const pemContent = getPemContent(req);
        res.json({ message: "Authorization Successful" });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

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
app.post('/execute/egldTransfer', checkToken, async (req, res) => {
    try {
        const { recipient, amount } = req.body;
        const pemContent = getPemContent(req);
        const result = await sendEgld(pemContent, recipient, amount);
        res.json({ result });
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
        const result = await sendEsdtToken(pemContent, recipient, amount, tokenTicker);
        res.json({ result });
    } catch (error) {
        console.error('Error executing ESDT transaction:', error);
        res.status(500).json({ error: error.message });
    }
});

// Helper function to convert numbers to Hexadecimal
const toHex = (number) => {
    return BigInt(number).toString(16).padStart(2, '0');
};

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
app.post('/execute/metaEsdtTransfer', checkToken, async (req, res) => {
    try {
        const { recipient, tokenIdentifier, nonce, amount } = req.body;
        const pemContent = getPemContent(req);

        // Execute the Meta-ESDT transfer
        const result = await sendMetaEsdt(pemContent, recipient, tokenIdentifier, nonce, amount);
        res.json({ result });
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
app.post('/execute/nftTransfer', checkToken, async (req, res) => {
    try {
        const { recipient, tokenIdentifier, tokenNonce } = req.body;
        const pemContent = getPemContent(req);

        const result = await sendNftToken(pemContent, recipient, tokenIdentifier, tokenNonce);
        res.json({ result });
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
app.post('/execute/sftTransfer', checkToken, async (req, res) => {
    try {
        const { recipient, amount, tokenTicker, tokenNonce } = req.body;
        const pemContent = getPemContent(req);

        // Log the payload received from the request
        console.log('Request Body:', req.body);

        const result = await sendSftToken(pemContent, recipient, amount, tokenTicker, tokenNonce);
        res.json({ result });
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

// Route for free NFT mint airdrop
app.post('/execute/freeNftMintAirdrop', checkToken, async (req, res) => {
    try {
        const { scAddress, endpoint, receiver, qty } = req.body;
        const pemContent = getPemContent(req);
        const result = await executeFreeNftMintAirdrop(pemContent, scAddress, endpoint, receiver, qty);
        res.json({ result });
    } catch (error) {
        console.error('Error executing free NFT mint airdrop:', error);
        res.status(500).json({ error: error.message });
    }
});

// Route for Distributing Rewards to NFT Owners
app.post('/execute/distributeRewardsToNftOwners', checkToken, async (req, res) => {
    try {
        console.log('Incoming request body:', req.body);

        const { uniqueOwnerStats, tokenTicker, baseAmount, multiply, pemContent } = req.body;

        // Validate inputs
        if (!uniqueOwnerStats || !Array.isArray(uniqueOwnerStats)) {
            console.error('Invalid owner stats provided.');
            return res.status(400).json({ error: 'Invalid owner stats provided.' });
        }
        if (!tokenTicker || !baseAmount) {
            console.error('Token ticker and base amount are required.');
            return res.status(400).json({ error: 'Token ticker and base amount are required.' });
        }
        if (!pemContent) {
            console.error('PEM file is required for signing transactions.');
            return res.status(400).json({ error: 'PEM file is required for signing transactions.' });
        }

        const signer = UserSigner.fromPem(pemContent);
        console.log('Signer initialized successfully.');

        const senderAddress = signer.getAddress();
        console.log('Sender address:', senderAddress);

        const accountOnNetwork = await provider.getAccount(senderAddress);
        const senderNonce = accountOnNetwork.nonce;

        // Fetch token decimals
        const decimals = await getTokenDecimals(tokenTicker);

        // Prepare transactions
        const results = [];
        let currentNonce = senderNonce;

        for (const { owner, tokensCount } of uniqueOwnerStats) {
            const adjustedAmount = multiply
                ? convertAmountToBlockchainValue(baseAmount * tokensCount, decimals)
                : convertAmountToBlockchainValue(baseAmount, decimals);

            const tx = new Transaction({
                nonce: currentNonce++,
                sender: senderAddress,
                receiver: new Address(owner),
                value: '0', // No EGLD is transferred
                data: new TransactionPayload(
                    `ESDTTransfer@${Buffer.from(tokenTicker).toString('hex')}@${BigInt(adjustedAmount).toString(16)}`
                ),
                gasLimit: calculateEsdtGasLimit(),
                chainID: '1',
            });

            await signer.sign(tx);
            console.log(`Transaction signed for owner: ${owner}`);

            try {
                const txHash = await provider.sendTransaction(tx);
                const finalStatus = await checkTransactionStatus(txHash.toString());
                results.push({ owner, txHash: txHash.toString(), status: finalStatus.status });
            } catch (error) {
                console.error(`Error sending transaction to ${owner}:`, error.message);
                results.push({ owner, error: error.message, status: 'failed' });
            }
        }

        // Return transaction results
        res.json({
            message: 'Rewards distribution completed.',
            results,
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
