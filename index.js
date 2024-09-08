const express = require('express');
const bodyParser = require('body-parser');
const { UserSigner } = require('@multiversx/sdk-wallet');
const { Address, TokenTransfer, Transaction, GasLimit, TransactionPayload } = require('@multiversx/sdk-core');
const { ApiNetworkProvider } = require('@multiversx/sdk-network-providers');
const app = express();

const provider = new ApiNetworkProvider('https://devnet-api.multiversx.com'); // Use mainnet URL for production

app.use(bodyParser.json());

const signer = UserSigner.fromPem('path/to/your/pemfile.pem'); // Update with the actual path

// Helper function to fetch token details (decimals)
async function getTokenDetails(tokenIdentifier) {
    try {
        const tokenDetails = await provider.getToken(tokenIdentifier);
        return tokenDetails;
    } catch (error) {
        console.error("Error fetching token details:", error);
        return { decimals: 18 }; // Default to 18 decimals
    }
}

// Helper function to convert user amount to blockchain format
function convertToBlockchainAmount(userAmount, decimals) {
    return BigInt(userAmount * Math.pow(10, decimals));
}

// Check token middleware
async function checkToken(req, res, next) {
    const { sender, tokenIdentifier } = req.body;
    if (!sender || !tokenIdentifier) {
        return res.status(400).json({ error: "Missing required fields: sender, tokenIdentifier" });
    }
    next();
}

// Transfer ESDT/SFT function
async function sendEsdtTransfer({ sender, receiver, tokenIdentifier, userAmount }) {
    try {
        const account = await provider.getAccount(Address.fromBech32(sender));

        // Fetch token decimals
        const tokenDetails = await getTokenDetails(tokenIdentifier);
        const decimals = tokenDetails.decimals || 18;

        // Convert user-friendly amount to blockchain-compatible value
        const amountInBlockchainFormat = convertToBlockchainAmount(userAmount, decimals);

        // Create token transfer
        const transferData = TokenTransfer.fungibleFromAmount(tokenIdentifier, amountInBlockchainFormat, decimals);

        // Create transaction
        const tx = new Transaction({
            sender: Address.fromBech32(sender),
            receiver: Address.fromBech32(receiver),
            value: 0,  // No EGLD value for ESDT transfers
            gasLimit: new GasLimit(500000),
            chainID: "D",  // "1" for Mainnet
            data: new TransactionPayload(transferData.toTransactionData()),
            nonce: account.nonce
        });

        // Sign the transaction
        tx.signature = await signer.sign(tx);
        
        // Send the transaction
        const txHash = await provider.sendTransaction(tx);
        console.log(`Transaction sent! Hash: ${txHash}`);

        return txHash;
    } catch (error) {
        console.error("Error sending transaction:", error);
        throw error;
    }
}

// Endpoint for sending ESDT
app.post('/transfer', checkToken, async (req, res) => {
    try {
        const { sender, receiver, tokenIdentifier, userAmount } = req.body;
        const txHash = await sendEsdtTransfer({ sender, receiver, tokenIdentifier, userAmount });
        res.json({ success: true, txHash });
    } catch (error) {
        res.status(500).json({ error: "Failed to execute transaction", details: error.message });
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
