const express = require('express');
const fs = require('fs').promises;  // Using promises to read PEM file
const bodyParser = require('body-parser');
const { UserSigner, Address, TransactionPayload, Transaction, GasLimit, TransactionVersion } = require('@multiversx/sdk-core');
const { ProxyNetworkProvider } = require('@multiversx/sdk-network-providers');

const app = express();
const PORT = process.env.PORT || 10000;

// Secure token from environment variable
const SECURE_TOKEN = process.env.SECURE_TOKEN;

// Path to the PEM file
const PEM_PATH = '/etc/secrets/walletKey.pem';

// MultiversX provider
const provider = new ProxyNetworkProvider("https://api.multiversx.com", { clientName: "javascript-api" });

// Middleware
app.use(bodyParser.json());

// Function to check token
const checkToken = (req, res, next) => {
    const token = req.headers.authorization;
    if (token === SECURE_TOKEN) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

// Function to handle the signing and sending of ESDT transactions
const sendEsdtToken = async (pemPath, recipient, amount, tokenTicker) => {
    try {
        // Read the PEM file content using promises
        const pemKey = await fs.readFile(pemPath, 'utf8');

        // Create a signer using the PEM file content
        const signer = UserSigner.fromPem(pemKey.trim());
        const senderAddress = signer.getAddress();

        // Convert recipient to Address
        const receiverAddress = new Address(recipient);

        // Prepare data for ESDT transfer
        const tokenHex = Buffer.from(tokenTicker).toString('hex');
        const amountHex = BigInt(amount).toString(16);  // Ensure the amount is converted to hexadecimal
        const dataField = `ESDTTransfer@${tokenHex}@${amountHex}`;

        // Build the transaction
        const tx = new Transaction({
            nonce: await provider.getAccountNonce(senderAddress),  // Get the account's nonce
            receiver: receiverAddress,
            gasLimit: new GasLimit(500000),  // ESDT transfer requires at least 500,000 gas
            value: '0',  // No EGLD should be transferred, only ESDT
            data: new TransactionPayload(dataField),
            sender: senderAddress,
            chainID: '1',  // Mainnet chain ID
            version: new TransactionVersion(1)
        });

        // Sign the transaction
        await signer.sign(tx);

        // Send the transaction
        const txHash = await provider.sendTransaction(tx);
        return { txHash: txHash.toString() };
    } catch (error) {
        console.error('Error sending ESDT transaction:', error);
        throw new Error('Transaction failed');
    }
};

// Execute endpoint
app.post('/execute', checkToken, async (req, res) => {
    try {
        const { recipient, amount, tokenTicker } = req.body;

        // Call function to send the transaction
        const result = await sendEsdtToken(PEM_PATH, recipient, amount, tokenTicker);

        res.json({ result });
    } catch (error) {
        console.error('Error executing transaction:', error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
