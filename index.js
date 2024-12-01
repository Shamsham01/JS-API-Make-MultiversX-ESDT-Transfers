const express = require('express');
const bodyParser = require('body-parser');
const adminRoutes = require('./admin');
const transfersRoutes = require('./transfers');
const { logUserActivity } = require('./utils/whitelist');

// Initialize the Express application
const app = express();

// Constants
const PORT = process.env.PORT || 10000;

// Middleware
app.use(bodyParser.json()); // Parse JSON-encoded bodies

// Routes
app.use('/admin', adminRoutes);
app.use('/transfers', transfersRoutes);

// Authorization Endpoint
app.post('/authorize', (req, res) => {
    try {
        const pemContent = req.body.walletPem;

        if (!pemContent || typeof pemContent !== 'string' || !pemContent.includes('-----BEGIN PRIVATE KEY-----')) {
            throw new Error('Invalid PEM content');
        }

        // Simulate deriving wallet address from PEM content
        const walletAddress = 'derived_wallet_address_placeholder'; // Replace with actual wallet derivation logic

        // Log user activity in `users.json`
        const logResult = logUserActivity(walletAddress);

        res.json({
            message: 'Authorization successful',
            walletAddress: walletAddress,
            logResult,
        });
    } catch (error) {
        console.error('Error in authorization:', error.message);
        res.status(400).json({ error: error.message });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
