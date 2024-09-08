const express = require('express');
const fs = require('fs');
const bodyParser = require('body-parser');
const fetch = require('node-fetch'); // Import node-fetch for API requests
const { Address, Token, TokenTransfer, TransferTransactionsFactory, TransactionsFactoryConfig } = require('@multiversx/sdk-core');
const { ProxyNetworkProvider } = require('@multiversx/sdk-network-providers');
const { UserSigner } = require('@multiversx/sdk-wallet');
const BigNumber = require('bignumber.js'); // BigNumber for precise decimal conversions

const app = express();
const PORT = process.env.PORT || 10000;

const SECURE_TOKEN = process.env.SECURE_TOKEN;
const PEM_PATH = '/etc/secrets/walletKey.pem';

// Set up the network provider for mainnet or devnet as needed
const provider = new ProxyNetworkProvider("https://gateway.multiversx.com", { clientName: "javascript-api" });

app.use(bodyParser.text({ type: 'text/plain' }));
app.use(express.json());

// Middleware to check authorization token
const checkToken = (req, res, next) => {
    const token = req.headers.authorization;
    if (token === SECURE_TOKEN) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

// Function to get token decimals from MultiversX API
const getTokenDecimals = async (tokenTicker) => {
    const apiUrl = `https://api.multiversx.com/tokens/${tokenTicker}`;
    const response = await fetch(apiUrl);
    
    if (!response.ok) {
        throw new Error(`Failed to fetch token info: ${response.statusText}`);
    }

    const tokenInfo = await response.json();
    return tokenInfo.decimals || 0; // Default to 0 if decimals not found
};

// Function to convert token amount based on decimals
const convertAmountToBlockchainValue = (amount, decimals) => {
    const factor = new BigNumber(10).pow(decimals); // Factor = 10^decimals
    return new BigNumber(amount).multipliedBy(factor).toFixed(0); // Convert to integer string
};

// Function to send ESDT tokens
const sendEsdtToken = async (pemKey, recipient, amount, tokenTicker) => {
    try {
        const signer = UserSigner.fromPem(pemKey); // Load signer from PEM
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        // Fetch account details from network to get the nonce
        const accountOnNetwork = await provider.getAccount(senderAddress);
        const nonce = accountOnNetwork.nonce;

        // Fetch token decimals and convert amount
        const decimals = await getTokenDecimals(tokenTicker);
        const convertedAmount = convertAmountToBlockchainValue(amount, decimals);

        // Create a factory for ESDT token transfer transactions
        const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" }); // Update chainID accordingly
        const factory = new TransferTransactionsFactory({ config: factoryConfig });

        const tx = factory.createTransactionForESDTTokenTransfer({
            sender: senderAddress,
            receiver: receiverAddress,
            tokenTransfers: [
                new TokenTransfer({
                    token: new Token({ identifier: tokenTicker }),
                    amount: BigInt(convertedAmount) // Handle token amount as BigInt
                })
            ]
        });

        tx.nonce = nonce; // Set transaction nonce
        tx.gasLimit = 500000n; // Set gas limit as BigInt

        await signer.sign(tx); // Sign the transaction

        const txHash = await provider.sendTransaction(tx); // Send the transaction to the network
        return { txHash: txHash.toString() };
    } catch (error) {
        console.error('Error sending ESDT transaction:', error);
        throw new Error('Transaction failed');
    }
};

// Route to handle token transfers
app.post('/execute', checkToken, async (req, res) => {
    try {
        const { recipient, amount, tokenTicker } = req.body;
        const pemKey = fs.readFileSync(PEM_PATH, 'utf8');
        const result = await sendEsdtToken(pemKey, recipient, amount, tokenTicker);
        res.json({ result });
    } catch (error) {
        console.error('Error executing transaction:', error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
