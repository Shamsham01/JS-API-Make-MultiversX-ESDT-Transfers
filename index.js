const express = require('express');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 10000;

// Secure token from environment variable
const SECURE_TOKEN = process.env.SECURE_TOKEN;

// Path to the PEM file
const PEM_PATH = '/etc/secrets/walletKey.pem'; // Update this with your actual PEM file name

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

// Your function to handle the signing and sending of transactions
const sendEsdtToken = async (pemKey, recipient, amount, tokenTicker) => {
    // Implement your logic to sign and send the transaction
    // Return the result or throw an error
    return {
        message: 'Transaction sent successfully',
        recipient,
        amount,
        tokenTicker,
    };
};

// Execute endpoint for dynamic code execution
app.post('/execute', checkToken, async (req, res) => {
    try {
        const { recipient, amount, tokenTicker } = req.body;

        // Load PEM file
        const pemKey = fs.readFileSync(PEM_PATH, 'utf8');

        // Call your function that signs and sends the transaction
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
