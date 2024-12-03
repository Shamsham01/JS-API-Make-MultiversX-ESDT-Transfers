const express = require('express');
const bodyParser = require('body-parser');
const adminRoutes = require('./admin');
const transfersRoutes = require('./transfers');
const { ProxyNetworkProvider } = require('@multiversx/sdk-network-providers');

// Initialize the Express application
const app = express();

// Constants
const PORT = process.env.PORT || 10000;
const API_PROVIDER_URL = process.env.API_PROVIDER || "https://api.multiversx.com";
const APP_CLIENT_NAME = "MultiversX Transfers API for Make.com Custom Apps";

// Initialize MultiversX Provider
const provider = new ProxyNetworkProvider(API_PROVIDER_URL, { clientName: APP_CLIENT_NAME });

// Middleware to add the provider to request objects
app.use((req, res, next) => {
    req.provider = provider;
    next();
});

// Middleware to parse JSON-encoded request bodies
app.use(bodyParser.json());

// Health Check Endpoint
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

// Debugging: Log route registrations
console.log("Routes registered:");
console.log("Admin Routes:", adminRoutes);
console.log("Transfer Routes:", transfersRoutes);

// Error Handling Middleware (Optional but recommended)
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err.stack);
    res.status(500).json({ error: "An unexpected error occurred." });
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Using MultiversX Provider: ${API_PROVIDER_URL}`);
    console.log(`Client Name for SDK: ${APP_CLIENT_NAME}`);
});
