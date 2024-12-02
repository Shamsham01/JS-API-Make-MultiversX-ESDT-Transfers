const express = require('express');
const cors = require('cors'); // Enable CORS for external requests
const adminRoutes = require('./admin');
const transfersRoutes = require('./transfers');
const { logUserActivity } = require('./utils/whitelist');
const { UserSigner } = require('@multiversx/sdk-wallet');

// Initialize the Express application
const app = express();

// Constants
const PORT = process.env.PORT || 10000;

// Middleware
app.use(cors()); // Enable CORS
app.use(express.json()); // Parse JSON-encoded bodies

// Health Check Endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

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

        // Derive wallet address from PEM content
        const signer = UserSigner.fromPem(pemContent);
        const walletAddress = signer.getAddress().toString();

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
    console.log(`[INFO] Server is running on port ${PORT}`);
});
