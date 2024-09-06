const express = require('express');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const { UserSigner, Address, TransactionPayload, Transaction, GasLimit, TransactionVersion, Account } = require('@multiversx/sdk-core');
const { ProxyNetworkProvider } = require('@multiversx/sdk-network-providers');

const app = express();
const PORT = process.env.PORT || 10000;

// Secure token from environment variable
const SECURE_TOKEN = process.env.SECURE_TOKEN;

// Path to the PEM file
const PEM_PATH = '/etc/secrets/walletKey.pem';

// MultiversX provider
const provider = new ProxyNetworkProvider("https://api.multiversx.com");

// Middleware
app.use(bodyParser.text({ type: 'text/plain' }));
app.use(express.json());

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
const sendEsdtToken = async (pemKey, recipient, amount, tokenTicker) => {
    try {
        // Create a signer using the PEM file
        const signer = UserSigner.fromPem(pemKey);
        const senderAddress = signer.getAddress();

        // Fetch account data from network to get the nonce
        const account = new Account(senderAddress);
        const accountOnNetwork = await provider.getAccount(senderAddress);
        account.update(accountOnNetwork);

        // Convert recipient to Address
        const receiverAddress = new Address(recipient);

        // Prepare data for ESDT transfer
        const tokenHex = Buffer.from(tokenTicker).toString('hex');
        const amountHex = BigInt(amount).toString(16); // Ensure the amount is in hexadecimal format
        const dataField = `ESDTTransfer@${tokenHex}@${amountHex}`;

        // Build the transaction
        const tx = new Transaction({
            nonce: account.nonce, // Get the account's nonce
            receiver: receiverAddress,
            gasLimit: new GasLimit(500000), // ESDT transfer requires at least 500000 gas
            value: '0', // No EGLD should be transferred, only ESDT
            data: new TransactionPayload(dataField), // Payload for the ESDT transfer
            sender: senderAddress,
            chainID: '1', // Mainnet chain ID
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

        // Load PEM file
        const pemKey = fs.readFileSync(PEM_PATH, 'utf8');

        // Call function to send the transaction
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
