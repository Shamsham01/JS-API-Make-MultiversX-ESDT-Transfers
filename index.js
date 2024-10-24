const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const { Address, Token, TokenTransfer, TransferTransactionsFactory, TransactionsFactoryConfig, Transaction, TransactionPayload } = require('@multiversx/sdk-core');
const { ProxyNetworkProvider } = require('@multiversx/sdk-network-providers');
const { UserSigner } = require('@multiversx/sdk-wallet');

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

// --------------- Transaction Confirmation Logic --------------- //
const checkTransactionStatus = async (txHash, retries = 10, delay = 5000) => {
    for (let i = 0; i < retries; i++) {
        const txStatusUrl = `https://api.multiversx.com/transactions/${txHash}`;
        const response = await fetch(txStatusUrl);
        const txStatus = await response.json();

        if (txStatus.status === 'success') {
            return { confirmed: true, txHash: txHash };
        } else if (txStatus.status === 'fail') {
            return { confirmed: false, txHash: txHash, error: `Transaction ${txHash} failed.` };
        }

        await new Promise(resolve => setTimeout(resolve, delay));
    }

    return { confirmed: false, error: `Transaction ${txHash} not confirmed after ${retries} retries.` };
};

// --------------- Simplified Gas Calculation for NFTs --------------- //
const calculateNftGasLimit = (numberOfItems) => {
    const GAS_PER_NFT = 5000000n; // 5M gas per NFT
    return GAS_PER_NFT * BigInt(numberOfItems);
};

// --------------- Smart Contract Call Logic (Giveaway) --------------- //
const executeScCall = async (pemContent, scAddress, endpoint, receiver, qty, numberOfItems) => {
    try {
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();

        console.log(`Number of NFTs being sent: ${numberOfItems}`);

        // Convert receiver address from Bech32 to hex using MultiversX SDK's Address class
        const receiverAddress = new Address(receiver);
        const receiverHex = receiverAddress.hex();

        // Create the payload for the smart contract interaction (data field)
        const dataField = `${endpoint}@${receiverHex}@${qty.toString(16).padStart(2, '0')}`;

        // Fetch account details from the network to get the nonce
        const accountOnNetwork = await provider.getAccount(senderAddress);
        const senderNonce = accountOnNetwork.nonce;

        // Calculate the gas limit: 5M per NFT multiplied by number of NFTs
        const gasLimit = calculateNftGasLimit(numberOfItems);

        console.log(`Calculated Gas Limit: ${gasLimit.toString()} for ${numberOfItems} NFTs`);

        // Create a transaction object
        const tx = new Transaction({
            nonce: senderNonce,
            receiver: new Address(scAddress),
            sender: senderAddress,
            value: '0',  // Sending 0 EGLD
            gasLimit: gasLimit, // Use calculated gas limit
            data: new TransactionPayload(dataField),
            chainID: '1',
        });

        // Sign the transaction
        await signer.sign(tx);

        // Send the transaction
        const txHash = await provider.sendTransaction(tx);

        // Wait for transaction confirmation
        const txResult = await checkTransactionStatus(txHash.toString());
        if (!txResult.confirmed) throw new Error(txResult.error);

        return { txHash: txHash.toString() };
    } catch (error) {
        console.error('Error executing smart contract call:', error);
        throw new Error('Smart contract call failed');
    }
};

// Route for smart contract call (giveaway)
app.post('/execute/scCall', checkToken, async (req, res) => {
    try {
        const { scAddress, endpoint, receiver, qty, numberOfItems } = req.body;
        const pemContent = getPemContent(req);
        const result = await executeScCall(pemContent, scAddress, endpoint, receiver, qty, numberOfItems);
        res.json({ result });
    } catch (error) {
        console.error('Error executing smart contract call:', error);
        res.status(500).json({ error: error.message });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
