const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const { Address, Token, TokenTransfer, TransferTransactionsFactory, TransactionsFactoryConfig } = require('@multiversx/sdk-core');
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

// Function to validate and return the PEM content from the headers
const getPemContent = (req) => {
    const pemContent = req.headers['wallet-pem'];
    if (!pemContent || typeof pemContent !== 'string') {
        throw new Error('PEM content is missing or invalid.');
    }
    // Basic validation for PEM format
    if (!pemContent.includes('-----BEGIN PRIVATE KEY-----') || !pemContent.includes('-----END PRIVATE KEY-----')) {
        throw new Error('Invalid PEM structure. It should include both BEGIN and END tags.');
    }
    return pemContent;
};

// --------------- Authorization Endpoint --------------- //
// Handles /authorize endpoint to validate authorization and PEM content
app.post('/execute/authorize', checkToken, (req, res) => {
    try {
        const pemContent = getPemContent(req);  // Validate PEM content from headers
        res.json({ message: "Authorization Successful" });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// --------------- ESDT Transfer Logic --------------- //

// Function to get token decimals for ESDT transfers
const getTokenDecimals = async (tokenTicker) => {
    const apiUrl = `https://api.multiversx.com/tokens/${tokenTicker}`;
    const response = await fetch(apiUrl);
    if (!response.ok) {
        throw new Error(`Failed to fetch token info for ${tokenTicker}: ${response.statusText}`);
    }
    const tokenInfo = await response.json();
    return tokenInfo.decimals || 0;  // Default to 0 if decimals not found
};

// Function to convert token amount for ESDT based on decimals
const convertAmountToBlockchainValue = (amount, decimals) => {
    const factor = new BigNumber(10).pow(decimals);  // Factor = 10^decimals
    return new BigNumber(amount).multipliedBy(factor).toFixed(0);  // Convert to integer string
};

// Function to send ESDT tokens with improved error handling
const sendEsdtToken = async (pemContent, recipient, amount, tokenTicker) => {
    try {
        const signer = UserSigner.fromPem(pemContent);  // Use PEM content from headers
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        // Fetch account details from network to get the nonce
        const accountOnNetwork = await provider.getAccount(senderAddress);
        const nonce = accountOnNetwork.nonce;

        // Fetch token decimals and convert amount
        const decimals = await getTokenDecimals(tokenTicker);
        const convertedAmount = convertAmountToBlockchainValue(amount, decimals);

        // Create a factory for ESDT token transfer transactions
        const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
        const factory = new TransferTransactionsFactory({ config: factoryConfig });

        const tx = factory.createTransactionForESDTTokenTransfer({
            sender: senderAddress,
            receiver: receiverAddress,
            tokenTransfers: [
                new TokenTransfer({
                    token: new Token({ identifier: tokenTicker }),
                    amount: BigInt(convertedAmount)  // Handle token amount as BigInt
                })
            ]
        });

        tx.nonce = nonce;  // Set transaction nonce
        tx.gasLimit = 500000n;  // Set gas limit as BigInt

        await signer.sign(tx);  // Sign the transaction
        const txHash = await provider.sendTransaction(tx);  // Send the transaction to the network
        return { txHash: txHash.toString() };
    } catch (error) {
        if (error.message.includes('insufficient')) {
            throw new Error('Insufficient funds for this transaction.');
        }
        console.error('Error sending ESDT transaction:', error);
        throw new Error('Transaction failed');
    }
};

// Route for ESDT transfers
app.post('/execute/esdtTransfer', checkToken, async (req, res) => {
    try {
        const { recipient, amount, tokenTicker } = req.body;
        const pemContent = getPemContent(req);  // Get the PEM content from the headers
        const result = await sendEsdtToken(pemContent, recipient, amount, tokenTicker);
        res.json({ result });
    } catch (error) {
        console.error('Error executing ESDT transaction:', error);
        res.status(500).json({ error: error.message });
    }
});

// --------------- SFT Transfer Logic --------------- //

// Function to assume SFTs have 0 decimals
const getTokenDecimalsSFT = async () => {
    return 0;
};

// Function to send SFT tokens with improved error handling
const sendSftToken = async (pemContent, recipient, amount, tokenTicker, nonce) => {
    try {
        const signer = UserSigner.fromPem(pemContent);  // Use PEM content from headers
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        // Fetch account details to get the nonce
        const accountOnNetwork = await provider.getAccount(senderAddress);
        const accountNonce = accountOnNetwork.nonce;

        // Get token decimals (for SFTs it's typically 0)
        const decimals = await getTokenDecimalsSFT();
        const adjustedAmount = BigInt(amount) * BigInt(10 ** decimals);  // Ensure amounts are BigInts

        // Create a factory for SFT transfer transactions
        const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
        const factory = new TransferTransactionsFactory({ config: factoryConfig });

        const tx = factory.createTransactionForESDTTokenTransfer({
            sender: senderAddress,
            receiver: receiverAddress,
            tokenTransfers: [
                new TokenTransfer({
                    token: new Token({ identifier: tokenTicker, nonce: BigInt(nonce) }),
                    amount: adjustedAmount
                })
            ]
        });

        tx.nonce = accountNonce;  // Set transaction nonce
        tx.gasLimit = 500000n;  // Manually set gas limit as BigInt

        await signer.sign(tx);  // Sign the transaction
        const txHash = await provider.sendTransaction(tx);
        return { txHash: txHash.toString() };
    } catch (error) {
        if (error.message.includes('insufficient')) {
            throw new Error('Insufficient funds for this transaction.');
        }
        console.error('Error sending SFT transaction:', error);
        throw new Error('Transaction failed');
    }
};

// Route for SFT transfers
app.post('/execute/sftTransfer', checkToken, async (req, res) => {
    try {
        const { recipient, amount, tokenTicker, tokenNonce } = req.body;
        const pemContent = getPemContent(req);  // Get the PEM content from the headers
        const result = await sendSftToken(pemContent, recipient, amount, tokenTicker, tokenNonce);
        res.json({ result });
    } catch (error) {
        console.error('Error executing SFT transaction:', error);
        res.status(500).json({ error: error.message });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
