const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const adminRoutes = require('./admin');
const transfersRoutes = require('./transfers');
const { ProxyNetworkProvider } = require('@multiversx/sdk-network-providers');

// Initialize the Express application
const app = express();

// Constants
const PORT = process.env.PORT || 10000;
const API_PROVIDER_URL = process.env.API_PROVIDER || "https://api.multiversx.com";
const APP_CLIENT_NAME = "MultiversX Transfers API for Make.com";

// Initialize MultiversX Provider
const provider = new ProxyNetworkProvider(API_PROVIDER_URL, { clientName: APP_CLIENT_NAME });

// Middleware setup
app.use(cors());
app.use(bodyParser.json());

// Middleware to add provider to requests
app.use((req, res, next) => {
    req.provider = provider;
    next();
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: "API is live",
        clientName: APP_CLIENT_NAME,
        provider: API_PROVIDER_URL,
        timestamp: new Date().toISOString(),
    });
});

// Route Initialization
app.use('/admin', adminRoutes);
app.use('/transfers', transfersRoutes);

// Error Handling Middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err.message);
    res.status(500).json({ error: "An unexpected error occurred.", details: err.message });
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Using MultiversX Provider: ${API_PROVIDER_URL}`);
    console.log(`Client Name for SDK: ${APP_CLIENT_NAME}`);
});
