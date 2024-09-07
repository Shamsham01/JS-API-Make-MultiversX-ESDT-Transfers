const express = require('express');
const fs = require('fs');
const bodyParser = require('body-parser');
const { Address, Token, TokenTransfer, TransferTransactionsFactory, TransactionsFactoryConfig } = require('@multiversx/sdk-core');
const { ProxyNetworkProvider } = require('@multiversx/sdk-network-providers');
const { UserSigner } = require('@multiversx/sdk-wallet');

const app = express();
const PORT = process.env.PORT || 10000;

const SECURE_TOKEN = process.env.SECURE_TOKEN;
const PEM_PATH = '/etc/secrets/walletKey.pem';
const provider = new ProxyNetworkProvider("https://devnet-gateway.multiversx.com", { clientName: "javascript-api" });

app.use(bodyParser.text({ type: 'text/plain' }));
app.use(express.json());

const checkToken = (req, res, next) => {
    const token = req.headers.authorization;
    if (token === SECURE_TOKEN) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

const sendEsdtToken = async (pemKey, recipient, amount, tokenTicker) => {
    try {
        const signer = UserSigner.fromPem(pemKey);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        // Fetch account details to get the nonce
        const accountOnNetwork = await provider.getAccount(senderAddress);
        const nonce = accountOnNetwork.nonce;

        // Create a factory for ESDT token transfer transactions
        const factoryConfig = new TransactionsFactoryConfig({ chainID: "D" }); // Update ChainID based on your network
        const factory = new TransferTransactionsFactory({ config: factoryConfig });

        const tx = factory.createTransactionForESDTTokenTransfer({
            sender: senderAddress,
            receiver: receiverAddress,
            tokenTransfers: [
                new TokenTransfer({
                    token: new Token({ identifier: tokenTicker }),
                    amount: BigInt(amount)
                })
            ]
        });

        tx.nonce = nonce;
        tx.gasLimit = 500000n;  // Gas limit as BigInt

        await signer.sign(tx);

        const txHash = await provider.sendTransaction(tx);
        return { txHash: txHash.toString() };
    } catch (error) {
        console.error('Error sending ESDT transaction:', error);
        throw new Error('Transaction failed');
    }
};

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
